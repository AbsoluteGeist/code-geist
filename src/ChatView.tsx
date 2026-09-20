import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Code2, Copy, GitBranch, LoaderCircle, MessageSquare, Pause, Play, Settings2, Square, Terminal, Workflow, X } from 'lucide-react';
import type { AppConfig, ConversationDetail, Run, RunEvent, SendMessageInput } from '../shared/types';
import { aggregateUsage } from '../shared/metrics';
import { clientRequestId } from './conversation-client';
import { copyText } from './clipboard';
import './chat.css';

export interface ChatViewProps {
  detail: ConversationDetail;
  config: AppConfig;
  onSend: (input: SendMessageInput) => Promise<Run>;
  onResume: (runId: string, requestId: string) => Promise<Run>;
  onCancel: (runId: string) => Promise<Run>;
  onInspect: (runId: string, eventId?: string) => void;
}

export const runIsActive = (run: Run) => run.status === 'running' || run.status === 'queued';
export const runCanResume = (run: Run) => run.resumable ?? (run.status === 'budget_exhausted' || run.status === 'interrupted');
const shortTime = (at: string) => new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const duration = (ms: number | null) => ms === null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;
const count = (value: number | null) => value === null ? '—' : value.toLocaleString();

function readDraft(id: string) {
  try { return sessionStorage.getItem(`code-geist-draft-${id}`) ?? ''; } catch { return ''; }
}

function readPending(id: string): SendMessageInput | null {
  try {
    const saved = sessionStorage.getItem(`code-geist-pending-${id}`);
    if (!saved) return null;
    const value = JSON.parse(saved) as SendMessageInput;
    return typeof value.content === 'string' && typeof value.clientMessageId === 'string' ? value : null;
  } catch { return null; }
}

