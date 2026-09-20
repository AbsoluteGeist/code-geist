import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, ConversationDetail, ConversationEvent, CreateRunInput, Run, RuntimeUpdate, SendMessageInput } from '../shared/types.js';
import { executeRun } from './harness.js';
import { DEMO_TASK } from './demo.js';
import { RunStore } from './store.js';
import { redactTraceValue } from './trace.js';

export class ConversationError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export class ConversationService {
  readonly conversations = new Map<string, Conversation>();
  readonly controllers = new Map<string, AbortController>();
  readonly events = new EventEmitter();
  private readonly views = new Map<string, Run>();
  private readonly logs = new Map<string, ConversationEvent[]>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly saves = new Map<string, Promise<void>>();
  private readonly resumeOnLaunch = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();
  private closing = false;

  constructor(readonly store: RunStore, readonly dataDir: string, private execute: typeof executeRun = executeRun) {
    this.events.setMaxListeners(100);
    store.events.on('saved', (run: Run) => {
      if (run.conversationId && this.conversations.has(run.conversationId)) {
        void this.publish(run.conversationId, 'run.snapshot', { run }, run.id).catch(() => console.error('Conversation event persistence failed.'));
      }
    });
  }

  private filename(id: string, extension = 'json') {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ConversationError('Invalid conversation identifier.', 400);
    return path.join(this.dataDir, 'conversations', `${id}.${extension}`);
  }

