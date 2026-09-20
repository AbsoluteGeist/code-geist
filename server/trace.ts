import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EventType, Run, RunEvent, TraceDetail, TraceMetadata, TracePayload, TokenUsage } from '../shared/types.js';
import { getModelConfiguration, loadModelProfiles } from './model-config.js';

export interface TraceStart {
  type: EventType;
  title: string;
  message?: string;
  data?: Record<string, unknown>;
  trace: Pick<TraceMetadata, 'kind' | 'source' | 'turn' | 'step'> & Partial<Pick<TraceMetadata, 'parentId' | 'toolCallId' | 'method' | 'url' | 'model'>>;
  request?: unknown;
  schema?: unknown;
  secrets?: string[];
}

export interface TraceFinish {
  status: 'success' | 'error';
  response?: unknown;
  error?: string;
  message?: string;
  httpStatus?: number;
  usage?: TokenUsage;
  firstTokenAt?: string;
  ttftMs?: number;
  generationMs?: number;
  data?: Record<string, unknown>;
}

function configuredSecrets(): string[] {
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH)/i.test(name))
    .map(([, value]) => value!);
  try {
    for (const profile of loadModelProfiles()) {
      if (profile.configured) secrets.push(getModelConfiguration(profile.id).apiKey);
    }
  } catch { /* Invalid model configuration is reported by the caller, never echoed here. */ }
  return secrets.filter(Boolean);
}

const sensitiveField = /^(?:authorization|proxy-authorization|cookie|set-cookie|(?:x[-_])?(?:api[-_]?key|auth[-_]?token)|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|secret|client[-_]?secret)$/i;

/** Redact copies only. The live model request/response is never mutated. */
export function redactTraceValue<T>(value: T, additionalSecrets: string[] = []): T {
  const secrets = [...new Set([...configuredSecrets(), ...additionalSecrets].filter(Boolean))].sort((a, b) => b.length - a.length);
  const spellings = [...new Set(secrets.flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  const redactPlainString = (source: string): string => {
    let text = source;
    for (const secret of spellings) text = text.split(secret).join('[REDACTED]');
    text = text.replace(/\bBearer\s+[^\s"'<>;,}]+/gi, 'Bearer [REDACTED]');
    return text;
  };

  const quotedEnd = (text: string, start: number): number => {
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === '\\') index++;
      else if (text[index] === '"') return index + 1;
    }
    return text.length;
  };
  const valueEnd = (text: string, start: number): number => {
    if (text[start] === '"') return quotedEnd(text, start);
    if (text[start] === '{' || text[start] === '[') {
      let nesting = 0;
      for (let index = start; index < text.length; index++) {
        const character = text[index];
        if (character === '"') index = quotedEnd(text, index) - 1;
        else if (character === '{' || character === '[') nesting++;
        else if ((character === '}' || character === ']') && --nesting === 0) return index + 1;
      }
      return text.length;
    }
    let end = start;
    while (end < text.length && !/[\s,}\]]/.test(text[end])) end++;
    return end;
  };

  const redactString = (source: string, depth: number): string => {
    if (depth >= 40 || !/^\s*[\[{]/.test(source)) return redactPlainString(source);
    // Replace only credential spans. Parsing/re-serializing a whole JSON string would
    // destroy source formatting, duplicate keys, escape spellings, and integer precision.
    const strings = /"(?:\\[\s\S]|[^"\\])*"/g;
    const replacements: { start: number; end: number; text: string }[] = [];
    for (const match of source.matchAll(strings)) {
      const start = match.index;
      const end = start + match[0].length;
      let decoded: string;
      try { decoded = JSON.parse(match[0]) as string; } catch { continue; }
      let colon = end;
      while (/\s/.test(source[colon] ?? '') && colon < source.length) colon++;
      const isKey = source[colon] === ':';
      const safe = isKey ? redactPlainString(decoded) : redactString(decoded, depth + 1);
      if (safe !== decoded) replacements.push({ start, end, text: JSON.stringify(safe) });
      if (isKey && sensitiveField.test(decoded)) {
        let begin = colon + 1;
        while (/\s/.test(source[begin] ?? '') && begin < source.length) begin++;
        const finish = valueEnd(source, begin);
        if (finish > begin) replacements.push({ start: begin, end: finish, text: '"[REDACTED]"' });
      }
    }
    let cursor = 0;
    const parts: string[] = [];
    for (const replacement of replacements) {
      // A sensitive object/array value already covers its nested tokens.
      if (replacement.start < cursor) continue;
      parts.push(source.slice(cursor, replacement.start), replacement.text);
      cursor = replacement.end;
    }
    parts.push(source.slice(cursor));
    return redactPlainString(parts.join(''));
  };
  const walk = (current: unknown, depth = 0): unknown => {
    if (typeof current === 'string') return redactString(current, depth);
    if (Array.isArray(current)) return current.map(item => walk(item, depth + 1));
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [redactPlainString(key), sensitiveField.test(key) ? '[REDACTED]' : walk(item, depth + 1)]));
    }
    return current;
  };
  return walk(value) as T;
}

