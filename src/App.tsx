import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Braces, Check, CheckCheck,
  ChevronDown, ChevronRight, CircleCheck, CircleDashed,
  CircleX, Code2, Copy, FileCode2, FolderGit2, GitCompareArrows,
  LayoutList, LoaderCircle, Menu, Moon, Play, Plus, Settings2, ShieldCheck,
  Square, Sun, Terminal, Workflow, X, MessageSquare, CircleAlert,
} from 'lucide-react';
import type { AppConfig, Conversation, ConversationDetail, ConversationEvent, CreateRunInput, Run, SendMessageInput } from '../shared/types';
import { copyText } from './clipboard';
import ActivityTrace from './ActivityTrace';
import ChatView, { runIsActive } from './ChatView';
import { applyConversationEvent, mergeConversationRun, reconcileConversationSnapshot } from './conversation-client';
import './conversation-layout.css';

type Tab = 'chat' | 'activity' | 'changes' | 'verification';
const compactPath = (value: string) => value.replace(/\/$/, '').split('/').filter(Boolean).at(-1) || value;
const time = (value: string) => new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json(); message = body.error || body.message || message; } catch { /* HTTP status is sufficient. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function Logo() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 28 28" fill="none"><path d="m11 6-8 8 8 8M17 6l8 8-8 8M16 3l-4 22" stroke="currentColor" strokeWidth="2.3" strokeLinecap="square" /></svg></span>;
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await copyText(value); setCopied(true); setFailed(false); }
    catch { setFailed(true); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setCopied(false); setFailed(false); }, 2000);
  }
  return <button type="button" className={`icon-button copy-button ${copied ? 'copied' : ''}`} onClick={copy} aria-label={copied ? 'Copied' : failed ? 'Copy failed' : label} title={copied ? 'Copied' : failed ? 'Copy unavailable in this browser' : label}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}

export default function App() {
  const initialUrl = new URLSearchParams(location.search);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const detailRef = useRef<ConversationDetail | null>(null);
  const [selectedId, setSelectedId] = useState(() => initialUrl.get('conversation') || initialUrl.get('run'));
  const selectionRef = useRef(selectedId);
  const [initialRunId, setInitialRunId] = useState<string | null>(() => initialUrl.get('run'));
  const [error, setError] = useState('');
  const [bootError, setBootError] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [connection, setConnection] = useState<'connected' | 'connecting' | 'reconnecting'>('connecting');
  const [settings, setSettings] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');
  selectionRef.current = selectedId;

  const commitDetail = useCallback((next: ConversationDetail) => {
    const previous = detailRef.current;
    if (previous?.conversation.id === next.conversation.id && previous.lastSeq > next.lastSeq) return;
    detailRef.current = next; setDetail(next);
    setHistory(items => {
      const existing = items.find(item => item.id === next.conversation.id);
      if (existing?.updatedAt === next.conversation.updatedAt && existing.status === next.conversation.status && existing.runIds.length === next.conversation.runIds.length) return items;
      return [next.conversation, ...items.filter(item => item.id !== next.conversation.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);
  const mergeRun = useCallback((run: Run) => {
    const current = detailRef.current;
    if (current && (!run.conversationId || run.conversationId === current.conversation.id)) commitDetail(mergeConversationRun(current, run));
  }, [commitDetail]);

  const boot = useCallback(async () => {
    setLoading(true); setBootError('');
    try {
      const [nextConfig, conversations] = await Promise.all([request<AppConfig>('/api/config'), request<Conversation[]>('/api/conversations')]);
      setConfig(nextConfig); setHistory(conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } catch (reason) { setBootError(reason instanceof Error ? reason.message : 'Cannot connect to the local runtime.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void boot(); }, [boot]);

  useEffect(() => {
    if (!selectedId) { detailRef.current = null; setDetail(null); setDetailLoading(false); return; }
    let disposed = false;
    let stream: EventSource | undefined;
    let refreshing = false;
    let buffered: ConversationEvent[] = [];
    const controller = new AbortController();
    setDetailLoading(true); setError(''); setConnection('connecting');
    async function connect() {
      let id = selectedId!;
      const params = new URLSearchParams(location.search);
      if (params.has('run') && !params.has('conversation')) {
        const legacy = await request<Run>(`/api/runs/${encodeURIComponent(id)}`, { signal: controller.signal });
        if (disposed) return;
        id = legacy.conversationId || legacy.id;
        setInitialRunId(legacy.id);
        const url = new URL(location.href); url.searchParams.delete('run'); url.searchParams.set('conversation', id);
        window.history.replaceState({}, '', url);
        if (id !== selectedId) { selectionRef.current = id; setSelectedId(id); return; }
      }
      const currentId = id;
      async function refreshSnapshot() {
        if (refreshing) return;
        refreshing = true;
        try {
          const next = await request<ConversationDetail>(`/api/conversations/${encodeURIComponent(currentId)}`, { signal: controller.signal });
          if (!disposed && selectionRef.current === currentId) {
            const reconciled = reconcileConversationSnapshot(detailRef.current, next, buffered);
            buffered = reconciled.pending; commitDetail(reconciled.detail); setDetailLoading(false);
            if (!buffered.length) setConnection('connected');
          }
        } catch (reason) {
          if (!disposed) { setError(reason instanceof Error ? reason.message : 'Could not load the conversation.'); setDetailLoading(false); }
        } finally { refreshing = false; }
      }
      void refreshSnapshot();
      stream = new EventSource(`/api/conversations/${encodeURIComponent(currentId)}/events`);
      stream.addEventListener('open', () => { if (!disposed) setConnection('connected'); });
      stream.addEventListener('snapshot', event => {
        if (disposed || selectionRef.current !== currentId) return;
        try {
          const snapshot = JSON.parse((event as MessageEvent<string>).data) as ConversationDetail;
          const reconciled = reconcileConversationSnapshot(detailRef.current, snapshot, buffered);
          buffered = reconciled.pending; commitDetail(reconciled.detail); setDetailLoading(false);
          setConnection(buffered.length ? 'reconnecting' : 'connected');
        }
        catch { setError('Could not read a conversation update. Reload to reconnect.'); }
      });
      stream.addEventListener('update', event => {
        if (disposed || selectionRef.current !== currentId) return;
        try {
          const update = JSON.parse((event as MessageEvent<string>).data) as ConversationEvent;
          const current = detailRef.current;
          if (!current || current.conversation.id !== currentId || buffered.length || update.seq > current.lastSeq + 1) {
            buffered.push(update); setConnection('reconnecting'); void refreshSnapshot(); return;
          }
          commitDetail(applyConversationEvent(current, update));
        } catch { setError('Could not read a streamed update. Reload to reconnect.'); }
      });
      stream.addEventListener('error', () => { if (!disposed) setConnection('reconnecting'); });
    }
    void connect().catch(reason => { if (!disposed) { setError(reason instanceof Error ? reason.message : 'Could not open the conversation.'); setDetailLoading(false); } });
    return () => { disposed = true; controller.abort(); stream?.close(); };
  }, [selectedId, commitDetail]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('code-geist-theme', theme); } catch { /* Keep the in-memory preference. */ }
  }, [theme]);
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(location.search);
      const id = params.get('conversation') || params.get('run');
      selectionRef.current = id; detailRef.current = null; setDetail(null); setDetailLoading(Boolean(id)); setSelectedId(id); setInitialRunId(params.get('run')); setSettings(false);
    };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (!sidebar) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSidebar(false); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [sidebar]);

  function selectConversation(id: string | null) {
    if (selectedId !== id) { detailRef.current = null; setDetail(null); setDetailLoading(Boolean(id)); }
    selectionRef.current = id; setSelectedId(id); setInitialRunId(null); setSettings(false); setSidebar(false); setError('');
    const url = new URL(location.href); url.searchParams.delete('run');
    if (id) url.searchParams.set('conversation', id); else url.searchParams.delete('conversation');
    window.history.pushState({}, '', url);
  }
  async function create(input: CreateRunInput) {
    setSubmitting(true); setError('');
    try {
      const next = await request<ConversationDetail>('/api/conversations', { method: 'POST', body: JSON.stringify(input) });
      selectConversation(next.conversation.id); commitDetail(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start the conversation.'); }
    finally { setSubmitting(false); }
  }
  async function send(input: SendMessageInput) {
    const id = detailRef.current?.conversation.id;
    if (!id) throw new Error('Open a conversation before sending a message.');
    const next = await request<Run>(`/api/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) });
    mergeRun(next); return next;
  }
  async function resume(id: string, clientRequestId: string) {
    const next = await request<Run>(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ additionalSteps: 12, clientRequestId }) });
    mergeRun(next); return next;
  }
  async function cancel(id: string) {
    const next = await request<Run>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    mergeRun(next); return next;
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    {sidebar && <button className="sidebar-scrim" onClick={() => setSidebar(false)} aria-label="Close conversation navigation" />}
    <aside className={`sidebar ${sidebar ? 'is-open' : ''}`} aria-label="Conversation navigation">
      <button className="brand" onClick={() => selectConversation(null)} aria-label="Code Geist home"><Logo /><span>code geist<span className="brand-period">.</span></span></button>
      <button className="new-task-button" onClick={() => selectConversation(null)}><Plus size={17} /><span>New conversation</span><span className="small-label">+</span></button>
      <div className="sidebar-heading"><span>Workspace</span><span className="local-badge">LOCAL</span></div>
      <button className={`nav-item ${!selectedId && !settings ? 'selected' : ''}`} onClick={() => selectConversation(null)}><LayoutList size={16} /><span>Task workbench</span></button>
      <div className="sidebar-heading tasks-heading"><span>Conversations</span><span className="history-count">{history.length}</span></div>
      <div className="history-list">{history.length === 0 && <div className="history-empty"><span className="empty-line" /><span className="empty-line short" /><p>Your conversations will appear here.</p></div>}{history.map(item => <button key={item.id} className={`history-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => selectConversation(item.id)} title={item.title}><span className={`history-status status-${item.status}`}>{item.status === 'running' ? <LoaderCircle size={15} className="spin" /> : item.status === 'needs_attention' ? <CircleAlert size={15} /> : <MessageSquare size={14} />}</span><span className="history-text"><span className="history-title">{item.title}</span><span className="history-meta">{item.mode === 'demo' ? 'Demo' : compactPath(item.repository)}<span>·</span>{item.runIds.length} {item.runIds.length === 1 ? 'turn' : 'turns'}</span></span></button>)}</div>
      <div className="sidebar-bottom"><button className={`nav-item ${settings ? 'selected' : ''}`} onClick={() => { setSettings(!settings); setSidebar(false); }}><Settings2 size={16} /><span>Providers & models</span>{config && <span className={`tiny-dot ${config.modelConfigured ? 'green' : 'amber'}`} />}</button><div className="runtime"><span className={`tiny-dot ${bootError ? 'red' : loading ? 'amber' : 'green'}`} /><span>{bootError ? 'Runtime unavailable' : loading ? 'Connecting to runtime' : 'Local runtime connected'}</span><span className="version">v0.1</span></div></div>
    </aside>
    <div className={`workspace-shell ${selectedId && !settings ? 'has-conversation' : ''}`}>
      <header className="topbar"><button className="icon-button menu-toggle" onClick={() => setSidebar(!sidebar)} aria-label="Open conversation navigation" aria-expanded={sidebar}><Menu size={19} /></button><div className="breadcrumbs"><span className="breadcrumb-home">Workspace</span><ChevronRight size={13} /><span>{settings ? 'Providers & models' : selectedId ? 'Conversation' : 'New conversation'}</span></div><div className="topbar-actions"><span className="local-indicator"><FolderGit2 size={14} />Local execution</span><span className="topbar-divider" /><button className="icon-button theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div></header>
      <main id="main-content" className={`main-content ${!selectedId && !settings ? 'new-task-view' : selectedId && !settings ? 'conversation-view' : ''}`}>
        {(error || bootError) && <div className="error-banner" role="alert"><CircleX size={17} /><span>{error || bootError}</span>{bootError ? <button className="text-button" onClick={() => void boot()}>Retry</button> : <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button>}</div>}
        {loading && !config ? <div className="loading-state"><LoaderCircle className="spin" size={23} /><p>Connecting to your workspace…</p></div>
          : settings && config ? <ProviderSettings config={config} onRefresh={() => void boot()} onBack={() => setSettings(false)} />
          : selectedId ? (detailLoading && !detail ? <div className="loading-state"><LoaderCircle className="spin" size={23} /><p>Loading conversation…</p></div> : detail && config ? <ConversationWorkspace key={detail.conversation.id} detail={detail} config={config} connection={connection} initialRunId={initialRunId} onSend={send} onResume={resume} onCancel={cancel} /> : <div className="loading-state"><CircleX size={25} /><p>This conversation could not be loaded.</p><button className="secondary-button" onClick={() => selectConversation(null)}>Back to workbench</button></div>)
          : config ? <NewTask config={config} submitting={submitting} onSubmit={input => void create(input)} onSettings={() => setSettings(true)} /> : null}
      </main>
      <footer className="workspace-footer"><span><Logo />Intent. Code. Evidence.</span><span>Jev + generative models<span className="footer-separator">/</span>Code Geist</span></footer>
    </div>
  </div>;
}

