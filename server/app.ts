import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Run, AppConfig } from '../shared/types.js';
import { RunStore } from './store.js';
import { executeRun } from './harness.js';
import { DEMO_TASK } from './demo.js';
import { loadModelProfiles, getJevConfiguration } from './model-config.js';
import { enforceSameOrigin } from './network.js';
import { readTraceDetail } from './trace.js';
import { ConversationService, ConversationError } from './conversations.js';

const createSchema = z.object({
  mode: z.enum(['demo', 'live']),
  modelId: z.string().max(120).optional(),
  task: z.string().trim().max(12_000).optional(),
  repository: z.string().trim().max(4096).optional(),
  testCommand: z.string().trim().max(1000).optional(),
  setupCommand: z.string().trim().max(1000).optional(),
  maxSteps: z.number().int().min(6).max(60).optional(),
  intent: z.enum(['coding', 'discussion']).optional(),
}).strict();

export async function createApp(options: {
  dataDir: string;
  cwd?: string;
  execute?: typeof executeRun;
}) {
  const app = express();
  app.disable('x-powered-by');
  const store = new RunStore(options.dataDir);
  await store.initialize();
  const conversations = new ConversationService(store, options.dataDir, options.execute ?? executeRun);
  await conversations.initialize();
  const controllers = conversations.controllers;
  const cwd = options.cwd ?? process.cwd();

  app.use(enforceSameOrigin);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/config', (_req, res) => {
    let models: AppConfig['models'] = [];
    let jev = { configured: false, model: 'jev-1.13.0' };
    let configurationError: string | undefined;
    try {
      models = loadModelProfiles();
      jev = getJevConfiguration();
    } catch (error) {
      configurationError = error instanceof Error ? error.message : 'Model configuration could not be loaded.';
    }
    const config: AppConfig = {
      modelConfigured: models.some(model => model.configured),
      jevConfigured: jev.configured,
      model: models.find(model => model.configured)?.model ?? '',
      jevModel: jev.model,
      defaultRepository: cwd,
      demoTask: DEMO_TASK,
      models,
      configurationError,
    };
    res.json(config);
  });

  app.get('/api/runs', (_req, res) => res.json(store.list()));

  const validateLiveInput = (input: z.infer<typeof createSchema>) => {
    if (input.mode !== 'live') return;
    if (!input.task || !input.repository || !input.testCommand || !path.isAbsolute(input.repository)) {
      throw new ConversationError('A task, absolute repository path, and verification command are required.', 400);
    }
    const available = loadModelProfiles().filter(model => model.configured);
    if (!available.length || (input.modelId && input.modelId !== 'auto' && !available.some(model => model.id === input.modelId))) {
      throw new ConversationError('Configure the selected model and API key before starting a live conversation.', 400);
    }
  };
  app.get('/api/conversations', (_req, res) => res.json(conversations.list()));
  app.post('/api/conversations', async (req, res) => {
    const input = createSchema.parse(req.body);
    validateLiveInput(input);
    res.status(201).json(await conversations.create(input));
  });
  app.get('/api/conversations/:conversationId', async (req, res) => {
    res.json(await conversations.detail(String(req.params.conversationId)));
  });
  app.post('/api/conversations/:conversationId/messages', async (req, res) => {
    const input = z.object({ content: z.string().trim().min(1).max(12_000), clientMessageId: z.string().min(8).max(120),
      modelId: z.string().max(120).optional(), maxSteps: z.number().int().min(6).max(60).optional(),
      intent: z.enum(['coding', 'discussion']).optional() }).strict().parse(req.body);
    const conversation = conversations.get(String(req.params.conversationId));
    validateLiveInput({ ...conversation, task: input.content, modelId: input.modelId ?? conversation.modelId });
    res.status(201).json(await conversations.send(conversation.id, input));
  });
  app.get('/api/conversations/:conversationId/events', async (req, res) => {
    const id = String(req.params.conversationId);
    conversations.get(id);
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let cursor = 0;
    let initialized = false;
    const pending: import('../shared/types.js').ConversationEvent[] = [];
    const send = (event: import('../shared/types.js').ConversationEvent) => {
      if (!initialized) { pending.push(event); return; }
      if (event.seq <= cursor || res.destroyed) return;
      cursor = event.seq;
      res.write(`id: ${event.seq}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
    };
    conversations.events.on(id, send);
    req.on('close', () => conversations.events.off(id, send));
    const snapshot = await conversations.detail(id);
    const previous = Number(req.get('Last-Event-ID') ?? req.query.after ?? 0);
    if (Number.isSafeInteger(previous) && previous > 0 && previous <= snapshot.lastSeq) {
      cursor = previous;
      initialized = true;
      for (const event of conversations.replay(id, previous)) send(event);
    } else {
      cursor = snapshot.lastSeq;
      if (!res.destroyed) res.write(`id: ${cursor}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      initialized = true;
    }
    for (const event of pending) send(event);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15_000);
    req.on('close', () => clearInterval(heartbeat));
    if (res.destroyed) clearInterval(heartbeat);
  });

  app.post('/api/runs', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
      return;
    }
    const input = parsed.data;
    if ([...controllers.keys()].some(id => ['queued', 'running'].includes(store.runs.get(id)?.status ?? ''))) {
      res.status(409).json({ error: 'A task is already running. Stop it or wait for it to finish.' });
      return;
    }
    if (input.mode === 'live') {
      if (!input.task || !input.repository || !input.testCommand) {
        res.status(400).json({ error: 'A task, absolute repository path, and verification command are required.' });
        return;
      }
      if (!path.isAbsolute(input.repository)) {
        res.status(400).json({ error: 'Repository must be an absolute path to a local Git repository.' });
        return;
      }
      const available = loadModelProfiles().filter(model => model.configured);
      if (!available.length) {
        res.status(400).json({ error: 'Configure a model and its API key in .env or models.config.json before running a live task.' });
        return;
      }
      if (input.modelId && input.modelId !== 'auto' && !available.some(model => model.id === input.modelId)) {
        res.status(400).json({ error: 'The selected model is unavailable or its API key is not configured.' });
        return;
      }
    }
    const detail = await conversations.create(input);
    res.status(201).json(detail.runs[0]);
  });

  app.param('id', (req, res, next, id: string) => {
    if (!store.runs.has(id)) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }
    next();
  });

  app.get('/api/runs/:id', (req, res) => res.json(store.runs.get(String(req.params.id))));

  app.get('/api/runs/:id/events/:eventId', async (req, res) => {
    const run = store.runs.get(String(req.params.id))!;
    const eventId = String(req.params.eventId);
    if (!run.events.some(event => event.id === eventId)) {
      res.status(404).json({ error: 'Trace event not found.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(await readTraceDetail(options.dataDir, run, eventId));
  });

  app.get('/api/runs/:id/trace', async (req, res, next) => {
    const run = structuredClone(store.runs.get(String(req.params.id))!);
    res.setHeader('Cache-Control', 'no-store');
    res.attachment(`code-geist-${run.id.slice(0, 8)}-trace.ndjson`).type('application/x-ndjson');
    try {
      for (const event of run.events) {
        if (res.destroyed) return;
        const detail = await readTraceDetail(options.dataDir, run, event.id);
        if (res.destroyed) return;
        if (!res.write(`${JSON.stringify(detail)}\n`)) {
          await new Promise<void>(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done);
            res.once('close', done);
            if (res.destroyed) done();
          });
        }
      }
      res.end();
    } catch (error) {
      if (res.headersSent) res.destroy();
      else next(error);
    }
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const id = String(req.params.id);
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (run: Run) => res.write(`event: snapshot\ndata: ${JSON.stringify(run)}\n\n`);
    store.events.on(id, send);
    send(store.runs.get(id)!);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off(id, send);
    });
  });

  app.post('/api/runs/:id/cancel', async (req, res) => {
    res.json(await conversations.cancel(String(req.params.id)));
  });

  app.post('/api/runs/:id/resume', async (req, res) => {
    const input = z.object({ additionalSteps: z.number().int().min(1).max(60), clientRequestId: z.string().min(8).max(120) }).strict().parse(req.body);
    res.json(await conversations.resume(String(req.params.id), input.additionalSteps, input.clientRequestId));
  });

  app.get('/api/runs/:id/patch', (req, res) => {
    const run = store.runs.get(String(req.params.id))!;
    res.type('text/plain').attachment(`code-geist-${run.id.slice(0, 8)}.patch`).send(run.diff);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  const dist = path.resolve(cwd, 'dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text').send('Code Geist API is running. Use npm run dev for the workbench, or npm run build before npm start.'));
  }
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof ConversationError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues.map(issue => issue.message).join('; ') }); return; }
    console.error(error.message);
    res.status(error.status ?? 500).json({ error: error.status === 400 ? 'Invalid JSON request body.' : 'The server could not complete this request. Check the local server log.' });
  });

  await conversations.startPending();
  return { app, store, conversations, close: () => conversations.close() };
}