export default function ChatView({ detail, config, onSend, onResume, onCancel, onInspect }: ChatViewProps) {
  const conversation = detail.conversation;
  const [draft, setDraft] = useState(() => readDraft(conversation.id));
  const [modelId, setModelId] = useState(conversation.modelId ?? 'auto');
  const [intent, setIntent] = useState<'coding' | 'discussion'>('coding');
  const [maxSteps, setMaxSteps] = useState(conversation.maxSteps);
  const [options, setOptions] = useState(false);
  const [pending, setPending] = useState<SendMessageInput | null>(() => readPending(conversation.id));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(pending ? 'A previous send was not confirmed. Retry safely with the same message ID.' : '');
  const [operation, setOperation] = useState('');
  const [operationError, setOperationError] = useState('');
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingRef = useRef<SendMessageInput | null>(pending);
  const runsRef = useRef(detail.runs);
  runsRef.current = detail.runs;
  const resumeIds = useRef(new Map<string, string>());
  const active = detail.runs.find(run => run.id === conversation.activeRunId && runIsActive(run)) ?? detail.runs.find(run => run.status === 'running');
  const queued = detail.runs.filter(run => run.status === 'queued' && run.id !== conversation.activeRunId);
  const pendingAcknowledged = Boolean(pending && detail.runs.some(run => run.clientMessageId === pending.clientMessageId));
  const configured = conversation.mode === 'demo' || (modelId === 'auto' ? config.modelConfigured : Boolean(config.models.find(model => model.id === modelId)?.configured));
  const contentSignature = detail.runs.map(run => `${run.id}:${run.status}:${run.events.length}:${run.chatMessages?.map(message => message.content.length).join(',')}`).join('|');

  useEffect(() => {
    try { sessionStorage.setItem(`code-geist-draft-${conversation.id}`, draft); } catch { /* Keep the in-memory draft. */ }
  }, [conversation.id, draft]);
  useEffect(() => {
    try {
      const key = `code-geist-pending-${conversation.id}`;
      if (pending) sessionStorage.setItem(key, JSON.stringify(pending)); else sessionStorage.removeItem(key);
    } catch { /* Retry still retains the request ID in memory. */ }
  }, [conversation.id, pending]);
  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [contentSignature, follow, pending]);
  useEffect(() => {
    if (!pendingAcknowledged || !pending) return;
    setDraft(current => current.trim() === pending.content ? '' : current);
    setPending(null); pendingRef.current = null; setSendError('');
  }, [pendingAcknowledged, pending]);

  async function send(retry = false) {
    if (sending || (!retry && (!draft.trim() || !configured))) return;
    if (!retry && (!Number.isInteger(maxSteps) || maxSteps < 6 || maxSteps > 60)) { setSendError('Choose a round budget between 6 and 60.'); return; }
    const candidate = { content: draft.trim(), modelId, maxSteps, intent };
    const previous = pendingRef.current;
    if (retry && !previous) return;
    const same = previous && previous.content === candidate.content && previous.modelId === modelId && previous.maxSteps === maxSteps && previous.intent === intent;
    const input: SendMessageInput = retry && previous ? previous : same ? previous : { ...candidate, clientMessageId: clientRequestId() };
    pendingRef.current = input; setPending(input); setSending(true); setSendError(''); setFollow(true);
    try {
      await onSend(input);
      setDraft(current => current.trim() === input.content ? '' : current);
      setPending(null); pendingRef.current = null;
      inputRef.current?.focus();
    } catch (error) {
      if (!runsRef.current.some(run => run.clientMessageId === input.clientMessageId)) {
        setSendError(error instanceof Error ? error.message : 'Could not send the message.');
      }
    } finally { setSending(false); }
  }

  async function resume(run: Run) {
    if (operation || active) return;
    const index = runsRef.current.findIndex(item => item.id === run.id);
    if (runsRef.current.slice(index + 1).some(item => item.status !== 'queued' && Boolean(item.workspace || item.step || item.events.length))) return;
    const resumeKey = `${run.id}:${run.attempt ?? 1}:${run.maxSteps}`;
    let id = resumeIds.current.get(resumeKey);
    if (!id) { id = clientRequestId(); resumeIds.current.set(resumeKey, id); }
    setOperation(run.id); setOperationError(''); setFollow(true);
    try { await onResume(run.id, id); resumeIds.current.delete(resumeKey); }
    catch (error) { setOperationError(error instanceof Error ? error.message : 'Could not continue this turn.'); }
    finally { setOperation(''); }
  }

  async function cancelTurn(runId: string) {
    if (operation) return;
    setOperation(runId); setOperationError('');
    try { await onCancel(runId); }
    catch (error) { setOperationError(error instanceof Error ? error.message : 'Could not cancel this message.'); }
    finally { setOperation(''); }
  }

  async function stop() {
    if (active) await cancelTurn(active.id);
  }

  return <div className="chat-view">
    <div className="chat-messages" ref={listRef} onScroll={() => {
      const list = listRef.current;
      if (list) setFollow(list.scrollHeight - list.scrollTop - list.clientHeight < 80);
    }}>
      <div className="chat-transcript">
        {conversation.mode === 'demo' && <div className="chat-demo-note"><Workflow size={13} />Scripted demo · file changes and tests execute locally.</div>}
        {detail.runs.map((run, index) => <ChatTurn key={run.id} run={run} index={index} queued={run.status === 'queued' && run.id !== conversation.activeRunId} laterTurnExecuted={detail.runs.slice(index + 1).some(item => item.status !== 'queued' && Boolean(item.workspace || item.step || item.events.length))} onInspect={eventId => onInspect(run.id, eventId)} onResume={() => void resume(run)} resumeDisabled={Boolean(active || operation)} resuming={operation === run.id} onCancel={() => void cancelTurn(run.id)} cancelDisabled={Boolean(operation)} />)}
        {pending && !pendingAcknowledged && <div className="chat-pending"><div className="chat-user-message"><span className="chat-speaker">You</span><MessageContent content={pending.content} /><span className={`chat-delivery ${sendError ? 'has-error' : ''}`}>{sendError ? <CircleAlert size={12} /> : <LoaderCircle size={12} className="spin" />}{sendError ? 'Send not confirmed' : active ? 'Adding to queue…' : 'Sending…'}</span></div></div>}
        {operationError && <div className="chat-inline-error" role="alert"><CircleAlert size={15} /><span>{operationError}</span></div>}
      </div>
    </div>
    {!follow && <button className="chat-jump" onClick={() => { setFollow(true); listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'auto' }); }}><ArrowDown size={13} />Latest message</button>}
    <div className="chat-compose-area">
      {queued.length > 0 && <div className="chat-queue-note"><span className="tiny-dot amber" />{queued.length} {queued.length === 1 ? 'message' : 'messages'} queued{active ? ' · starts after this turn' : ''}</div>}
      {sendError && <div className="chat-send-error" role="alert"><CircleAlert size={14} /><span>{sendError}</span>{pending && <button className="text-button" onClick={() => void send(true)} disabled={sending}>Retry same message</button>}</div>}
      <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor={`chat-message-${conversation.id}`}>Message Code Geist</label>
        <textarea id={`chat-message-${conversation.id}`} ref={inputRef} value={draft} onChange={event => setDraft(event.target.value)} placeholder={active ? 'Add a follow-up. It will run after this turn…' : intent === 'discussion' ? 'Ask about the code or discuss the next step…' : 'Describe the next change…'} rows={2} maxLength={12000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="chat-composer-controls"><div className="chat-intent" role="group" aria-label="Message intent"><button type="button" className={intent === 'coding' ? 'active' : ''} aria-pressed={intent === 'coding'} onClick={() => setIntent('coding')} title="Make and verify code changes"><Code2 size={13} />Code</button><button type="button" className={intent === 'discussion' ? 'active' : ''} aria-pressed={intent === 'discussion'} onClick={() => setIntent('discussion')} title="Discuss the repository without editing files"><MessageSquare size={12} />Ask</button></div><div className="chat-model"><Workflow size={13} /><label className="sr-only" htmlFor="chat-model">Model for next message</label><select id="chat-model" value={modelId} onChange={event => setModelId(event.target.value)} disabled={conversation.mode === 'demo'}>{conversation.mode === 'demo' ? <option value={modelId}>Scripted demo</option> : <><option value="auto">Auto · Jev</option>{config.models.map(model => <option key={model.id} value={model.id} disabled={!model.configured}>{model.name}{model.configured ? '' : ' · key needed'}</option>)}</>}</select><ChevronDown size={11} /></div><button type="button" className={`chat-options ${options ? 'active' : ''}`} onClick={() => setOptions(!options)} aria-label="Round budget options" aria-expanded={options}><Settings2 size={14} /></button><span className="chat-keyboard-hint">↵ send</span>{active && <button type="button" className="chat-stop" onClick={() => void stop()} disabled={Boolean(operation)} aria-label="Stop current turn" title="Stop current turn">{operation ? <LoaderCircle size={13} className="spin" /> : <Square size={12} fill="currentColor" />}</button>}<button type="submit" className="chat-send" disabled={!draft.trim() || !configured || sending} aria-label={active ? 'Queue message' : 'Send message'} title={active ? 'Queue message' : 'Send message'}>{sending ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={17} />}</button></div>
        {options && <div className="chat-budget-options"><label htmlFor="chat-max-steps">Rounds for next turn</label><input id="chat-max-steps" type="number" min={6} max={60} value={maxSteps} onChange={event => setMaxSteps(Number(event.target.value))} /><span>Pause at the limit; continue the same turn when needed.</span></div>}
      </form>
      {!configured && <p className="chat-provider-notice">Configure an API key for this model in Providers & models.</p>}
      <ChatUsage runs={detail.runs} active={active} />
    </div>
  </div>;
}