function NewTask({ config, submitting, onSubmit, onSettings }: { config: AppConfig; submitting: boolean; onSubmit: (input: CreateRunInput) => void; onSettings: () => void }) {
  const [task, setTask] = useState('');
  const [intent, setIntent] = useState<'coding' | 'discussion'>('coding');
  const [repository, setRepository] = useState(config.defaultRepository);
  const [testCommand, setTestCommand] = useState('npm test');
  const [setupCommand, setSetupCommand] = useState('');
  const [modelId, setModelId] = useState('auto');
  const [maxSteps, setMaxSteps] = useState(24);
  const [advanced, setAdvanced] = useState(false);
  const selectedModel = config.models.find(model => model.id === modelId);
  const configured = modelId === 'auto' ? config.modelConfigured : Boolean(selectedModel?.configured);
  const canSubmit = Boolean(configured && task.trim() && repository.trim() && testCommand.trim());
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit && !submitting) onSubmit({ mode: 'live', modelId, task: task.trim(), repository: repository.trim(), testCommand: testCommand.trim(), setupCommand: setupCommand.trim() || undefined, maxSteps, intent });
  }
  return <div className="new-task-content">
    <div className="page-eyebrow"><span className="eyebrow-line" />THE CODING WORKBENCH</div>
    <div className="intro"><h1>A clear path from<br />task to tested code<span className="accent-period">.</span></h1><p>Give your agent a task. Follow its decisions.<br className="desktop-break" />Review the patch and the proof.</p></div>

    <form onSubmit={submit} className="task-form">
      <div className="composer"><div className="new-task-composer-heading"><label htmlFor="task" className="composer-label">{intent === 'coding' ? <Code2 size={17} /> : <MessageSquare size={16} />}{intent === 'coding' ? 'What would you like to build?' : 'What would you like to understand?'}</label><div className="chat-intent" role="group" aria-label="New conversation intent"><button type="button" disabled={submitting} className={intent === 'coding' ? 'active' : ''} aria-pressed={intent === 'coding'} onClick={() => setIntent('coding')} title="Make and verify code changes"><Code2 size={13} />Code</button><button type="button" disabled={submitting} className={intent === 'discussion' ? 'active' : ''} aria-pressed={intent === 'discussion'} onClick={() => setIntent('discussion')} title="Discuss the repository without editing files"><MessageSquare size={12} />Ask</button></div></div><textarea id="task" placeholder={intent === 'coding' ? 'Describe a feature, fix a bug, or refactor something…' : 'Ask about the repository, explain a flow, or discuss a change…'} value={task} onChange={event => setTask(event.target.value)} rows={4} required maxLength={12000} disabled={submitting} /><div className="composer-hint"><span>{intent === 'coding' ? 'Include expected behavior and any constraints.' : 'Ask reads the repository without editing files.'}</span><span className="composer-corner"><Braces size={15} /></span></div></div>
      <div className="task-configuration">
        <div className="form-field repository-field"><label htmlFor="repository"><FolderGit2 size={14} />Repository</label><input id="repository" value={repository} onChange={event => setRepository(event.target.value)} placeholder="/absolute/path/to/repository" required disabled={submitting} spellCheck={false} /><span className="field-hint">An absolute path to a local Git repository.</span></div>
        <div className="form-field command-field"><label htmlFor="test-command"><Terminal size={14} />Verification command</label><input id="test-command" value={testCommand} onChange={event => setTestCommand(event.target.value)} placeholder="npm test" required disabled={submitting} spellCheck={false} /><span className="field-hint">{intent === 'coding' ? 'Executed inside the agent’s workspace.' : 'Saved for future Code turns.'}</span></div>
      </div>
      <div className="composer-toolbar"><div className="model-selector"><Workflow size={15} /><label className="sr-only" htmlFor="model">Model</label><select id="model" value={modelId} onChange={event => setModelId(event.target.value)} disabled={submitting}><option value="auto">Auto · Jev routing</option>{config.models.map(model => <option value={model.id} key={model.id}>{model.name}{model.configured ? '' : ' · not configured'}</option>)}</select><ChevronDown size={13} className="select-chevron" /></div><button type="button" className={`advanced-toggle ${advanced ? 'active' : ''}`} onClick={() => setAdvanced(!advanced)} aria-label="Options" aria-expanded={advanced}><Settings2 size={14} /><span>Options</span></button><button type="submit" className="primary-button run-button" disabled={!canSubmit || submitting}>{submitting ? <LoaderCircle size={16} className="spin" /> : <Play size={14} fill="currentColor" />}<span>{submitting ? 'Starting…' : intent === 'discussion' ? 'Ask question' : 'Run task'}</span><ArrowRight size={16} /></button></div>
      {advanced && <div className="advanced-options"><div className="form-field"><label htmlFor="setup-command">Setup command (optional)</label><input id="setup-command" value={setupCommand} onChange={event => setSetupCommand(event.target.value)} placeholder="npm ci" disabled={submitting} spellCheck={false} /><span className="field-hint">Runs once in the fresh worktree before the agent starts.</span></div><div className="form-field"><label htmlFor="max-steps">Maximum agent steps</label><input type="number" id="max-steps" min={6} max={60} value={maxSteps} onChange={event => setMaxSteps(Number(event.target.value))} required /><span className="field-hint">Stop the loop if the task needs more iterations.</span></div><p>{config.jevConfigured ? `Jev (${config.jevModel}) routes the task to an available model.` : 'Jev is not configured. Auto uses an available model and labels the routing fallback.'}</p><p>Starts from committed HEAD; uncommitted source changes are not included.</p></div>}
    </form>
    {!configured && <div className="configuration-notice"><span className="tiny-dot amber" /><span>{config.modelConfigured ? 'Configure this model to start a live task.' : 'Connect a model to run tasks on your repository.'}</span><button className="text-button" onClick={onSettings}>Configure providers<ArrowUpRight size={13} /></button></div>}
    <div className="demo-entry"><div className="demo-visual" aria-hidden="true"><span /><span /><span /><CheckCheck size={18} /></div><div className="demo-copy"><span className="overline">TAKE IT FOR A SPIN</span><h2>One small bug. The entire agent loop.</h2><p>Run a scripted task on a fixture repository, with real edits and tests. No API key needed.</p></div><button type="button" className="secondary-button demo-button" disabled={submitting} onClick={() => onSubmit({ mode: 'demo' })}>{submitting ? <LoaderCircle size={15} className="spin" /> : <Play size={13} />}Run demo<ArrowRight size={15} /></button></div>
    <div className="workflow-explainer"><div><span className="workflow-number">01</span><span>Jev routes & evaluates</span></div><ChevronRight size={13} /><div><span className="workflow-number">02</span><span>Your model writes code</span></div><ChevronRight size={13} /><div><span className="workflow-number">03</span><span>Tools verify the result</span></div></div>
  </div>;
}

