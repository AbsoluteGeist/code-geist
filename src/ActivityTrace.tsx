import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, Braces, Check, ChevronDown, ChevronRight,
  ChevronsDownUp, ChevronsUpDown, CircleCheck, CircleDashed, CircleX, Clock3,
  Copy, CornerDownRight, FileJson2, ListFilter, LoaderCircle, Search,
  Terminal, TextCursorInput, Workflow, WrapText, X,
} from 'lucide-react';
import type { Run, RunEvent, TraceDetail, TraceMetadata } from '../shared/types';
import { copyText } from './clipboard';
import './activity-trace.css';

type TraceKind = TraceMetadata['kind'] | 'event';
type InspectorTab = 'summary' | 'request' | 'response' | 'schema' | 'timing';
type TimingMode = 'duration' | 'order';
type EventGroup = { id: string; turn?: number; events: RunEvent[] };

const kindLabels: Record<TraceKind, string> = {
  input: 'Input', model: 'Model', jev: 'Jev', tool: 'Tool', setup: 'Setup', event: 'Event',
};
const kindIcons = {
  input: TextCursorInput, model: Braces, jev: Workflow, tool: Terminal,
  setup: Terminal, event: CircleDashed,
};
const inspectorTabs: InspectorTab[] = ['summary', 'request', 'response', 'schema', 'timing'];
const activeRun = (run: Run) => run.status === 'running' || run.status === 'queued';
const dateMs = (value: string | undefined) => value ? Date.parse(value) : NaN;

function eventKind(event: RunEvent): TraceKind {
  if (event.trace) return event.trace.kind;
  return event.type === 'input' || event.type === 'model' || event.type === 'jev' || event.type === 'tool' ? event.type : 'event';
}

