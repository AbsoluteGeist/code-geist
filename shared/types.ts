export type RunMode = 'demo' | 'live';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'budget_exhausted' | 'interrupted';
export type RunPhase = 'prepare' | 'inspect' | 'plan' | 'edit' | 'verify' | 'complete';
export type EventType = 'phase' | 'model' | 'tool' | 'jev' | 'verification' | 'error' | 'summary' | 'input';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reported?: boolean;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface ChatMessageView {
  id: string;
  content: string;
  createdAt: string;
  finished: boolean;
}

export interface RuntimeUpdate {
  type: 'message.delta' | 'tool.output.delta' | 'usage.updated';
  callId: string;
  delta?: string;
  replace?: boolean;
  usage?: TokenUsage;
  firstTokenAt?: string;
  ttftMs?: number;
}

export interface TraceMetadata {
  kind: 'input' | 'model' | 'jev' | 'tool' | 'setup';
  source: 'live' | 'demo' | 'fallback' | 'harness';
  turn: number;
  step: number;
  parentId?: string;
  toolCallId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  method?: string;
  url?: string;
  httpStatus?: number;
  model?: string;
  error?: string;
  usage?: TokenUsage;
  firstTokenAt?: string;
  ttftMs?: number;
  generationMs?: number;
  hasRequest: boolean;
  hasResponse: boolean;
  hasSchema: boolean;
}

export interface TraceDetail {
  event: RunEvent;
  request?: unknown;
  response?: unknown;
  schema?: unknown;
  note?: string;
}

/** Server-side payload shape; full bodies are stored separately from live run snapshots. */
export interface TracePayload {
  request?: unknown;
  response?: unknown;
  schema?: unknown;
}

export interface RunEvent {
  id: string;
  at: string;
  type: EventType;
  title: string;
  message?: string;
  status?: 'running' | 'success' | 'error' | 'info';
  data?: Record<string, unknown>;
  trace?: TraceMetadata;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted';
}

export interface Verification {
  command: string;
  exitCode: number | null;
  output: string;
  passed: boolean;
  at: string;
  revision: number;
}

export interface Run {
  id: string;
  conversationId?: string;
  turnIndex?: number;
  clientMessageId?: string;
  chatMessages?: ChatMessageView[];
  resumable?: boolean;
  attempt?: number;
  resumeRequestIds?: string[];
  intent?: 'coding' | 'discussion';
  title: string;
  task: string;
  mode: RunMode;
  modelId?: string;
  modelName?: string;
  status: RunStatus;
  phase: RunPhase;
  createdAt: string;
  updatedAt: string;
  repository: string;
  workspace?: string;
  branch?: string;
  baseCommit?: string;
  testCommand: string;
  setupCommand?: string;
  maxSteps: number;
  step: number;
  revision?: number;
  events: RunEvent[];
  files: ChangedFile[];
  diff: string;
  verification?: Verification;
  summary?: string;
  error?: string;
  metrics: { modelCalls: number; jevCalls: number; toolCalls: number; inputTokens: number; outputTokens: number };
}

export interface CreateRunInput {
  mode: RunMode;
  modelId?: string;
  task?: string;
  repository?: string;
  testCommand?: string;
  setupCommand?: string;
  maxSteps?: number;
  intent?: 'coding' | 'discussion';
}

export interface AppConfig {
  modelConfigured: boolean;
  jevConfigured: boolean;
  model: string;
  jevModel: string;
  defaultRepository: string;
  demoTask: string;
  models: ModelProfile[];
  configurationError?: string;
}

export interface ModelProfile {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  description: string;
  configured: boolean;
  streaming?: boolean;
  streamUsage?: boolean;
}

export type RunSummary = Omit<Run, 'events' | 'diff'>;

export interface Conversation {
  id: string;
  title: string;
  mode: RunMode;
  repository: string;
  testCommand: string;
  setupCommand?: string;
  modelId?: string;
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  activeRunId?: string;
  status: 'idle' | 'running' | 'needs_attention';
}

export interface ConversationDetail {
  conversation: Conversation;
  runs: Run[];
  lastSeq: number;
}

export interface ConversationEvent {
  seq: number;
  at: string;
  conversationId: string;
  runId?: string;
  type: RuntimeUpdate['type'] | 'run.snapshot' | 'conversation.updated';
  data: { run?: Run; conversation?: Conversation; callId?: string; delta?: string; replace?: boolean; usage?: TokenUsage; firstTokenAt?: string; ttftMs?: number };
}

export interface SendMessageInput {
  content: string;
  clientMessageId: string;
  modelId?: string;
  maxSteps?: number;
  intent?: 'coding' | 'discussion';
}