function ConversationWorkspace({ detail, config, connection, initialRunId, onSend, onResume, onCancel }: {
  detail: ConversationDetail; config: AppConfig; connection: string; initialRunId: string | null;
  onSend: (input: SendMessageInput) => Promise<Run>; onResume: (id: string, clientId: string) => Promise<Run>; onCancel: (id: string) => Promise<Run>;
}) {
  const [tab, setTab] = useState<Tab>('chat');
  const [inspectionTab, setInspectionTab] = useState<Exclude<Tab, 'chat'>>('activity');
  const [layout, setLayout] = useState<'tabs' | 'split'>(() => {
    try { return localStorage.getItem('code-geist-conversation-layout') === 'tabs' ? 'tabs' : 'split'; }
    catch { return 'split'; }
  });
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  const [turnId, setTurnId] = useState<string | null>(initialRunId);
  const [eventId, setEventId] = useState<string | undefined>();
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState('');
  const split = layout === 'split' && wide;
  const activeTab = split ? inspectionTab : tab;
  const showChat = split || tab === 'chat';
  const active = detail.runs.find(item => item.id === detail.conversation.activeRunId && runIsActive(item)) ?? detail.runs.find(item => item.status === 'running');
  const run = detail.runs.find(item => item.id === turnId) ?? active ?? detail.runs.filter(item => item.status !== 'queued').at(-1) ?? detail.runs.at(-1);
  const currentVerification = run?.verification && run.verification.revision === (run.revision ?? run.verification.revision);
  const tabs = [{ id: 'chat', label: 'Chat', icon: MessageSquare }, { id: 'activity', label: 'Activity', icon: LayoutList }, { id: 'changes', label: 'Changes', icon: GitCompareArrows }, { id: 'verification', label: 'Verification', icon: ShieldCheck }] as const;
  const visibleTabs = split ? tabs.filter(item => item.id !== 'chat') : tabs;
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1100px)');
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    try { localStorage.setItem('code-geist-conversation-layout', layout); } catch { /* Keep the current layout in memory. */ }
  }, [layout]);
  function selectTab(next: Tab) {
    setTab(next);
    if (next !== 'chat') setInspectionTab(next);
  }
  function inspect(runId: string, nextEventId?: string) { setTurnId(runId); setEventId(nextEventId); selectTab('activity'); }
  async function stop() {
    if (!active) return;
    setStopping(true); setActionError('');
    try { await onCancel(active.id); } catch (reason) { setActionError(reason instanceof Error ? reason.message : 'Could not stop this turn.'); }
    finally { setStopping(false); }
  }
  return <div className={`conversation-workspace ${split ? 'conversation-workspace-split' : ''}`}>
    <div className="conversation-heading">
      <div><h1>{detail.conversation.title}</h1><div className="conversation-context"><FolderGit2 size={13} /><span>{detail.conversation.mode === 'demo' ? 'Demo fixture' : compactPath(detail.conversation.repository)}</span><span className="context-dot">·</span><span>{detail.runs.length} {detail.runs.length === 1 ? 'turn' : 'turns'}</span>{run?.workspace && <CopyButton value={run.workspace} label="Copy workspace path" />}</div></div>
      <div className="conversation-heading-actions">
        <div className="conversation-layout-switch" role="group" aria-label="Conversation layout">
          <button type="button" aria-pressed={!split} onClick={() => setLayout('tabs')} title="Show one conversation view at a time">Tabs</button>
          <button type="button" aria-pressed={split} disabled={!wide} onClick={() => setLayout('split')} title={wide ? 'Keep Chat beside the inspection tabs' : 'Split layout is available on wider screens'}>Split</button>
        </div>
        {detail.conversation.mode === 'demo' && <span className="mode-badge demo">DEMO</span>}
        <span className={`conversation-state ${active ? 'active' : ''}`}><span className={`tiny-dot ${active ? 'green' : detail.conversation.status === 'needs_attention' ? 'amber' : ''}`} />{active ? 'Working' : detail.conversation.status === 'needs_attention' ? 'Needs attention' : 'Ready'}</span>
        {active && !showChat && <button className="secondary-button" onClick={() => void stop()} disabled={stopping}>{stopping ? <LoaderCircle size={12} className="spin" /> : <Square size={11} fill="currentColor" />}Stop</button>}
      </div>
    </div>
    {connection === 'reconnecting' && <div className="chat-connection-note" role="status"><LoaderCircle size={12} className="spin" />Reconnecting. The agent continues on the server.</div>}
    {actionError && <div className="chat-inline-error" role="alert">{actionError}</div>}
    <div className={`conversation-panes ${split ? 'is-split' : ''}`}>
      <div className="conversation-chat-heading" hidden={!split}><MessageSquare size={14} /><span id="conversation-chat-title">Chat</span></div>
      <div className="conversation-navigation">
        <div className="tabs" role="tablist" aria-label={split ? 'Inspection views' : 'Conversation views'}>{visibleTabs.map(item => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={activeTab === item.id} aria-controls={`panel-${item.id}`} tabIndex={activeTab === item.id ? 0 : -1} className={`tab ${activeTab === item.id ? 'active' : ''}`} onClick={() => selectTab(item.id)} onKeyDown={event => {
          const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (offset) { event.preventDefault(); const next = visibleTabs[(visibleTabs.findIndex(value => value.id === item.id) + offset + visibleTabs.length) % visibleTabs.length]; selectTab(next.id); document.getElementById(`tab-${next.id}`)?.focus(); }
        }}><item.icon size={14} /><span>{item.label}</span>{item.id === 'changes' && Boolean(run?.files.length) && <span className="tab-count">{run!.files.length}</span>}{item.id === 'verification' && currentVerification && run?.verification?.passed && <span className="tiny-dot green" />}</button>)}</div>
        {activeTab !== 'chat' && run && <div className="conversation-turn-select"><label htmlFor="inspection-turn">Inspect</label><select id="inspection-turn" value={run.id} onChange={event => { setTurnId(event.target.value); setEventId(undefined); }}>{detail.runs.map((item, index) => <option key={item.id} value={item.id}>Turn {item.turnIndex ?? index + 1} · {item.status.replaceAll('_', ' ')}</option>)}</select><ChevronDown size={11} /></div>}
      </div>
      <section id="panel-chat" role={split ? 'region' : 'tabpanel'} aria-labelledby={split ? 'conversation-chat-title' : 'tab-chat'} className="conversation-panel conversation-chat-panel" hidden={!showChat} onFocus={() => { if (split) setTab('chat'); }}>
        <ChatView detail={detail} config={config} onSend={onSend} onResume={onResume} onCancel={onCancel} onInspect={inspect} />
      </section>
      <section id={activeTab === 'chat' ? undefined : `panel-${activeTab}`} role="tabpanel" aria-labelledby={activeTab === 'chat' ? undefined : `tab-${activeTab}`} className={`conversation-panel conversation-inspection-panel panel-${activeTab}`} hidden={activeTab === 'chat'}>
        {activeTab === 'activity' && run && <ActivityTrace key={run.id} run={run} focusEventId={eventId} />}
        {activeTab === 'changes' && run && <><div className="conversation-inspection-heading"><span>Turn {run.turnIndex ?? detail.runs.indexOf(run) + 1} · {run.files.length} {run.files.length === 1 ? 'file' : 'files'} changed</span>{run.diff && <a className="patch-download" href={`/api/runs/${encodeURIComponent(run.id)}/patch`} download><ArrowDownToLine size={14} />Download patch</a>}</div><Changes key={run.id} run={run} /></>}
        {activeTab === 'verification' && run && <VerificationPanel run={run} />}
      </section>
    </div>
  </div>;
}