function durationLabel(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const ms = Math.max(0, value);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function eventDuration(event: RunEvent, now: number, running: boolean): number | undefined {
  if (!event.trace) return undefined;
  if (event.trace.durationMs !== undefined) return event.trace.durationMs;
  const start = dateMs(event.trace.startedAt);
  const end = dateMs(event.trace.endedAt);
  if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  if (running && event.status === 'running' && Number.isFinite(start)) return Math.max(0, now - start);
  return undefined;
}

function formatTime(value: string | undefined): string {
  if (!value || !Number.isFinite(dateMs(value))) return 'Not recorded';
  return new Date(value).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
  });
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function preview(value: unknown, limit = 175): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function groupEvents(events: RunEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  for (const event of events) {
    const turn = event.trace?.turn;
    let group = groups.at(-1);
    if (!group || (turn !== undefined && turn !== group.turn)) {
      group = { id: `${turn ?? 'session'}-${event.id}`, turn, events: [] };
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
}

function eventSource(event: RunEvent): string | undefined {
  if (event.trace) return event.trace.source;
  return typeof event.data?.source === 'string' ? event.data.source : undefined;
}

function eventState(event: RunEvent, run: Run): string {
  if (event.status === 'running') return !event.trace ? 'Started (legacy)' : activeRun(run) ? 'Running' : 'Unfinished';
  if (event.status === 'error') return 'Error';
  if (event.status === 'success') return 'Complete';
  return 'Recorded';
}

export default function ActivityTrace({ run }: { run: Run }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<TraceKind | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [timingMode, setTimingMode] = useState<TimingMode>('duration');
  const [now, setNow] = useState(Date.now());
  const rowsRef = useRef<HTMLDivElement>(null);
  const running = activeRun(run);
  const groups = useMemo(() => groupEvents(run.events), [run.events]);
  const tracedEvents = useMemo(() => run.events.filter(event => event.trace), [run.events]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => groups.map(group => ({
    ...group,
    events: group.events.filter(event => {
      if (kind !== 'all' && eventKind(event) !== kind) return false;
      if (!normalizedQuery) return true;
      return `${event.title} ${event.message ?? ''} ${event.trace?.model ?? ''} ${event.trace?.url ?? ''} ${eventSource(event) ?? ''} ${JSON.stringify(event.data ?? {})}`.toLowerCase().includes(normalizedQuery);
    }),
  })).filter(group => group.events.length > 0), [groups, kind, normalizedQuery]);
  const filteredEvents = filteredGroups.flatMap(group => group.events);
  const selected = filteredEvents.find(event => event.id === selectedId) ?? filteredEvents[0];
  const visibleEvents = filteredGroups.flatMap(group => collapsed.has(group.id) ? [] : group.events);
  const turns = new Set(tracedEvents.map(event => event.trace!.turn).filter(turn => turn > 0));
  const calls = tracedEvents.length ? tracedEvents.filter(event => event.trace!.kind !== 'input').length : run.metrics.modelCalls + run.metrics.jevCalls + run.metrics.toolCalls;
  const elapsed = Math.max(0, (running ? now : dateMs(run.updatedAt)) - dateMs(run.createdAt));
  const allCollapsed = filteredGroups.length > 0 && filteredGroups.every(group => collapsed.has(group.id));

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  function toggleGroup(id: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectFromDiagram(id: string) {
    setQuery(''); setKind('all'); setSelectedId(id);
    const group = groups.find(item => item.events.some(event => event.id === id));
    if (group) setCollapsed(previous => { const next = new Set(previous); next.delete(group.id); return next; });
    requestAnimationFrame(() => {
      const row = document.getElementById(`trace-row-${id}`);
      row?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      row?.focus({ preventScroll: true });
    });
  }

  function navigateRows(event: React.KeyboardEvent<HTMLButtonElement>, id: string) {
    const index = visibleEvents.findIndex(item => item.id === id);
    const nextIndex = event.key === 'ArrowDown' ? Math.min(index + 1, visibleEvents.length - 1)
      : event.key === 'ArrowUp' ? Math.max(index - 1, 0)
      : event.key === 'Home' ? 0 : event.key === 'End' ? visibleEvents.length - 1 : -1;
    if (nextIndex === -1) return;
    event.preventDefault();
    const next = visibleEvents[nextIndex];
    setSelectedId(next.id);
    document.getElementById(`trace-row-${next.id}`)?.focus({ preventScroll: true });
    document.getElementById(`trace-row-${next.id}`)?.scrollIntoView({ block: 'nearest' });
  }

  return <div className="activity-trace">
    <div className="trace-topline">
      <div className="trace-metrics" aria-label="Execution statistics">
        <div title={`Started ${run.createdAt}`}><Clock3 size={13} /><span>Duration</span><strong>{durationLabel(elapsed)}</strong></div>
        <div title="Agent turns recorded in transaction metadata"><span>Turns</span><strong>{tracedEvents.length ? turns.size : '—'}</strong></div>
        <div title="Recorded model, evaluator, and tool transactions, including demo and local operations"><span>Calls</span><strong>{calls}</strong></div>
        <div className="trace-event-count"><span>Events</span><strong>{run.events.length}</strong></div>
      </div>
      <a className="trace-export" href={`/api/runs/${encodeURIComponent(run.id)}/trace`} download title="Download all transaction details as NDJSON"><ArrowDownToLine size={14} /><span>Download log</span><span className="trace-export-format">NDJSON</span></a>
    </div>

    <TimingDiagram run={run} events={tracedEvents} now={now} mode={timingMode} setMode={setTimingMode} selectedId={selected?.id} onSelect={selectFromDiagram} />

    <div className="trace-toolbar">
      <div className="trace-search"><Search size={14} /><label className="sr-only" htmlFor={`trace-search-${run.id}`}>Search event titles and metadata</label><input id={`trace-search-${run.id}`} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search events…" autoComplete="off" spellCheck={false} />{query && <button aria-label="Clear event search" onClick={() => setQuery('')}><X size={13} /></button>}</div>
      <div className="trace-kind-filter"><ListFilter size={14} /><label className="sr-only" htmlFor={`trace-kind-${run.id}`}>Filter event kind</label><select id={`trace-kind-${run.id}`} value={kind} onChange={event => setKind(event.target.value as TraceKind | 'all')}><option value="all">All events</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={12} /></div>
      <span className="trace-filter-count">{filteredEvents.length} of {run.events.length}</span>
      <button className="trace-collapse" disabled={!filteredGroups.length} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map(group => group.id)))} title={allCollapsed ? 'Expand all turns' : 'Collapse all turns'}>{allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}<span>{allCollapsed ? 'Expand' : 'Collapse'}</span></button>
    </div>

    <div className="trace-split">
      <div className="trace-event-list" ref={rowsRef} aria-label="Execution events">
        {filteredEvents.length === 0 ? <div className="trace-empty"><Search size={24} /><h3>{run.events.length ? 'No matching events' : running ? 'Waiting for the first event' : 'No events recorded'}</h3><p>{run.events.length ? 'Try another search or include all event kinds.' : running ? 'Requests and tool activity will appear as the task runs.' : 'This run has no execution records to inspect.'}</p>{run.events.length > 0 && <button className="text-button" onClick={() => { setQuery(''); setKind('all'); }}>Clear filters</button>}</div>
          : filteredGroups.map(group => <section className="trace-group" key={group.id} aria-label={group.turn === undefined ? 'Session activity' : group.turn === 0 ? 'Preparation' : `Turn ${group.turn}`}>
            <button className="trace-group-heading" onClick={() => toggleGroup(group.id)} aria-expanded={!collapsed.has(group.id)} aria-controls={`trace-group-${group.id}`}><ChevronRight size={12} className={!collapsed.has(group.id) ? 'is-expanded' : ''} /><span>{group.turn === undefined ? (tracedEvents.length ? 'SESSION' : 'RECORDED ACTIVITY') : group.turn === 0 ? 'PREPARATION' : `TURN ${String(group.turn).padStart(2, '0')}`}</span><span className="trace-group-count">{group.events.length} {group.events.length === 1 ? 'event' : 'events'}</span></button>
            {!collapsed.has(group.id) && <div id={`trace-group-${group.id}`} className="trace-group-rows">{group.events.map(event => <TraceRow key={event.id} event={event} run={run} now={now} selected={selected?.id === event.id} onSelect={() => setSelectedId(event.id)} onKeyDown={keyEvent => navigateRows(keyEvent, event.id)} />)}</div>}
          </section>)}
        {running && <div className="trace-list-live"><span className="tiny-dot green pulse" />Listening for new activity</div>}
        {!running && run.events.length > 0 && <div className="trace-list-end"><span /><span>{run.status === 'cancelled' ? 'Task stopped' : run.status === 'failed' ? 'Task failed' : 'End of trace'}</span><span /></div>}
      </div>
      <TraceInspector run={run} selected={selected} now={now} onSelectEvent={selectFromDiagram} />
    </div>
    <div className="trace-bottom-note"><span>Recorded requests, responses, and tool execution.</span><span>Payloads load when selected.</span></div>
  </div>;
}

