import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run, RunEvent } from '../shared/types.js';
import { aggregateUsage } from '../shared/metrics.js';

test('usage counts each reported request once and keeps cached/reasoning subsets separate', () => {
  const call: RunEvent = { id: 'model', at: '2026-09-21T00:00:00Z', type: 'model', title: 'model', status: 'success', trace: {
    kind: 'model', source: 'live', turn: 1, step: 1, method: 'POST', startedAt: '2026-09-21T00:00:00Z', durationMs: 1200,
    ttftMs: 200, generationMs: 1000, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 80, reasoningTokens: 20, reported: true },
    hasRequest: true, hasResponse: true, hasSchema: true,
  } };
  const jev: RunEvent = { ...call, id: 'jev', type: 'jev', trace: { ...call.trace!, kind: 'jev', usage: { inputTokens: 10, outputTokens: 2, reported: true } } };
  const unknown: RunEvent = { ...call, id: 'unknown', trace: { ...call.trace!, usage: undefined, ttftMs: undefined, generationMs: undefined } };
  const run = { id: 'run', status: 'completed', step: 2, events: [call, call, jev, unknown], metrics: { modelCalls: 2, jevCalls: 1, toolCalls: 0, inputTokens: 110, outputTokens: 52 } } as Run;
  const usage = aggregateUsage([run]);
  assert.equal(usage.inputTokens, 110);
  assert.equal(usage.outputTokens, 52);
  assert.equal(usage.cachedInputTokens, 80);
  assert.equal(usage.reasoningTokens, 20);
  assert.equal(usage.cacheHitRate, 0.8);
  assert.equal(usage.ttftMs, 200);
  assert.equal(usage.tokensPerSecond, 50);
  assert.equal(usage.unreportedCalls, 1);
  assert.equal(usage.reportedCalls, 2);
  assert.equal(usage.modelCalls, 2);
});

test('demo and missing usage display unknown rather than fabricated token or cache counts', () => {
  const run = { id: 'demo', status: 'completed', step: 9, events: [], metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 9, inputTokens: 0, outputTokens: 0 } } as unknown as Run;
  const usage = aggregateUsage([run]);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.cacheHitRate, null);
  assert.equal(usage.tokensPerSecond, null);
  assert.equal(usage.turns, 1);
  assert.equal(usage.steps, 9);
});