function Changes({ run }: { run: Run }) {
  const [selectedFile, setSelectedFile] = useState('');
  const blocks = run.diff.split(/(?=^diff --git )/m).filter(Boolean);
  const actualSelection = selectedFile && run.files.some(file => file.path === selectedFile) ? selectedFile : '';
  const visibleBlocks = actualSelection ? blocks.filter(block => block.startsWith(`diff --git a/${actualSelection} b/${actualSelection}\n`) || block.includes(`+++ b/${actualSelection}\n`) || block.includes(`--- a/${actualSelection}\n`)) : blocks;
  if (!run.diff) return <div className="panel-empty"><GitCompareArrows size={28} /><h3>No changes yet</h3><p>The patch will appear here after the agent edits a file.</p></div>;
  return <div className="changes-panel"><div className="changed-files"><button className={`file-filter ${actualSelection === '' ? 'active' : ''}`} onClick={() => setSelectedFile('')}><GitCompareArrows size={14} /><span>All files</span><span className="file-count">{run.files.length}</span></button>{run.files.map(file => <button key={file.path} className={`file-filter ${actualSelection === file.path ? 'active' : ''}`} onClick={() => setSelectedFile(file.path)}><FileCode2 size={14} /><span className="file-filter-path">{file.path}</span><span className="diff-stats"><span className="additions">+{file.additions}</span><span className="deletions">−{file.deletions}</span></span></button>)}</div><div className="diff-container"><div className="code-caption"><span>UNIFIED DIFF</span><CopyButton value={actualSelection ? visibleBlocks.join('') : run.diff} label="Copy patch" /></div>{visibleBlocks.length === 0 ? <p className="diff-unavailable">This file’s patch cannot be displayed. Download the full patch to inspect it.</p> : visibleBlocks.map((block, blockIndex) => <pre className="diff-code" key={blockIndex}>{block.split('\n').map((line, index) => <span key={index} className={`diff-line ${line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'diff-meta' : line.startsWith('+') ? 'diff-addition' : line.startsWith('-') ? 'diff-deletion' : line.startsWith('@@') ? 'diff-hunk' : ''}`}><span className="diff-line-number" aria-hidden="true">{index + 1}</span><span>{line || ' '}</span>{'\n'}</span>)}</pre>)}</div></div>;
}