function TimingDiagram({ run, events, now, mode, setMode, selectedId, onSelect }: {
  run: Run; events: RunEvent[]; now: number; mode: TimingMode; setMode: (value: TimingMode) => void;
  selectedId?: string; onSelect: (id: string) => void;
}) {
  const running = activeRun(run);
  const validEvents = events.filter(event => Number.isFinite(dateMs(event.trace?.startedAt)));
  const origin = Math.min(dateMs(run.createdAt), ...validEvents.map(event => dateMs(event.trace!.startedAt)));
  const end = Math.max(origin + 1, running ? now : dateMs(run.updatedAt), ...validEvents.map(event => dateMs(event.trace!.startedAt) + (eventDuration(event, now, running) ?? 0)));
  const total = end - origin;
  const lanes = [{ id: 'input', label: 'Input' }, { id: 'model', label: 'Model' }, { id: 'jev', label: 'Jev' }, { id: 'tool', label: 'Tools' }] as const;

  return <div className="trace-timing">
    <div className="trace-timing-heading"><span>EXECUTION MAP</span><div className="trace-timing-modes" role="group" aria-label="Execution map scale"><button className={mode === 'duration' ? 'active' : ''} aria-pressed={mode === 'duration'} onClick={() => setMode('duration')}>Duration</button><button className={mode === 'order' ? 'active' : ''} aria-pressed={mode === 'order'} onClick={() => setMode('order')}>Call order</button></div></div>
    {validEvents.length === 0 ? <div className="trace-timing-unavailable"><Clock3 size={16} /><span>{running ? 'The map will fill in as transactions start.' : 'Transaction timing is unavailable for this run. Recorded events remain available below.'}</span></div>
      : <div className="trace-swimlanes" aria-label="Transaction timing diagram">{lanes.map(lane => <div className="trace-swimlane" key={lane.id}><span className={`trace-lane-label kind-${lane.id}`}><span />{lane.label}</span><div className="trace-lane-track">{validEvents.map((event, index) => {
        const laneKind = event.trace!.kind === 'setup' ? 'tool' : event.trace!.kind;
        if (laneKind !== lane.id) return null;
        const duration = eventDuration(event, now, running);
        const left = mode === 'order' ? index / validEvents.length * 100 : (dateMs(event.trace!.startedAt) - origin) / total * 100;
        const width = mode === 'order' ? Math.max(.5, 100 / validEvents.length - .4) : Math.max(0, (duration ?? 0) / total * 100);
        return <button key={event.id} className={`trace-timing-bar kind-${laneKind} ${selectedId === event.id ? 'selected' : ''} ${event.status === 'error' ? 'has-error' : ''} ${event.status === 'running' && running ? 'is-running' : ''}`} style={{ left: `${Math.min(left, 99.4)}%`, width: `${Math.min(width, 100 - left)}%` }} onClick={() => onSelect(event.id)} aria-label={`${event.title}; ${duration !== undefined ? durationLabel(duration) : 'duration not recorded'}; select event`} title={`${event.title}\n${formatTime(event.trace!.startedAt)} · ${durationLabel(duration)}`}><span>{width > 10 ? event.trace?.model || (typeof event.data?.name === 'string' ? event.data.name : kindLabels[eventKind(event)]) : ''}</span></button>;
      })}</div></div>)}<div className="trace-time-axis"><span />{mode === 'duration' ? <div><span>0</span><span>{durationLabel(total / 2)}</span><span>{durationLabel(total)}</span></div> : <div><span>1</span><span>Call order</span><span>{validEvents.length}</span></div>}</div></div>}
  </div>;
}