function ChatTurn({ run, index, queued, laterTurnExecuted, onInspect, onResume, resumeDisabled, resuming, onCancel, cancelDisabled }: { run: Run; index: number; queued: boolean; laterTurnExecuted: boolean; onInspect: (eventId?: string) => void; onResume: () => void; resumeDisabled: boolean; resuming: boolean; onCancel: () => void; cancelDisabled: boolean }) {
  const timeline = useMemo(() => [
    ...(run.chatMessages ?? []).filter(message => message.content).map(message => ({ kind: 'message' as const, at: message.createdAt, message })),
    ...run.events.filter(event => event.trace ? ['tool', 'setup', 'jev'].includes(event.trace.kind) : event.type === 'tool' || event.type === 'jev')
      .map(event => ({ kind: 'tool' as const, at: event.trace?.startedAt ?? event.at, event })),
  ].sort((a, b) => a.at.localeCompare(b.at)), [run.chatMessages, run.events]);
  const currentVerification = run.verification && run.verification.revision === (run.revision ?? run.verification.revision);
  const finalShown = (run.chatMessages ?? []).some(message => message.content.trim() === run.summary?.trim());
  const paused = run.status === 'budget_exhausted' || run.status === 'interrupted';
  const canContinue = runCanResume(run) && !laterTurnExecuted;
  const streamingMessage = run.chatMessages?.some(message => !message.finished && message.content);

  return <section className={`chat-turn turn-${run.status}`} aria-label={`Turn ${run.turnIndex ?? index + 1}`}>
    <div className="chat-turn-separator"><span />Turn {run.turnIndex ?? index + 1}{run.attempt && run.attempt > 1 ? <span className="chat-attempt">· attempt {run.attempt}</span> : null}<span /></div>
    <div className="chat-user-message"><div className="chat-message-heading"><span className="chat-speaker">You</span><time dateTime={run.createdAt}>{shortTime(run.createdAt)}</time>{run.intent === 'discussion' && <span className="chat-intent-badge">Ask</span>}{run.status === 'queued' && <span className="chat-queued-badge">{queued ? 'Queued' : 'Starting'}</span>}</div><MessageContent content={run.task} />{queued && <button className="chat-cancel-queued" onClick={onCancel} disabled={cancelDisabled}>{resuming ? <LoaderCircle size={11} className="spin" /> : <X size={11} />}Cancel queued message</button>}</div>
    {timeline.map(item => item.kind === 'message' ? <div className="chat-assistant-message" key={`message-${item.message.id}`}><div className="chat-message-heading"><span className="chat-agent-icon"><Code2 size={15} /></span><span className="chat-speaker">Code Geist</span>{run.modelName && <span className="chat-message-model">{run.modelName}</span>}<ChatCopy text={item.message.content} /></div><MessageContent content={item.message.content} />{!item.message.finished && run.status === 'running' && <span className="chat-stream-cursor" aria-label="Generating" />}</div> : <ChatTool key={`tool-${item.event.id}`} event={item.event} run={run} onInspect={() => onInspect(item.event.id)} />)}
    {run.summary && !finalShown && <div className="chat-assistant-message chat-final-message"><div className="chat-message-heading"><span className="chat-agent-icon"><Code2 size={15} /></span><span className="chat-speaker">Code Geist</span><span className="chat-message-model">{run.status === 'completed' ? 'Turn complete' : 'Progress summary'}</span><ChatCopy text={run.summary} /></div><MessageContent content={run.summary} /></div>}
    {run.status === 'running' && !streamingMessage && <div className="chat-working" role="status"><LoaderCircle size={13} className="spin" /><span>{run.phase === 'verify' ? 'Running verification' : run.phase === 'prepare' ? 'Preparing the workspace' : 'Agent is working'}</span><button onClick={() => onInspect()}>View activity<ArrowRight size={11} /></button></div>}
    {paused && <div className="chat-pause-card"><Pause size={17} /><div><strong>{run.status === 'budget_exhausted' ? 'Round limit reached' : 'This turn was interrupted'}</strong><p>{run.step} of {run.maxSteps} rounds used. {laterTurnExecuted ? 'A later turn already used this workspace. Send a follow-up to continue.' : canContinue ? 'Continue with the same workspace and conversation context.' : 'Send a follow-up to continue from the current workspace.'}</p></div>{canContinue && <button className="secondary-button" onClick={onResume} disabled={resumeDisabled}>{resuming ? <LoaderCircle size={13} className="spin" /> : <Play size={12} />}Continue +12</button>}</div>}
    {run.error && !paused && run.status !== 'cancelled' && <div className="chat-inline-error"><CircleAlert size={15} /><span>{run.error}</span></div>}
    {run.status === 'cancelled' && <div className="chat-stopped"><Square size={10} />Turn stopped. Send another message when ready.</div>}
    {run.workspace && (run.status === 'completed' || paused) && <div className="chat-turn-result"><span><GitBranch size={12} />{run.branch || 'Workspace saved'}</span><span>{run.files.length} {run.files.length === 1 ? 'file' : 'files'} changed</span>{run.verification && <span className={!currentVerification ? '' : run.verification.passed ? 'passed' : 'failed'}>{currentVerification && run.verification.passed ? <Check size={12} /> : <CircleAlert size={12} />}{!currentVerification ? 'Verification needs re-run' : run.verification.passed ? 'Verification passed' : 'Verification failed'}</span>}</div>}
  </section>;
}