function VerificationPanel({ run }: { run: Run }) {
  const verification = run.verification;
  const current = verification && verification.revision === (run.revision ?? verification.revision);
  if (!verification) return <div className="panel-empty"><ShieldCheck size={29} /><h3>Verification is up next</h3><p>The agent will execute your command and capture its output.</p><code>{run.testCommand}</code></div>;
  return <div className="verification-panel"><div className={`verification-result ${!current ? 'outdated' : verification.passed ? 'passed' : 'failed'}`}>{!current ? <CircleDashed size={24} /> : verification.passed ? <CircleCheck size={24} /> : <CircleX size={24} />}<div><h3>{!current ? 'Needs re-run' : verification.passed ? 'Verification passed' : 'Verification did not pass'}</h3><p>{!current && 'The workspace changed after this check. '}{verification.exitCode === null ? 'The process did not return an exit code.' : `Command exited with code ${verification.exitCode}.`}{' '}{time(verification.at)}</p></div><span className="verification-revision">Revision {verification.revision}</span></div><div className="terminal-output"><div className="terminal-caption"><span><Terminal size={14} />{verification.command}</span><CopyButton value={verification.output} label="Copy verification output" /></div><pre>{verification.output || '(No output)'}</pre></div><p className="verification-note"><ShieldCheck size={13} />This is the command’s actual output from the isolated workspace.</p></div>;
}

