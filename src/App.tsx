import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Braces, Check, CheckCheck,
  ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleDot,
  CircleX, Code2, Copy, FileCode2, FolderGit2, GitBranch, GitCompareArrows,
  LayoutList, LoaderCircle, Menu, Moon, Play, Plus, Settings2, ShieldCheck,
  Square, Sun, Terminal, Workflow, X, Zap,
} from 'lucide-react';
import type { AppConfig, CreateRunInput, Run, RunEvent, RunPhase, RunSummary } from '../shared/types';

type Tab = 'activity' | 'changes' | 'verification';
const phases: { id: RunPhase; label: string }[] = [
  { id: 'prepare', label: 'Prepare' }, { id: 'inspect', label: 'Inspect' },
  { id: 'plan', label: 'Plan' }, { id: 'edit', label: 'Edit' },
  { id: 'verify', label: 'Verify' }, { id: 'complete', label: 'Complete' },
];
const isActive = (run: Pick<Run, 'status'>) => run.status === 'queued' || run.status === 'running';
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

function StatusIcon({ status, className = '' }: { status: Run['status']; className?: string }) {
  if (status === 'running' || status === 'queued') return <LoaderCircle size={15} className={`spin ${className}`} />;
  if (status === 'completed') return <CircleCheck size={15} className={className} />;
  if (status === 'failed') return <CircleX size={15} className={className} />;
  return <Square size={13} className={className} />;
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setFailed(false); }
    catch { setFailed(true); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setCopied(false); setFailed(false); }, 2000);
  }
  return <button type="button" className={`icon-button copy-button ${copied ? 'copied' : ''}`} onClick={copy} aria-label={copied ? 'Copied' : failed ? 'Copy failed' : label} title={copied ? 'Copied' : failed ? 'Copy unavailable in this browser' : label}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(location.search).get('run'));
  const [error, setError] = useState('');
  const [bootError, setBootError] = useState('');
  const [loading, setLoading] = useState(true);
  const [runLoading, setRunLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [connection, setConnection] = useState<'connected' | 'connecting' | 'reconnecting'>('connecting');
  const [settings, setSettings] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [tab, setTab] = useState<Tab>('activity');
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');

  const mergeRun = useCallback((next: Run) => {
    setRun(next);
    setHistory(previous => [next, ...previous.filter(item => item.id !== next.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);

  const boot = useCallback(async () => {
    setLoading(true); setBootError('');
    try {
      const [nextConfig, runs] = await Promise.all([request<AppConfig>('/api/config'), request<RunSummary[]>('/api/runs')]);
      setConfig(nextConfig); setHistory(runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) { setBootError(e instanceof Error ? e.message : 'Cannot connect to the local runtime.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void boot(); }, [boot]);

  useEffect(() => {
    if (!selectedId) { setRun(null); setRunLoading(false); return; }
    let disposed = false;
    setRunLoading(true); setError(''); setConnection('connecting');
    void request<Run>(`/api/runs/${encodeURIComponent(selectedId)}`).then(next => {
      if (!disposed) { mergeRun(next); setRunLoading(false); }
    }).catch(e => { if (!disposed) { setError(e.message); setRunLoading(false); } });
    const events = new EventSource(`/api/runs/${encodeURIComponent(selectedId)}/events`);
    events.addEventListener('open', () => { if (!disposed) setConnection('connected'); });
    events.addEventListener('snapshot', event => {
      try {
        const next = JSON.parse((event as MessageEvent<string>).data) as Run;
        if (!disposed) { mergeRun(next); setRunLoading(false); setConnection('connected'); }
      } catch { if (!disposed) setError('Received an unreadable update. Reload to reconnect to this task.'); }
    });
    events.addEventListener('error', () => { if (!disposed) setConnection('reconnecting'); });
    return () => { disposed = true; events.close(); };
  }, [selectedId, mergeRun]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('code-geist-theme', theme); } catch { /* In-memory preference still works. */ }
  }, [theme]);
  useEffect(() => {
    const onPop = () => { setSelectedId(new URLSearchParams(location.search).get('run')); setTab('activity'); setSettings(false); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (!sidebar) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSidebar(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebar]);

  function selectRun(id: string | null) {
    if (selectedId !== id) setRun(null);
    setSelectedId(id); setTab('activity'); setSettings(false); setSidebar(false); setError('');
    const url = new URL(location.href);
    if (id) url.searchParams.set('run', id); else url.searchParams.delete('run');
    window.history.pushState({}, '', url);
  }
  async function create(input: CreateRunInput) {
    setSubmitting(true); setError('');
    try { const next = await request<Run>('/api/runs', { method: 'POST', body: JSON.stringify(input) }); selectRun(next.id); mergeRun(next); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start the task.'); }
    finally { setSubmitting(false); }
  }
  async function cancel() {
    if (!run) return;
    setCancelling(true); setError('');
    try { mergeRun(await request<Run>(`/api/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not cancel the task.'); }
    finally { setCancelling(false); }
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    {sidebar && <button className="sidebar-scrim" onClick={() => setSidebar(false)} aria-label="Close task navigation" />}
    <aside className={`sidebar ${sidebar ? 'is-open' : ''}`} aria-label="Task navigation">
      <button className="brand" onClick={() => selectRun(null)} aria-label="Code Geist home"><Logo /><span>code geist<span className="brand-period">.</span></span></button>
      <button className="new-task-button" onClick={() => selectRun(null)}><Plus size={17} /><span>New task</span><span className="small-label">+</span></button>
      <div className="sidebar-heading"><span>Workspace</span><span className="local-badge">LOCAL</span></div>
      <button className={`nav-item ${!selectedId && !settings ? 'selected' : ''}`} onClick={() => selectRun(null)}><LayoutList size={16} /><span>Task workbench</span></button>
      <div className="sidebar-heading tasks-heading"><span>Recent tasks</span><span className="history-count">{history.length}</span></div>
      <div className="history-list">
        {history.length === 0 && <div className="history-empty"><span className="empty-line" /><span className="empty-line short" /><p>Your tasks will appear here.</p></div>}
        {history.map(item => <button key={item.id} className={`history-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => selectRun(item.id)} title={item.task}>
          <span className={`history-status status-${item.status}`}><StatusIcon status={item.status} /></span>
          <span className="history-text"><span className="history-title">{item.title || item.task}</span><span className="history-meta">{item.mode === 'demo' ? 'Demo' : compactPath(item.repository)}<span>·</span>{new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></span>
        </button>)}
      </div>
      <div className="sidebar-bottom">
        <button className={`nav-item ${settings ? 'selected' : ''}`} onClick={() => { setSettings(!settings); setSidebar(false); }}><Settings2 size={16} /><span>Providers & models</span>{config && <span className={`tiny-dot ${config.modelConfigured ? 'green' : 'amber'}`} />}</button>
        <div className="runtime"><span className={`tiny-dot ${bootError ? 'red' : loading ? 'amber' : 'green'}`} /><span>{bootError ? 'Runtime unavailable' : loading ? 'Connecting to runtime' : 'Local runtime connected'}</span><span className="version">v0.1</span></div>
      </div>
    </aside>

    <div className="workspace-shell">
      <header className="topbar">
        <button className="icon-button menu-toggle" onClick={() => setSidebar(!sidebar)} aria-label="Open task navigation" aria-expanded={sidebar}><Menu size={19} /></button>
        <div className="breadcrumbs"><span className="breadcrumb-home">Workspace</span><ChevronRight size={13} /><span>{settings ? 'Providers & models' : selectedId ? 'Task details' : 'New task'}</span></div>
        <div className="topbar-actions"><span className="local-indicator"><FolderGit2 size={14} />Local execution</span><span className="topbar-divider" /><button className="icon-button theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button></div>
      </header>

      <main id="main-content" className={`main-content ${!selectedId && !settings ? 'new-task-view' : ''}`}>
        {(error || bootError) && <div className="error-banner" role="alert"><CircleX size={17} /><span>{error || bootError}</span>{bootError ? <button className="text-button" onClick={() => void boot()}>Retry</button> : <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button>}</div>}
        {loading && !config ? <div className="loading-state"><LoaderCircle className="spin" size={23} /><p>Connecting to your workspace…</p></div>
          : settings && config ? <ProviderSettings config={config} onRefresh={() => void boot()} onBack={() => setSettings(false)} />
          : selectedId ? (runLoading && !run ? <div className="loading-state"><LoaderCircle className="spin" size={23} /><p>Loading task…</p></div> : run ? <RunWorkspace run={run} tab={tab} setTab={setTab} connection={connection} onCancel={() => void cancel()} cancelling={cancelling} onNew={() => selectRun(null)} /> : <div className="loading-state"><CircleX size={25} /><p>This task could not be loaded.</p><button className="secondary-button" onClick={() => selectRun(null)}>Back to workbench</button></div>)
          : config ? <NewTask config={config} submitting={submitting} onSubmit={input => void create(input)} onSettings={() => setSettings(true)} /> : !bootError ? null : <div className="loading-state"><Terminal size={30} /><p>Start the local server to open your workbench.</p><code>npm run dev</code></div>}
      </main>
      <footer className="workspace-footer"><span><Logo />Intent. Code. Evidence.</span><span>Jev + generative models<span className="footer-separator">/</span>Code Geist</span></footer>
    </div>
  </div>;
}

function NewTask({ config, submitting, onSubmit, onSettings }: { config: AppConfig; submitting: boolean; onSubmit: (input: CreateRunInput) => void; onSettings: () => void }) {
  const [task, setTask] = useState('');
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
    if (canSubmit && !submitting) onSubmit({ mode: 'live', modelId, task: task.trim(), repository: repository.trim(), testCommand: testCommand.trim(), setupCommand: setupCommand.trim() || undefined, maxSteps });
  }
  return <div className="new-task-content">
    <div className="page-eyebrow"><span className="eyebrow-line" />THE CODING WORKBENCH</div>
    <div className="intro"><h1>A clear path from<br />task to tested code<span className="accent-period">.</span></h1><p>Give your agent a task. Follow its decisions.<br className="desktop-break" />Review the patch and the proof.</p></div>

    <form onSubmit={submit} className="task-form">
      <div className="composer"><label htmlFor="task" className="composer-label"><Code2 size={17} />What would you like to build?</label><textarea id="task" placeholder="Describe a feature, fix a bug, or refactor something…" value={task} onChange={event => setTask(event.target.value)} rows={4} required maxLength={12000} disabled={submitting} /><div className="composer-hint"><span>Include expected behavior and any constraints.</span><span className="composer-corner"><Braces size={15} /></span></div></div>
      <div className="task-configuration">
        <div className="form-field repository-field"><label htmlFor="repository"><FolderGit2 size={14} />Repository</label><input id="repository" value={repository} onChange={event => setRepository(event.target.value)} placeholder="/absolute/path/to/repository" required disabled={submitting} spellCheck={false} /><span className="field-hint">An absolute path to a local Git repository.</span></div>
        <div className="form-field command-field"><label htmlFor="test-command"><Terminal size={14} />Verification command</label><input id="test-command" value={testCommand} onChange={event => setTestCommand(event.target.value)} placeholder="npm test" required disabled={submitting} spellCheck={false} /><span className="field-hint">Executed inside the agent’s workspace.</span></div>
      </div>
      <div className="composer-toolbar"><div className="model-selector"><Workflow size={15} /><label className="sr-only" htmlFor="model">Model</label><select id="model" value={modelId} onChange={event => setModelId(event.target.value)} disabled={submitting}><option value="auto">Auto · Jev routing</option>{config.models.map(model => <option value={model.id} key={model.id}>{model.name}{model.configured ? '' : ' · not configured'}</option>)}</select><ChevronDown size={13} className="select-chevron" /></div><button type="button" className={`advanced-toggle ${advanced ? 'active' : ''}`} onClick={() => setAdvanced(!advanced)} aria-label="Options" aria-expanded={advanced}><Settings2 size={14} /><span>Options</span></button><button type="submit" className="primary-button run-button" disabled={!canSubmit || submitting}>{submitting ? <LoaderCircle size={16} className="spin" /> : <Play size={14} fill="currentColor" />}<span>{submitting ? 'Starting…' : 'Run task'}</span><ArrowRight size={16} /></button></div>
      {advanced && <div className="advanced-options"><div className="form-field"><label htmlFor="setup-command">Setup command (optional)</label><input id="setup-command" value={setupCommand} onChange={event => setSetupCommand(event.target.value)} placeholder="npm ci" disabled={submitting} spellCheck={false} /><span className="field-hint">Runs once in the fresh worktree before the agent starts.</span></div><div className="form-field"><label htmlFor="max-steps">Maximum agent steps</label><input type="number" id="max-steps" min={6} max={60} value={maxSteps} onChange={event => setMaxSteps(Number(event.target.value))} required /><span className="field-hint">Stop the loop if the task needs more iterations.</span></div><p>{config.jevConfigured ? `Jev (${config.jevModel}) routes the task to an available model.` : 'Jev is not configured. Auto uses an available model and labels the routing fallback.'}</p><p>Starts from committed HEAD; uncommitted source changes are not included.</p></div>}
    </form>
    {!configured && <div className="configuration-notice"><span className="tiny-dot amber" /><span>{config.modelConfigured ? 'Configure this model to start a live task.' : 'Connect a model to run tasks on your repository.'}</span><button className="text-button" onClick={onSettings}>Configure providers<ArrowUpRight size={13} /></button></div>}
    <div className="demo-entry"><div className="demo-visual" aria-hidden="true"><span /><span /><span /><CheckCheck size={18} /></div><div className="demo-copy"><span className="overline">TAKE IT FOR A SPIN</span><h2>One small bug. The entire agent loop.</h2><p>Run a scripted task on a fixture repository, with real edits and tests. No API key needed.</p></div><button type="button" className="secondary-button demo-button" disabled={submitting} onClick={() => onSubmit({ mode: 'demo' })}>{submitting ? <LoaderCircle size={15} className="spin" /> : <Play size={13} />}Run demo<ArrowRight size={15} /></button></div>
    <div className="workflow-explainer"><div><span className="workflow-number">01</span><span>Jev routes & evaluates</span></div><ChevronRight size={13} /><div><span className="workflow-number">02</span><span>Your model writes code</span></div><ChevronRight size={13} /><div><span className="workflow-number">03</span><span>Tools verify the result</span></div></div>
  </div>;
}

function RunWorkspace({ run, tab, setTab, connection, onCancel, cancelling, onNew }: { run: Run; tab: Tab; setTab: (tab: Tab) => void; connection: string; onCancel: () => void; cancelling: boolean; onNew: () => void }) {
  const active = isActive(run);
  const additions = run.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = run.files.reduce((sum, file) => sum + file.deletions, 0);
  const phaseIndex = phases.findIndex(phase => phase.id === run.phase);
  const currentVerification = run.verification && run.verification.revision === (run.revision ?? run.verification.revision);
  const phaseEvidence: Record<RunPhase, boolean> = {
    prepare: Boolean(run.workspace),
    inspect: run.events.some(event => event.type === 'tool' && event.status === 'success' && ['list_files', 'read_file', 'search_files'].includes(String(event.data?.name))),
    plan: run.events.some(event => event.type === 'model' && (event.status === 'success' || event.data?.source === 'demo')),
    edit: run.files.length > 0,
    verify: Boolean(currentVerification && run.verification?.passed),
    complete: run.status === 'completed',
  };
  return <div className="run-workspace">
    <div className="run-heading"><div><div className="run-eyebrow"><span className={`mode-badge ${run.mode}`}>{run.mode === 'demo' ? 'SCRIPTED DEMO' : 'LIVE TASK'}</span><span className="run-date">{new Date(run.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}<span> / </span>{time(run.createdAt)}</span></div><h1>{run.title || run.task}</h1></div><div className="run-actions">{active ? <button className="secondary-button cancel-button" disabled={cancelling} onClick={onCancel}>{cancelling ? <LoaderCircle size={14} className="spin" /> : <Square size={12} fill="currentColor" />}{cancelling ? 'Stopping…' : 'Stop task'}</button> : <button className="secondary-button" onClick={onNew}><Plus size={15} />New task</button>}</div></div>
    <div className="run-overview"><span className={`status-badge status-${run.status}`}><StatusIcon status={run.status} />{run.status === 'completed' ? 'Completed' : run.status === 'running' ? 'In progress' : run.status === 'queued' ? 'Queued' : run.status === 'cancelled' ? 'Stopped' : 'Failed'}</span><span className="overview-item"><FolderGit2 size={14} />{run.mode === 'demo' ? 'Demo fixture' : compactPath(run.repository)}</span><span className="overview-item"><Workflow size={14} />{run.modelName || (run.mode === 'demo' ? 'Scripted agent' : 'Routing model…')}</span><span className="run-step">Step {run.step}<span> / {run.maxSteps}</span></span></div>
    {run.mode === 'demo' && <div className="demo-run-note"><Zap size={14} /><span>This demo uses scripted model decisions. File changes and verification are executed locally.</span></div>}
    <ol className="phase-rail" aria-label="Task progress">{phases.map((phase, index) => {
      const current = index === phaseIndex;
      const done = phaseEvidence[phase.id] && !(current && active);
      return <li key={phase.id} className={`${done ? 'done' : ''} ${current ? 'current' : ''} ${current && run.status === 'failed' ? 'phase-failed' : ''}`} aria-current={current ? 'step' : undefined}><span className="phase-topline" /><span className="phase-label">{done ? <Check size={14} /> : current && active ? <LoaderCircle className="spin" size={14} /> : current && run.status === 'failed' ? <CircleX size={14} /> : <span className="phase-number">{String(index + 1).padStart(2, '0')}</span>}{phase.label}</span></li>;
    })}</ol>
    {active && connection === 'reconnecting' && <div className="connection-note" role="status"><LoaderCircle className="spin" size={14} />Reconnecting to the event stream. The agent may still be running.</div>}
    {run.error && <div className="run-error" role="alert"><CircleX size={18} /><div><strong>The task needs attention</strong><p>{run.error}</p></div></div>}
    {run.summary && <div className={`completion-summary ${run.status === 'completed' ? 'successful' : ''}`}><span className="summary-icon">{run.status === 'completed' ? <CheckCheck size={20} /> : <LayoutList size={19} />}</span><div><h2>{run.status === 'completed' ? 'Ready for your review' : 'Task summary'}</h2><p>{run.summary}</p></div></div>}

    <div className="run-body"><div className="run-primary"><div className="inspector-header"><div className="tabs" role="tablist" aria-label="Task inspection">{([{ id: 'activity', label: 'Activity', icon: LayoutList }, { id: 'changes', label: 'Changes', icon: GitCompareArrows }, { id: 'verification', label: 'Verification', icon: ShieldCheck }] as const).map(item => <button key={item.id} id={`tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} className={`tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)} onKeyDown={event => { const ids: Tab[] = ['activity', 'changes', 'verification']; const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (offset) { event.preventDefault(); const next = ids[(ids.indexOf(tab) + offset + ids.length) % ids.length]; setTab(next); document.getElementById(`tab-${next}`)?.focus(); } }}><item.icon size={15} /><span>{item.label}</span>{item.id === 'changes' && run.files.length > 0 && <span className="tab-count">{run.files.length}</span>}{item.id === 'verification' && currentVerification && run.verification?.passed && <span className="tiny-dot green" />}</button>)}</div><span className={`stream-status ${active ? 'live' : ''}`}>{active ? <><span className="tiny-dot green pulse" />Live</> : <><Check size={12} />Saved</>}</span></div>
      <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className={`tab-content tab-${tab}`}>
        {tab === 'activity' && <Activity events={run.events} active={active} />}
        {tab === 'changes' && <Changes run={run} />}
        {tab === 'verification' && <VerificationPanel run={run} />}
      </section>
    </div><aside className="run-details" aria-label="Run details"><div className="details-section"><h2>THE TASK</h2><p className="task-description">{run.task}</p></div><div className="details-section"><h2>WORKSPACE</h2><div className="detail-label"><FolderGit2 size={14} /><span>Isolated worktree</span>{run.workspace && <CopyButton value={run.workspace} label="Copy workspace path" />}</div>{run.workspace ? <code className="workspace-path">{run.workspace}</code> : <p className="muted">Preparing workspace…</p>}{run.branch && <div className="branch-detail"><GitBranch size={13} /><code>{run.branch}</code><CopyButton value={run.branch} label="Copy branch name" /></div>}</div><div className="details-section"><h2>EXECUTION</h2><dl className="execution-stats"><div><dt>Model calls</dt><dd>{run.metrics.modelCalls}</dd></div><div><dt>Jev calls</dt><dd>{run.metrics.jevCalls}</dd></div><div><dt>Tool calls</dt><dd>{run.metrics.toolCalls}</dd></div>{run.metrics.inputTokens + run.metrics.outputTokens > 0 && <div><dt>Reported tokens</dt><dd>{(run.metrics.inputTokens + run.metrics.outputTokens).toLocaleString()}</dd></div>}</dl>{run.mode === 'demo' && <p className="detail-footnote">Model decisions are scripted in demo mode.</p>}</div><div className="details-section change-summary"><h2>CHANGES</h2><div><span>{run.files.length} {run.files.length === 1 ? 'file' : 'files'} changed</span><span className="diff-stats"><span className="additions">+{additions}</span><span className="deletions">−{deletions}</span></span></div>{run.diff && <a className="patch-download" href={`/api/runs/${encodeURIComponent(run.id)}/patch`} download><ArrowDownToLine size={14} />Download patch<ArrowUpRight size={13} /></a>}</div></aside></div>
    <span className="sr-only" role="status" aria-live="polite">Task {run.status}. Current phase: {run.phase}.{run.verification ? ` Verification ${!currentVerification ? 'needs re-run' : run.verification.passed ? 'passed' : 'failed'}.` : ''}</span>
  </div>;
}

function Activity({ events, active }: { events: RunEvent[]; active: boolean }) {
  if (events.length === 0) return <div className="panel-empty"><CircleDashed size={27} /><h3>Getting things ready</h3><p>Agent activity will appear here as the task starts.</p></div>;
  return <div className="activity-timeline">{events.map((event, index) => <EventRow key={event.id} event={event} index={index} running={active && index === events.length - 1} />)}{active && <div className="working-row"><span className="working-dots"><i /><i /><i /></span><span>Agent is working</span></div>}</div>;
}

function EventRow({ event, index, running }: { event: RunEvent; index: number; running: boolean }) {
  const icons = { phase: CircleDot, model: Braces, tool: Terminal, jev: Workflow, verification: ShieldCheck, error: CircleX, summary: CheckCheck };
  const Icon = icons[event.type] || Circle;
  const source = event.data?.source;
  const hasDetails = Boolean(event.message || (event.data && Object.keys(event.data).length));
  return <details className={`event-row event-${event.type} event-${event.status || 'info'}`}><summary className={!hasDetails ? 'no-details' : ''}><span className="event-index">{String(index + 1).padStart(2, '0')}</span><span className="event-symbol">{event.status === 'running' && running ? <LoaderCircle size={15} className="spin" /> : <Icon size={15} />}</span><span className="event-heading"><span className="event-title">{event.title}</span>{typeof source === 'string' && <span className={`event-source ${source === 'fallback' ? 'fallback' : ''}`}>{source}</span>}</span><time className="event-time" dateTime={event.at}>{time(event.at)}</time>{hasDetails && <ChevronRight size={13} className="event-chevron" />}</summary>{hasDetails && <div className="event-detail">{event.message && <p>{event.message}</p>}{event.data && Object.keys(event.data).length > 0 && <div className="event-data"><div className="code-caption"><span>{event.type === 'jev' ? 'Decision evidence' : event.type === 'tool' ? 'Tool details' : 'Event data'}</span><CopyButton value={JSON.stringify(event.data, null, 2)} label="Copy event data" /></div><pre>{JSON.stringify(event.data, null, 2)}</pre></div>}</div>}</details>;
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