function ChatTool({ event, run, onInspect }: { event: RunEvent; run: Run; onInspect: () => void }) {
  const running = event.status === 'running' && run.status === 'running' && Boolean(event.trace);
  const output = typeof event.data?.liveOutput === 'string' ? event.data.liveOutput : typeof event.data?.responsePreview === 'string' ? event.data.responsePreview : typeof event.data?.result === 'string' ? event.data.result : event.message;
  const isJev = event.trace?.kind === 'jev' || event.type === 'jev';
  return <details className={`chat-tool ${event.status === 'error' ? 'tool-error' : ''}`}><summary>{running ? <LoaderCircle size={13} className="spin" /> : isJev ? <Workflow size={13} /> : <Terminal size={13} />}<span className="chat-tool-title">{event.title}</span>{event.trace?.source === 'fallback' && <span className="chat-tool-source">fallback</span>}{event.trace?.source === 'demo' && <span className="chat-tool-source">demo</span>}<span className="chat-tool-duration">{event.trace?.durationMs !== undefined ? duration(event.trace.durationMs) : running ? 'running' : ''}</span><ChevronRight size={12} /></summary><div className="chat-tool-body">{event.data?.args !== undefined && <pre>{JSON.stringify(event.data.args, null, 2)}</pre>}{output && <pre>{output.slice(-8000)}</pre>}{Boolean(output) && <span className="chat-output-note">Preview only · open Activity for recorded request and response.</span>}<button onClick={onInspect}>Inspect transaction<ArrowRight size={12} /></button></div></details>;
}

