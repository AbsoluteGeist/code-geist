import type { ConversationDetail, ConversationEvent, Run } from '../shared/types';

export function clientRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function mergeConversationRun(detail: ConversationDetail, run: Run): ConversationDetail {
  const existing = detail.runs.find(item => item.id === run.id);
  if (existing && (existing.updatedAt > run.updatedAt || (existing.updatedAt === run.updatedAt && existing.status !== 'queued' && run.status === 'queued'))) return detail;
  const runs = [...detail.runs.filter(item => item.id !== run.id), run]
    .sort((left, right) => (left.turnIndex ?? Infinity) - (right.turnIndex ?? Infinity) || left.createdAt.localeCompare(right.createdAt));
  return {
    ...detail,
    runs,
    conversation: {
      ...detail.conversation,
      runIds: runs.map(item => item.id),
      updatedAt: run.updatedAt > detail.conversation.updatedAt ? run.updatedAt : detail.conversation.updatedAt,
    },
  };
}

/** Apply each streamed update once. A complete server snapshot reconciles final content. */
export function applyConversationEvent(detail: ConversationDetail, update: ConversationEvent): ConversationDetail {
  if (update.conversationId !== detail.conversation.id || update.seq <= detail.lastSeq) return detail;
  let next = { ...detail, lastSeq: update.seq };
  if (update.type === 'conversation.updated' && update.data.conversation) {
    return { ...next, conversation: update.data.conversation };
  }
  if (update.type === 'run.snapshot' && update.data.run) {
    return mergeConversationRun(next, update.data.run);
  }
  if (!update.runId || !update.data.callId) return next;
  next = {
    ...next,
    runs: next.runs.map(run => {
      if (run.id !== update.runId) return run;
      if (update.data.firstTokenAt !== undefined || update.data.ttftMs !== undefined || update.data.usage !== undefined) {
        run = {
          ...run,
          events: run.events.map(event => event.id === update.data.callId && event.trace ? {
            ...event,
            trace: {
              ...event.trace,
              ...(update.data.firstTokenAt !== undefined ? { firstTokenAt: update.data.firstTokenAt } : {}),
              ...(update.data.ttftMs !== undefined ? { ttftMs: update.data.ttftMs } : {}),
              ...(update.data.usage !== undefined ? { usage: update.data.usage } : {}),
            },
          } : event),
        };
      }
      if (update.type === 'message.delta') {
        const messages = [...(run.chatMessages ?? [])];
        const index = messages.findIndex(message => message.id === update.data.callId);
        const previous = index >= 0 ? messages[index] : {
          id: update.data.callId!, content: '', createdAt: update.at, finished: false,
        };
        const message = {
          ...previous,
          content: update.data.replace ? update.data.delta ?? '' : previous.content + (update.data.delta ?? ''),
          finished: false,
        };
        if (index >= 0) messages[index] = message; else messages.push(message);
        return { ...run, chatMessages: messages };
      }
      if (update.type === 'tool.output.delta') {
        return {
          ...run,
          events: run.events.map(event => {
            if (event.id !== update.data.callId && event.trace?.toolCallId !== update.data.callId) return event;
            const prior = typeof event.data?.liveOutput === 'string' ? event.data.liveOutput : '';
            const output = update.data.replace ? update.data.delta ?? '' : prior + (update.data.delta ?? '');
            return { ...event, data: { ...event.data, liveOutput: output.slice(-24_000), liveOutputTruncated: Boolean(event.data?.liveOutputTruncated) || output.length > 24_000 } };
          }),
        };
      }
      return run;
    }),
  };
  return next;
}

/** Recover a gap without appending deltas to an incomplete assistant response. */
export function reconcileConversationSnapshot(current: ConversationDetail | null, snapshot: ConversationDetail, buffered: ConversationEvent[]) {
  let detail = current?.conversation.id === snapshot.conversation.id && current.lastSeq > snapshot.lastSeq ? current : snapshot;
  const pending: ConversationEvent[] = [];
  for (const update of [...buffered].sort((a, b) => a.seq - b.seq)) {
    if (update.conversationId !== detail.conversation.id || update.seq <= detail.lastSeq) continue;
    if (update.seq > detail.lastSeq + 1) { pending.push(update); continue; }
    detail = applyConversationEvent(detail, update);
  }
  return { detail, pending };
}
