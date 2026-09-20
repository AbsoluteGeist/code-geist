import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationDetail, ConversationEvent, Run } from '../shared/types.js';
import { applyConversationEvent, mergeConversationRun, reconcileConversationSnapshot } from '../src/conversation-client.js';

const at = '2026-09-21T00:00:00.000Z';
function fixture(): ConversationDetail {
  const run: Run = {
    id: 'run', conversationId: 'conversation', turnIndex: 1, title: 'Fix it', task: 'Fix it',
    mode: 'live', status: 'running', phase: 'plan', createdAt: at, updatedAt: at,
    repository: '/repo', testCommand: 'npm test', maxSteps: 12, step: 1,
    files: [], diff: '', chatMessages: [],
    metrics: { modelCalls: 1, toolCalls: 0, jevCalls: 0, inputTokens: 0, outputTokens: 0 },
    events: [{ id: 'call', at, title: 'Model', type: 'model', status: 'running', trace: {
      kind: 'model', source: 'live', turn: 1, step: 1, startedAt: at,
      hasRequest: true, hasResponse: false, hasSchema: true,
    } }],
  };
  return {
    conversation: { id: 'conversation', title: 'Fix it', mode: 'live', repository: '/repo', testCommand: 'npm test', maxSteps: 12, createdAt: at, updatedAt: at, runIds: ['run'], activeRunId: 'run', status: 'running' },
    runs: [run], lastSeq: 0,
  };
}
function delta(seq: number, text: string, replace = false): ConversationEvent {
  return { seq, at, conversationId: 'conversation', runId: 'run', type: 'message.delta', data: { callId: 'call', delta: text, replace } };
}

test('assistant chunks append once and cumulative replacements do not duplicate prior content', () => {
  const first = applyConversationEvent(fixture(), delta(1, 'Hello'));
  assert.equal(applyConversationEvent(first, delta(1, 'Hello')), first);
  const second = applyConversationEvent(first, delta(2, ' world'));
  const third = applyConversationEvent(second, delta(3, 'Hello world!', true));
  assert.equal(third.runs[0].chatMessages?.[0].content, 'Hello world!');
  assert.equal(third.runs[0].chatMessages?.length, 1);
  assert.equal(third.lastSeq, 3);
  assert.equal(first.runs[0].chatMessages?.[0].content, 'Hello');
});

test('a recovered snapshot supplies missed chunks before buffered deltas are appended', () => {
  const beforeGap = applyConversationEvent(fixture(), delta(1, 'A'));
  const snapshot = applyConversationEvent(beforeGap, delta(2, 'B'));
  const recovered = reconcileConversationSnapshot(beforeGap, snapshot, [delta(3, 'C'), delta(3, 'C')]);
  assert.equal(recovered.detail.runs[0].chatMessages?.[0].content, 'ABC');
  assert.equal(recovered.detail.lastSeq, 3);
  assert.deepEqual(recovered.pending, []);
  const stillMissing = reconcileConversationSnapshot(beforeGap, beforeGap, [delta(3, 'C')]);
  assert.equal(stillMissing.detail.runs[0].chatMessages?.[0].content, 'A');
  assert.equal(stillMissing.pending.length, 1);
});

test('final snapshots reconcile streamed content and stale HTTP replies cannot rewind a running turn', () => {
  const partial = applyConversationEvent(fixture(), delta(1, 'Part'));
  const final = { ...partial.runs[0], status: 'completed' as const, updatedAt: '2026-09-21T00:00:02.000Z', chatMessages: [{ id: 'call', content: 'Final', createdAt: at, finished: true }] };
  const complete = applyConversationEvent(partial, { seq: 2, at, conversationId: 'conversation', runId: 'run', type: 'run.snapshot', data: { run: final } });
  assert.equal(complete.runs[0].chatMessages?.[0].content, 'Final');
  assert.equal(complete.runs[0].chatMessages?.[0].finished, true);
  assert.equal(mergeConversationRun(complete, fixture().runs[0]), complete);
  const queued = { ...fixture().runs[0], status: 'queued' as const };
  assert.equal(mergeConversationRun(partial, queued), partial);
});

test('tool output stays bounded and clearly marked, and live timing/usage update the actual call', () => {
  const output: ConversationEvent = { seq: 1, at, conversationId: 'conversation', runId: 'run', type: 'tool.output.delta', data: { callId: 'call', delta: 'x'.repeat(25000) } };
  const streamed = applyConversationEvent(fixture(), output);
  assert.equal(String(streamed.runs[0].events[0].data?.liveOutput).length, 24000);
  assert.equal(streamed.runs[0].events[0].data?.liveOutputTruncated, true);
  const measured = applyConversationEvent(streamed, { ...output, seq: 2, type: 'usage.updated', data: { callId: 'call', firstTokenAt: at, ttftMs: 230, usage: { inputTokens: 12, outputTokens: 8, reported: true } } });
  assert.equal(measured.runs[0].events[0].trace?.ttftMs, 230);
  assert.equal(measured.runs[0].events[0].trace?.usage?.outputTokens, 8);
});