function ChatUsage({ runs, active }: { runs: Run[]; active?: Run }) {
  const [scope, setScope] = useState<'conversation' | 'turn'>('conversation');
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active?.id]);
  const latest = active ?? runs.filter(run => run.status !== 'queued').at(-1) ?? runs.at(-1);
  const selected = scope === 'conversation' ? runs : latest ? [latest] : [];
  const usage = aggregateUsage(selected, now);
  const jevUsageKnown = selected.some(run => run.events.some(event => event.trace?.kind === 'jev' && event.trace.usage && event.trace.usage.reported !== false));
  return <div className="chat-usage"><div className="chat-usage-main"><label className="sr-only" htmlFor="chat-usage-scope">Usage scope</label><select id="chat-usage-scope" value={scope} onChange={event => setScope(event.target.value as 'conversation' | 'turn')}><option value="conversation">Conversation</option><option value="turn">This turn</option></select><span title="Turns started / model rounds used"><span>Turns / steps</span><b>{usage.turns} / {usage.steps}</b></span><span title="Generative model request time"><span>LLM</span><b>{usage.modelCalls ? duration(usage.modelMs) : '—'}</b></span><span title="Tool time excludes nested Jev calls"><span>Tools</span><b>{usage.toolCalls ? duration(usage.toolMs) : '—'}</b></span><span title="Mean recorded time to first token"><span>TTFT</span><b>{duration(usage.ttftMs)}</b></span><span title="Output tokens per second from completed, reported calls"><span>tok/s</span><b>{usage.tokensPerSecond === null ? '—' : usage.tokensPerSecond.toFixed(1)}</b></span><span title="Cached input share for calls that report cache usage"><span>Cache</span><b>{usage.cacheHitRate === null ? '—' : `${(usage.cacheHitRate * 100).toFixed(0)}%`}</b></span><span title="Confirmed provider-reported input / output tokens"><span>In / out</span><b>{count(usage.inputTokens)} / {count(usage.outputTokens)}</b></span><button className="chat-usage-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} title="Usage details"><ChevronDown size={13} /></button></div>{expanded && <div className="chat-usage-detail"><span><strong>Jev</strong> {usage.jevCalls} calls · {usage.jevCalls ? duration(usage.jevMs) : '—'} · {jevUsageKnown ? `${usage.byKind.jev.inputTokens.toLocaleString()} in / ${usage.byKind.jev.outputTokens.toLocaleString()} out` : 'tokens not reported'}</span><span>{usage.reportedCalls} calls reported usage{usage.unreportedCalls ? `; ${usage.unreportedCalls} did not` : ''}. Cache data: {usage.cacheCoverage} calls.</span><span>Missing provider metrics appear as —. Tokens are not estimated.</span></div>}{active && <div className="chat-generating"><span className="tiny-dot green pulse" />{usage.activeCalls ? 'Generating' : 'Working'}{usage.inputTokens !== null && usage.activeCalls > 0 ? ' · showing confirmed usage' : ''}</div>}</div>;
}

function ChatCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <button className="chat-copy" title={failed ? 'Copy unavailable' : copied ? 'Copied' : 'Copy response'} aria-label={failed ? 'Copy failed' : copied ? 'Copied' : 'Copy response'} onClick={() => { void copyText(text).then(() => { setCopied(true); setFailed(false); }).catch(() => setFailed(true)); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { setCopied(false); setFailed(false); }, 2000); }}>{copied ? <Check size={12} /> : failed ? <CircleAlert size={12} /> : <Copy size={12} />}</button>;
}

function InlineText({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : <Fragment key={index}>{part}</Fragment>)}</>;
}

function MessageContent({ content }: { content: string }) {
  const segments = content.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  return <div className="chat-message-content">{segments.map((segment, index) => {
    if (!segment) return null;
    if (segment.startsWith('```')) {
      const newline = segment.indexOf('\n');
      const language = segment.slice(3, newline).trim();
      const code = segment.slice(newline + 1).replace(/```$/, '');
      return <div className="chat-code-block" key={index}><div><span>{language || 'code'}</span><ChatCopy text={code} /></div><pre><code>{code}</code></pre></div>;
    }
    return <div className="chat-prose" key={index}>{segment.split(/\n\n+/).map((block, blockIndex) => /^#{1,3} /.test(block) ? <h4 key={blockIndex}><InlineText text={block.replace(/^#{1,3} /, '')} /></h4> : <p key={blockIndex}><InlineText text={block} /></p>)}</div>;
  })}</div>;
}