function ProviderSettings({ config, onRefresh, onBack }: { config: AppConfig; onRefresh: () => void; onBack: () => void }) {
  return <div className="provider-settings"><div className="page-eyebrow"><span className="eyebrow-line" />WORKSPACE SETTINGS</div><div className="settings-heading"><div><h1>Your models, your workflow<span className="accent-period">.</span></h1><p>Connect an OpenAI-compatible provider. Let Jev choose the right model for a task, or pick one yourself.</p></div><button className="secondary-button" onClick={onRefresh}><Workflow size={14} />Refresh</button></div>{config.configurationError && <div className="error-banner" role="alert"><CircleX size={17} /><span>{config.configurationError}</span></div>}<div className="settings-section"><div className="section-heading"><h2>Generative models</h2><span>{config.models.filter(model => model.configured).length} configured</span></div>{config.models.length ? <div className="model-list">{config.models.map(model => <div className="model-row" key={model.id}><span className="model-letter">{model.name.slice(0, 1).toUpperCase()}</span><div className="model-description"><h3>{model.name}<span className={`provider-status ${model.configured ? 'connected' : ''}`}><span className={`tiny-dot ${model.configured ? 'green' : 'amber'}`} />{model.configured ? 'Configured' : 'Key needed'}</span></h3><p>{model.description}</p><div className="model-endpoint"><code>{model.model}</code><span>·</span><code>{model.baseURL}</code></div></div></div>)}</div> : <div className="settings-empty">No model profiles configured. Add your first provider below.</div>}</div><div className="settings-section jev-settings"><div><h2><Workflow size={18} />Jev evaluator</h2><p>Task routing, context scoring, and failure classification.</p><code>{config.jevModel}</code></div><span className={`provider-status ${config.jevConfigured ? 'connected' : ''}`}><span className={`tiny-dot ${config.jevConfigured ? 'green' : 'amber'}`} />{config.jevConfigured ? 'Configured' : 'Fallback active'}</span></div><div className="settings-section setup-instructions"><div className="section-heading"><h2>Configure locally</h2><span>API keys stay on your server</span></div><p>Add a default model in <code>.env</code>. DeepSeek, Zhipu, and other compatible endpoints can use the same configuration.</p><div className="settings-code"><pre>{'OPENAI_BASE_URL=https://api.deepseek.com\nOPENAI_API_KEY=your-api-key\nOPENAI_MODEL=deepseek-flash\n\nTYPESAFE_API_KEY=your-jev-key\nTYPESAFE_MODEL=jev-1.13.0'}</pre></div><p>For multiple providers, define profiles in <code>models.config.json</code> with a model, base URL, description, and environment variable for each API key. Jev uses the descriptions to route tasks among configured models.</p><p className="settings-hint">Restart the local server after changing configuration, then refresh this page. Without a Jev key, routing and classification use a labeled fallback.</p></div><button className="primary-button" onClick={onBack}>Back to workspace<ArrowRight size={16} /></button></div>;
}