function TraceRow({ event, run, now, selected, onSelect, onKeyDown }: {
  event: RunEvent; run: Run; now: number; selected: boolean; onSelect: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const kind = eventKind(event);
  const Icon = kindIcons[kind];
  const source = eventSource(event);
  const running = Boolean(event.trace && event.status === 'running' && activeRun(run));
  const requestPreview = event.data?.requestPreview;
  const responsePreview = event.data?.responsePreview ?? event.data?.resultPreview;
  const summary = preview(event.message || event.data?.name || event.trace?.model || '');
  const duration = eventDuration(event, now, activeRun(run));

  return <button id={`trace-row-${event.id}`} type="button" className={`trace-row kind-${kind} ${selected ? 'selected' : ''} ${event.trace?.parentId ? 'is-child' : ''} ${event.status === 'error' ? 'has-error' : ''}`} onClick={onSelect} onKeyDown={onKeyDown} aria-pressed={selected} aria-label={`${kindLabels[kind]}: ${event.title}. ${eventState(event, run)}`} title={event.title}>
    <span className="trace-row-leading">{event.trace?.parentId ? <CornerDownRight size={13} className="trace-child-arrow" /> : null}<span className="trace-kind-icon">{running ? <LoaderCircle size={14} className="spin" /> : <Icon size={14} />}</span></span>
    <span className="trace-row-body"><span className="trace-row-top"><span className={`trace-kind-badge kind-${kind}`}>{kind === 'event' ? event.type : kindLabels[kind]}</span><span className="trace-row-title">{event.title}</span><span className="trace-row-duration">{durationLabel(duration)}</span></span>
      {requestPreview !== undefined || responsePreview !== undefined ? <span className="trace-row-previews">{requestPreview !== undefined && <span><span>IN</span>{preview(requestPreview)}</span>}{responsePreview !== undefined && <span><span>OUT</span>{preview(responsePreview)}</span>}</span> : summary && <span className="trace-row-preview">{summary}</span>}
      <span className="trace-row-foot"><time dateTime={event.trace?.startedAt ?? event.at}>{formatTime(event.trace?.startedAt ?? event.at)}</time>{source && source !== 'live' && source !== 'harness' && <span className={`trace-source source-${source}`}>{source}</span>}{event.trace?.httpStatus !== undefined && <span className={`trace-http-status ${event.trace.httpStatus >= 400 ? 'is-error' : ''}`}>{event.trace.httpStatus}</span>}{event.trace?.usage && <span>{(event.trace.usage.inputTokens + event.trace.usage.outputTokens).toLocaleString()} tokens</span>}{event.status === 'error' ? <span className="trace-row-state is-error"><CircleX size={10} />Error</span> : event.status === 'success' ? <CircleCheck size={10} className="trace-row-ok" /> : event.status === 'running' && (!event.trace || !activeRun(run)) ? <span className="trace-row-state">{eventState(event, run)}</span> : null}</span>
    </span><ChevronRight size={12} className="trace-row-chevron" />
  </button>;
}

function TraceInspector({ run, selected, now, onSelectEvent }: {
  run: Run; selected?: RunEvent; now: number; onSelectEvent: (id: string) => void;
}) {
  const [tab, setTab] = useState<InspectorTab>('summary');
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [wrap, setWrap] = useState(true);
  const signature = selected ? JSON.stringify(selected) : '';
  const selectedId = selected?.id;
  const visibleDetail = detail?.event.id === selectedId ? detail : null;

  useEffect(() => {
    if (!selectedId) { setDetail(null); setError(''); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetch(`/api/runs/${encodeURIComponent(run.id)}/events/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) {
          let message = `Could not load event details (${response.status}).`;
          try { const body = await response.json(); if (typeof body.error === 'string') message = body.error; } catch { /* Preserve HTTP error. */ }
          throw new Error(message);
        }
        return response.json() as Promise<TraceDetail>;
      })
      .then(next => { if (!controller.signal.aborted) setDetail(next); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load event details.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [run.id, selectedId, signature, retry]);

  if (!selected) return <aside className="trace-inspector"><div className="trace-empty inspector-empty"><FileJson2 size={28} /><h3>Select a transaction</h3><p>Inspect its request, response, schema, and timing.</p></div></aside>;

  const trace = selected.trace;
  const Icon = kindIcons[eventKind(selected)];
  const payload = tab === 'request' ? visibleDetail?.request : tab === 'response' ? visibleDetail?.response : visibleDetail?.schema;
  const pendingResponse = Boolean(trace && tab === 'response' && selected.status === 'running' && activeRun(run));
  const payloadTab = tab === 'request' || tab === 'response' || tab === 'schema';

  return <aside className="trace-inspector" aria-label="Selected event details">
    <div className="trace-inspector-heading"><span className={`trace-kind-icon kind-${eventKind(selected)}`}><Icon size={15} /></span><div><span className="trace-inspector-eyebrow">TRANSACTION DETAILS</span><h3>{selected.title}</h3></div><span className={`trace-inspector-status state-${selected.status ?? 'info'}`}>{trace && selected.status === 'running' && activeRun(run) && <LoaderCircle size={11} className="spin" />}{eventState(selected, run)}</span></div>
    <div className="trace-inspector-tabs" role="tablist" aria-label="Transaction detail sections">{inspectorTabs.map(item => <button type="button" key={item} role="tab" id={`trace-detail-tab-${item}`} aria-controls={`trace-detail-panel-${item}`} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} className={tab === item ? 'active' : ''} onClick={() => setTab(item)} onKeyDown={event => {
      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!offset) return;
      event.preventDefault();
      const next = inspectorTabs[(inspectorTabs.indexOf(item) + offset + inspectorTabs.length) % inspectorTabs.length];
      setTab(next); document.getElementById(`trace-detail-tab-${next}`)?.focus();
    }}>{item[0].toUpperCase() + item.slice(1)}{((item === 'request' && trace?.hasRequest) || (item === 'response' && trace?.hasResponse) || (item === 'schema' && trace?.hasSchema)) && <span className="trace-tab-dot" />}</button>)}</div>

    <section id={`trace-detail-panel-${tab}`} role="tabpanel" aria-labelledby={`trace-detail-tab-${tab}`} className={`trace-inspector-content inspector-${tab}`}>
      {error && <div className="trace-detail-error" role="alert"><CircleX size={15} /><div><p>{error}</p><button className="text-button" onClick={() => setRetry(value => value + 1)}>Try again</button></div></div>}
      {loading && !visibleDetail && !error ? <div className="trace-detail-loading"><LoaderCircle className="spin" size={20} /><p>Loading transaction details…</p></div>
        : <>
          {loading && visibleDetail && <div className="trace-detail-refresh"><LoaderCircle size={11} className="spin" />Updating transaction…</div>}
          {visibleDetail?.note && <div className="trace-detail-note"><CircleDashed size={14} /><p>{visibleDetail.note}</p></div>}
          {tab === 'summary' && <TraceSummary event={selected} detail={visibleDetail} run={run} now={now} onView={setTab} />}
          {tab === 'timing' && <TraceTiming event={selected} run={run} now={now} onSelectEvent={onSelectEvent} />}
          {payloadTab && (payload !== undefined ? <PayloadViewer value={payload} name={tab} wrap={wrap} onWrap={() => setWrap(!wrap)} /> : !error && <div className="trace-payload-empty">{pendingResponse || loading ? <LoaderCircle className="spin" size={23} /> : <FileJson2 size={24} />}<h4>{loading ? `Loading ${tab}…` : pendingResponse ? 'Waiting for a response' : `No ${tab} recorded`}</h4><p>{loading ? 'Retrieving the latest recorded payload.' : pendingResponse ? 'This panel updates when the transaction finishes.' : tab === 'schema' ? 'This event has no recorded tool or response schema.' : trace && selected.status === 'running' && !activeRun(run) && tab === 'response' ? 'The task ended before a response was recorded.' : `A ${tab} payload is not available for this event.`}</p></div>)}
        </>}
    </section>
  </aside>;
}

function TraceSummary({ event, detail, run, now, onView }: {
  event: RunEvent; detail: TraceDetail | null; run: Run; now: number; onView: (tab: InspectorTab) => void;
}) {
  const trace = event.trace;
  const source = eventSource(event);
  return <div className="trace-summary">
    <dl className="trace-properties"><div><dt>Kind</dt><dd><span className={`trace-kind-badge kind-${eventKind(event)}`}>{kindLabels[eventKind(event)]}</span></dd></div><div><dt>Source</dt><dd>{source || 'Not recorded'}</dd></div><div><dt>Duration</dt><dd>{durationLabel(eventDuration(event, now, activeRun(run)))}</dd></div><div><dt>Turn / step</dt><dd>{trace ? `${trace.turn} / ${trace.step}` : 'Not recorded'}</dd></div>{trace?.model && <div className="property-full"><dt>Model</dt><dd>{trace.model}</dd></div>}{trace?.url && <div className="property-full"><dt>Endpoint</dt><dd className="trace-endpoint"><span>{trace.method || 'REQUEST'}</span><code>{trace.url}</code><TraceCopy value={trace.url} label="Copy endpoint" /></dd></div>}{trace?.httpStatus !== undefined && <div><dt>HTTP status</dt><dd className={trace.httpStatus >= 400 ? 'trace-text-error' : ''}>{trace.httpStatus}</dd></div>}{trace?.usage && <><div><dt>Input tokens</dt><dd>{trace.usage.inputTokens.toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>{trace.usage.outputTokens.toLocaleString()}</dd></div></>}</dl>
    {trace?.error && <div className="trace-recorded-error"><CircleX size={14} /><p>{trace.error}</p></div>}
    {event.message && <div className="trace-summary-message"><h4>Recorded message</h4><p>{event.message}</p></div>}
    {detail?.request !== undefined && <PayloadExcerpt label="Request" value={detail.request} onView={() => onView('request')} />}
    {detail?.response !== undefined && <PayloadExcerpt label="Response" value={detail.response} onView={() => onView('response')} />}
    {event.data && Object.keys(event.data).length > 0 && <details className="trace-compact-metadata"><summary>Event metadata<ChevronDown size={13} /></summary><pre>{stringify(event.data)}</pre></details>}
    <div className="trace-event-identity"><span>Event ID</span><code>{event.id}</code><TraceCopy value={event.id} label="Copy event ID" /></div>
  </div>;
}

function PayloadExcerpt({ label, value, onView }: { label: string; value: unknown; onView: () => void }) {
  const text = stringify(value);
  return <div className="trace-payload-excerpt"><div><h4>{label}</h4><button onClick={onView}>View full {label.toLowerCase()}<ArrowRight size={11} /></button></div><pre>{text.slice(0, 600)}{text.length > 600 ? '\n…' : ''}</pre>{text.length > 600 && <span>Preview · first 600 characters</span>}</div>;
}

function TraceTiming({ event, run, now, onSelectEvent }: { event: RunEvent; run: Run; now: number; onSelectEvent: (id: string) => void }) {
  const trace = event.trace;
  const parent = trace?.parentId ? run.events.find(item => item.id === trace.parentId) : undefined;
  return <div className="trace-timing-details"><h4>Transaction timing</h4><dl className="trace-timing-properties"><div><dt>Started</dt><dd>{trace ? formatTime(trace.startedAt) : 'Not recorded'}</dd></div><div><dt>Finished</dt><dd>{trace?.endedAt ? formatTime(trace.endedAt) : trace && event.status === 'running' && activeRun(run) ? 'In progress' : 'Not recorded'}</dd></div><div><dt>Duration</dt><dd>{durationLabel(eventDuration(event, now, activeRun(run)))}</dd></div><div><dt>Event recorded</dt><dd>{formatTime(event.at)}</dd></div>{trace && <div><dt>Start offset</dt><dd>{durationLabel(dateMs(trace.startedAt) - dateMs(run.createdAt))} from run start</dd></div>}{trace?.toolCallId && <div><dt>Tool call ID</dt><dd>{trace.toolCallId}</dd></div>}</dl>{parent && <div className="trace-parent"><span>Parent transaction</span><button onClick={() => onSelectEvent(parent.id)}><CornerDownRight size={13} />{parent.title}<ArrowRight size={12} /></button></div>}{trace?.startedAt && <p className="trace-absolute-time">{trace.startedAt}{trace.endedAt ? ` → ${trace.endedAt}` : ''}</p>}{!trace && <p className="trace-detail-note-text">No transaction timing was recorded for this event. Its event timestamp is preserved above.</p>}</div>;
}

function TraceCopy({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await copyText(value); setState('copied'); } catch { setState('failed'); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2200);
  }
  return <button className={`trace-copy ${state}`} onClick={() => void copy()} aria-label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label} title={state === 'copied' ? 'Copied' : state === 'failed' ? 'Clipboard unavailable in this browser' : label}>{state === 'copied' ? <Check size={13} /> : state === 'failed' ? <CircleX size={13} /> : <Copy size={13} />}</button>;
}

function PayloadViewer({ value, name, wrap, onWrap }: { value: unknown; name: string; wrap: boolean; onWrap: () => void }) {
  const raw = useMemo(() => stringify(value), [value]);
  const bytes = useMemo(() => new TextEncoder().encode(raw).length, [raw]);
  const lines = raw.split('\n').length;
  return <div className="trace-payload-viewer"><div className="trace-payload-toolbar"><span>{typeof value === 'string' ? 'TEXT' : 'JSON'}<span>·</span>{lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'}<span>·</span>{bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`}</span><div><button className={`trace-wrap ${wrap ? 'active' : ''}`} onClick={onWrap} aria-label={wrap ? 'Disable line wrapping' : 'Enable line wrapping'} aria-pressed={wrap} title={wrap ? 'Disable line wrapping' : 'Enable line wrapping'}><WrapText size={14} /></button><TraceCopy value={raw} label={`Copy ${name}`} /></div></div><pre className={`trace-payload-code ${wrap ? 'wrap' : ''}`} tabIndex={0} aria-label={`${name} payload`}><code>{typeof value !== 'string' && raw.length <= 100_000 ? <HighlightedJson text={raw} /> : raw}</code></pre></div>;
}

function HighlightedJson({ text }: { text: string }) {
  const parts = useMemo(() => {
    const tokens = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;
    const result: { text: string; kind?: string }[] = [];
    let offset = 0;
    for (const match of text.matchAll(tokens)) {
      if (match.index! > offset) result.push({ text: text.slice(offset, match.index) });
      result.push({ text: match[0], kind: match[1] ? 'key' : match[2] ? 'string' : match[3] ? 'literal' : 'number' });
      offset = match.index! + match[0].length;
    }
    if (offset < text.length) result.push({ text: text.slice(offset) });
    return result;
  }, [text]);
  return <>{parts.map((part, index) => part.kind ? <span key={index} className={`json-${part.kind}`}>{part.text}</span> : <Fragment key={index}>{part.text}</Fragment>)}</>;
}