  async initialize() {
    const directory = path.join(this.dataDir, 'conversations');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(directory)) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
      try {
        const conversation = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as Conversation;
        if (conversation.id && Array.isArray(conversation.runIds)) this.conversations.set(conversation.id, conversation);
      } catch { console.warn('Skipped an unreadable conversation record.'); }
    }
    // Existing runs become one-turn conversations. Orphan runs also repair a crash between two atomic writes.
    for (const run of this.store.runs.values()) {
      const id = run.conversationId ?? run.id;
      let conversation = this.conversations.get(id);
      if (!conversation) {
        conversation = { id, title: run.title, mode: run.mode, repository: run.repository,
          testCommand: run.testCommand, setupCommand: run.setupCommand, modelId: run.modelId ?? 'auto',
          maxSteps: Math.min(60, run.maxSteps), createdAt: run.createdAt, updatedAt: run.updatedAt,
          runIds: [], status: 'idle' };
        this.conversations.set(id, conversation);
      }
      if (!conversation.runIds.includes(run.id)) conversation.runIds.push(run.id);
      run.conversationId = id;
      run.turnIndex ??= conversation.runIds.indexOf(run.id) + 1;
      if (run.status === 'failed' && run.error?.startsWith('Step budget exhausted')) run.status = 'budget_exhausted';
      run.resumable ??= Boolean(run.workspace && ['failed', 'interrupted', 'budget_exhausted', 'cancelled'].includes(run.status));
      this.views.set(run.id, structuredClone(run));
    }
    for (const conversation of this.conversations.values()) {
      const events: ConversationEvent[] = [];
      try {
        const journal = await readFile(this.filename(conversation.id, 'jsonl'), 'utf8');
        const lines = journal.split('\n');
        let damaged = false;
        for (const line of lines) { if (line) { try { events.push(JSON.parse(line)); } catch { damaged = true; } } }
        if (damaged || (journal.length > 0 && !journal.endsWith('\n'))) await writeFile(this.filename(conversation.id, 'jsonl'), events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), { mode: 0o600 });
      } catch { /* A migrated conversation has no event journal yet. */ }
      this.logs.set(conversation.id, events);
      // Replay public text from a clean base, without resurrecting stale running statuses.
      const savedMessages = new Map(conversation.runIds.map(id => [id, structuredClone(this.views.get(id)?.chatMessages ?? [])]));
      for (const id of conversation.runIds) { const run = this.views.get(id); if (run) run.chatMessages = []; }
      for (const event of events) {
        if (event.type === 'run.snapshot' && event.data.run) {
          const view = this.views.get(event.data.run.id);
          if (view) view.chatMessages = structuredClone(event.data.run.chatMessages ?? []);
        } else if (event.type === 'message.delta') this.apply(event);
      }
      for (const id of conversation.runIds) {
        const view = this.views.get(id);
        if (!view) continue;
        for (const message of savedMessages.get(id) ?? []) {
          const index = view.chatMessages!.findIndex(item => item.id === message.id);
          if (index < 0) view.chatMessages!.push(message);
          else if (message.finished) view.chatMessages![index] = message;
        }
        const stored = this.store.runs.get(id);
        if (stored) stored.chatMessages = structuredClone(view.chatMessages);
      }
      conversation.runIds = conversation.runIds.filter(id => this.store.runs.has(id));
      const last = conversation.runIds.map(id => this.store.runs.get(id)).filter(Boolean).at(-1);
      delete conversation.activeRunId;
      conversation.status = last && last.status !== 'completed' ? 'needs_attention' : 'idle';
      await this.persistConversation(conversation);
      // Restart recovery can change run status without a live RunStore subscriber.
      // Journal that transition so clients reconnecting with Last-Event-ID also see it.
      for (const id of conversation.runIds) {
        const run = this.views.get(id)!;
        const prior = [...events].reverse().find(event => event.type === 'run.snapshot' && event.runId === id)?.data.run;
        if (!prior || prior.status !== run.status || prior.updatedAt !== run.updatedAt || prior.resumable !== run.resumable) {
          await this.publish(conversation.id, 'run.snapshot', { run }, id);
        }
      }
      await this.publish(conversation.id, 'conversation.updated', { conversation });
    }
  }

  private persistConversation(conversation: Conversation): Promise<void> {
    const filename = this.filename(conversation.id);
    const contents = JSON.stringify(conversation);
    const next = (this.saves.get(conversation.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(`${filename}.tmp`, contents, { mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
    });
    this.saves.set(conversation.id, next);
    return next;
  }

  private apply(event: ConversationEvent) {
    if (event.type === 'run.snapshot' && event.data.run) this.views.set(event.data.run.id, structuredClone(event.data.run));
    const run = event.runId ? this.views.get(event.runId) : undefined;
    if (!run || !event.data.callId) return;
    if (event.type === 'message.delta') {
      run.chatMessages ??= [];
      let message = run.chatMessages.find(message => message.id === event.data.callId);
      if (!message) { message = { id: event.data.callId, content: '', createdAt: event.at, finished: false }; run.chatMessages.push(message); }
      message.content = event.data.replace ? event.data.delta ?? '' : message.content + (event.data.delta ?? '');
    } else if (event.type === 'tool.output.delta') {
      const call = run.events.find(call => call.id === event.data.callId);
      if (call) {
        const before = String(call.data?.liveOutput ?? '');
        const output = event.data.replace ? event.data.delta ?? '' : before + (event.data.delta ?? '');
        call.data = { ...call.data, liveOutput: output.slice(-20_000), liveOutputTruncated: output.length > 20_000 };
      }
    } else if (event.type === 'usage.updated') {
      const call = run.events.find(call => call.id === event.data.callId);
      if (call?.trace) {
        if (event.data.usage) call.trace.usage = event.data.usage;
        if (event.data.firstTokenAt) call.trace.firstTokenAt = event.data.firstTokenAt;
        if (event.data.ttftMs !== undefined) call.trace.ttftMs = event.data.ttftMs;
      }
    }
  }

  publish(id: string, type: ConversationEvent['type'], data: ConversationEvent['data'], runId?: string): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    // Capture now: callers continue mutating their run objects after publish returns.
    const safeData = structuredClone(redactTraceValue(data));
    const next = previous.catch(() => {}).then(async () => {
      const log = this.logs.get(id) ?? [];
      const event: ConversationEvent = { seq: (log.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString(), conversationId: id, runId, type, data: safeData };
      await appendFile(this.filename(id, 'jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
      log.push(event);
      this.logs.set(id, log);
      this.apply(event);
      this.events.emit(id, event);
    });
    this.writes.set(id, next);
    return next;
  }

  async detail(id: string): Promise<ConversationDetail> {
    const conversation = this.get(id);
    await this.writes.get(id);
    return { conversation: structuredClone(conversation), runs: conversation.runIds.map(id => this.views.get(id) ?? this.store.runs.get(id)).filter((run): run is Run => Boolean(run)).map(run => structuredClone(run)), lastSeq: this.logs.get(id)?.at(-1)?.seq ?? 0 };
  }

  get(id: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new ConversationError('Conversation not found.', 404);
    return conversation;
  }

  list() { return [...this.conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  replay(id: string, after: number) { return (this.logs.get(id) ?? []).filter(event => event.seq > after); }

  async startPending() {
    for (const conversation of this.conversations.values()) {
      const prior = conversation.runIds.map(id => this.store.runs.get(id)).filter(run => run && run.status !== 'queued' && (run.workspace || run.step || run.events.length)).at(-1);
      if (!prior || prior.status === 'completed') await this.schedule(conversation.id);
    }
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.mutations.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    this.mutations.set(id, next);
    return next;
  }

  private newRun(conversation: Conversation, content: string, input: Partial<SendMessageInput> = {}): Run {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), conversationId: conversation.id, turnIndex: conversation.runIds.length + 1,
      clientMessageId: input.clientMessageId, intent: input.intent ?? 'coding', attempt: 1,
      title: content.split('\n')[0].slice(0, 100), task: content,
      mode: conversation.mode, modelId: input.modelId ?? conversation.modelId ?? 'auto',
      status: 'queued', phase: 'prepare', createdAt: now, updatedAt: now,
      repository: conversation.repository, testCommand: conversation.testCommand,
      setupCommand: conversation.setupCommand, maxSteps: input.maxSteps ?? conversation.maxSteps,
      step: 0, events: [], chatMessages: [], files: [], diff: '',
      metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    };
  }

  async create(input: CreateRunInput): Promise<ConversationDetail> {
    const now = new Date().toISOString();
    const task = input.mode === 'demo' ? DEMO_TASK : input.task!;
    const title = input.mode === 'demo' ? 'Fix Unicode and separator handling in slugify' : task.split('\n')[0].slice(0, 100);
    const conversation: Conversation = { id: randomUUID(), title, mode: input.mode,
      repository: input.mode === 'demo' ? 'Built-in demo repository' : input.repository!,
      testCommand: input.mode === 'demo' ? 'node --test' : input.testCommand!, setupCommand: input.setupCommand,
      modelId: input.modelId ?? 'auto', maxSteps: input.maxSteps ?? 24,
      createdAt: now, updatedAt: now, runIds: [], status: 'idle' };
    this.conversations.set(conversation.id, conversation);
    const run = this.newRun(conversation, task, { intent: input.intent });
    run.title = title;
    conversation.runIds.push(run.id);
    await this.persistConversation(conversation);
    await this.store.save(run);
    await this.schedule(conversation.id);
    return this.detail(conversation.id);
  }

  async send(id: string, input: SendMessageInput): Promise<Run> {
    return this.serial(id, async () => {
      const conversation = this.get(id);
      const existing = conversation.runIds.map(id => this.store.runs.get(id)).find(run => run?.clientMessageId === input.clientMessageId);
      if (existing) return existing;
      const run = this.newRun(conversation, input.content, input);
      conversation.runIds.push(run.id);
      conversation.updatedAt = run.createdAt;
      await this.persistConversation(conversation);
      await this.store.save(run);
      await this.publish(id, 'conversation.updated', { conversation });
      await this.schedule(id);
      return run;
    });
  }

  async resume(runId: string, additionalSteps: number, requestId: string): Promise<Run> {
    const run = this.store.runs.get(runId);
    if (!run?.conversationId) throw new ConversationError('Run not found.', 404);
    return this.serial(run.conversationId, async () => {
      if (run.resumeRequestIds?.includes(requestId)) return run;
      const conversation = this.get(run.conversationId!);
      if (conversation.activeRunId || this.controllers.has(runId)) throw new ConversationError('A turn in this conversation is already running.');
      if (!run.workspace || !['budget_exhausted', 'interrupted', 'cancelled', 'failed'].includes(run.status)) throw new ConversationError('This turn has no interrupted workspace to continue.');
      const newer = conversation.runIds.slice(conversation.runIds.indexOf(runId) + 1).some(id => {
        const later = this.store.runs.get(id);
        return later && later.status !== 'queued' && Boolean(later.workspace || later.step || later.events.length);
      });
      if (newer) throw new ConversationError('A later turn already used this workspace. Send a follow-up in the conversation instead.');
      run.maxSteps += additionalSteps;
      run.attempt = (run.attempt ?? 1) + 1;
      run.resumeRequestIds = [...run.resumeRequestIds ?? [], requestId];
      run.status = 'queued';
      delete run.error;
      this.resumeOnLaunch.add(runId);
      await this.store.save(run);
      await this.launch(conversation, run, true);
      return run;
    });
  }

  async schedule(id: string) {
    const conversation = this.get(id);
    if (this.closing || conversation.activeRunId) return;
    const next = conversation.runIds.map(id => this.store.runs.get(id)).find(run => run?.status === 'queued');
    if (next) await this.launch(conversation, next, this.resumeOnLaunch.has(next.id));
  }

  private async launch(conversation: Conversation, run: Run, resume: boolean) {
    if (conversation.activeRunId || this.closing) return;
    const index = conversation.runIds.indexOf(run.id);
    const previous = conversation.runIds.slice(0, index).map(id => this.store.runs.get(id)).filter(run => run && run.status !== 'queued' && run.workspace).at(-1);
    if (!resume && previous?.workspace) {
      run.workspace = previous.workspace; run.branch = previous.branch; run.baseCommit = previous.baseCommit; run.revision = previous.revision;
    }
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.resumeOnLaunch.delete(run.id);
    conversation.activeRunId = run.id;
    conversation.status = 'running';
    await this.persistConversation(conversation);
    await this.publish(conversation.id, 'conversation.updated', { conversation });
    const job = this.execute(run, {
      dataDir: this.dataDir, signal: controller.signal, previousRunId: resume ? undefined : previous?.id, resume,
      onUpdate: () => this.store.save(run),
      onEvent: (event: RuntimeUpdate) => this.publish(conversation.id, event.type, event, run.id),
    }).catch(async (error: unknown) => {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      run.error = error instanceof Error ? error.message : 'Execution failed.';
      run.resumable = Boolean(run.workspace);
      await this.store.save(run);
    }).finally(async () => {
      this.controllers.delete(run.id);
      delete conversation.activeRunId;
      conversation.updatedAt = new Date().toISOString();
      conversation.status = run.status === 'completed' ? 'idle' : 'needs_attention';
      await this.persistConversation(conversation);
      await this.publish(conversation.id, 'conversation.updated', { conversation });
      if (run.status === 'completed') await this.schedule(conversation.id);
    }).catch(() => console.error('Could not persist the conversation state.'));
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }

  async cancel(runId: string): Promise<Run> {
    const run = this.store.runs.get(runId);
    if (!run) throw new ConversationError('Run not found.', 404);
    if (run.status === 'queued' || run.status === 'running') {
      this.controllers.get(runId)?.abort();
      run.status = 'cancelled';
      run.resumable = Boolean(run.workspace);
      await this.store.save(run);
    }
    return run;
  }

  async close() {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.jobs]);
    await Promise.allSettled([...this.writes.values(), ...this.saves.values()]);
  }
}