function payloadPath(dataDir: string, runId: string, eventId: string): string {
  if (![runId, eventId].every(id => /^[a-zA-Z0-9_-]+$/.test(id))) throw new Error('Invalid trace identifier.');
  return path.resolve(dataDir, 'traces', runId, `${eventId}.json`);
}

async function writePayload(dataDir: string, runId: string, eventId: string, payload: TracePayload) {
  const filename = payloadPath(dataDir, runId, eventId);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(`${filename}.tmp`, JSON.stringify(payload), { mode: 0o600 });
  await rename(`${filename}.tmp`, filename);
}

function compactPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const messagePreview = (value: unknown) => {
    if (!value || typeof value !== 'object') return value;
    const message = value as Record<string, unknown>;
    return {
      role: message.role,
      content: message.content,
      tools: Array.isArray(message.tool_calls) ? message.tool_calls.map(call => call?.function?.name) : undefined,
    };
  };
  let preview: unknown = value;
  if (value && typeof value === 'object') {
    const envelope = value as Record<string, unknown>;
    const body = envelope.body ?? value;
    if (body && typeof body === 'object') {
      const object = body as Record<string, unknown>;
      if (Array.isArray(object.messages)) preview = { model: object.model, message: messagePreview(object.messages.at(-1)) };
      else if (Array.isArray(object.choices)) preview = messagePreview(object.choices[0]?.message);
      else preview = body;
    } else preview = body;
  }
  const text = typeof preview === 'string' ? preview : JSON.stringify(preview);
  return text?.replace(/\s+/g, ' ').slice(0, 180);
}

export function createTraceRecorder(run: Run, dataDir: string, onUpdate: () => Promise<void> | void) {
  const active = new Map<string, { started: number; payload: TracePayload; secrets: string[] }>();
  return {
    async start(input: TraceStart): Promise<string> {
      const id = randomUUID();
      const started = performance.now();
      const at = new Date().toISOString();
      const secrets = input.secrets ?? [];
      const payload = redactTraceValue({ request: input.request, schema: input.schema }, secrets);
      const event: RunEvent = redactTraceValue({
        id, at, type: input.type, title: input.title, message: input.message,
        data: { requestPreview: compactPreview(payload.request), ...input.data },
        status: 'running',
        trace: {
          ...input.trace, startedAt: at,
          hasRequest: input.request !== undefined,
          hasResponse: false,
          hasSchema: input.schema !== undefined,
        },
      }, secrets);
      await writePayload(dataDir, run.id, id, payload);
      active.set(id, { started, payload, secrets });
      run.events.push(event);
      run.updatedAt = at;
      await onUpdate();
      return id;
    },
    async finish(id: string, input: TraceFinish): Promise<void> {
      const pending = active.get(id);
      const event = run.events.find(item => item.id === id);
      if (!pending || !event?.trace) return;
      const safe = redactTraceValue(input, pending.secrets);
      const endedAt = new Date().toISOString();
      const payload = { ...pending.payload, ...(safe.response !== undefined ? { response: safe.response } : {}) };
      await writePayload(dataDir, run.id, id, payload);
      event.status = safe.status;
      if (safe.message !== undefined) event.message = safe.message;
      event.data = { ...event.data, responsePreview: compactPreview(safe.response), ...safe.data };
      Object.assign(event.trace, {
        endedAt, durationMs: Math.max(0, Math.round(performance.now() - pending.started)),
        hasResponse: safe.response !== undefined, error: safe.error,
        httpStatus: safe.httpStatus, usage: safe.usage,
        firstTokenAt: safe.firstTokenAt, ttftMs: safe.ttftMs, generationMs: safe.generationMs,
      });
      active.delete(id);
      run.updatedAt = endedAt;
      await onUpdate();
    },
  };
}

export type TraceRecorder = ReturnType<typeof createTraceRecorder>;

export async function readTraceDetail(dataDir: string, run: Run, eventId: string): Promise<TraceDetail> {
  const event = run.events.find(item => item.id === eventId);
  if (!event) throw new Error('Trace event not found.');
  if (!event.trace) {
    const note = run.events.some(item => item.trace)
      ? 'This is a lifecycle or summary event. Detailed request/response payloads are recorded on the related call events.'
      : 'This run predates detailed tracing. Only the originally recorded information is available.';
    return redactTraceValue({ event, request: event.data?.args, response: event.data?.result ?? event.data, note });
  }
  try {
    const payload = JSON.parse(await readFile(payloadPath(dataDir, run.id, event.id), 'utf8')) as TracePayload;
    return redactTraceValue({ event, ...payload });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { event, note: 'The detail file is unavailable. The recorded event metadata is still shown.' };
  }
}
