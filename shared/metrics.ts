import type { Run, TraceMetadata } from './types.js';

export interface UsageSummary {
  turns: number;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  jevCalls: number;
  modelMs: number;
  toolMs: number;
  jevMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  cacheHitRate: number | null;
  cacheCoverage: number;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  reportedCalls: number;
  unreportedCalls: number;
  activeCalls: number;
  byKind: { model: { inputTokens: number; outputTokens: number }; jev: { inputTokens: number; outputTokens: number } };
}

/** Authoritative request totals are counted once per call ID; cached/reasoning are subsets. */
export function aggregateUsage(runs: Run[], now = Date.now()): UsageSummary {
  const result: UsageSummary = {
    turns: runs.filter(run => run.status !== 'queued').length, steps: 0,
    modelCalls: 0, toolCalls: 0, jevCalls: 0, modelMs: 0, toolMs: 0, jevMs: 0,
    inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null,
    cacheHitRate: null, cacheCoverage: 0, ttftMs: null, tokensPerSecond: null,
    reportedCalls: 0, unreportedCalls: 0, activeCalls: 0,
    byKind: { model: { inputTokens: 0, outputTokens: 0 }, jev: { inputTokens: 0, outputTokens: 0 } },
  };
  const seen = new Set<string>();
  let cacheInput = 0, generationMs = 0, generatedTokens = 0, ttftTotal = 0, ttftCount = 0;
  const duration = (trace: TraceMetadata, running: boolean) => trace.durationMs ?? (running ? Math.max(0, now - Date.parse(trace.startedAt)) : 0);
  for (const run of runs) {
    result.steps += run.step;
    const calls = run.events.filter(event => event.trace);
    if (!calls.length) {
      result.modelCalls += run.metrics.modelCalls;
      result.jevCalls += run.metrics.jevCalls;
      result.toolCalls += run.metrics.toolCalls;
      if (run.metrics.inputTokens + run.metrics.outputTokens > 0) {
        result.inputTokens = (result.inputTokens ?? 0) + run.metrics.inputTokens;
        result.outputTokens = (result.outputTokens ?? 0) + run.metrics.outputTokens;
      }
      continue;
    }
    for (const event of calls) {
      const key = `${run.id}/${event.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const trace = event.trace!;
      const running = run.status === 'running' && event.status === 'running';
      const ms = duration(trace, running);
      if (trace.kind === 'tool' || trace.kind === 'setup') {
        result.toolCalls++;
        // Jev children are reported separately instead of double-counting their time as tool execution.
        const childMs = calls.filter(child => child.trace?.parentId === event.id && child.trace.kind === 'jev')
          .reduce((sum, child) => sum + duration(child.trace!, running && child.status === 'running'), 0);
        result.toolMs += Math.max(0, ms - childMs);
      }
      if (!trace.method || (trace.kind !== 'model' && trace.kind !== 'jev')) continue;
      if (trace.kind === 'model') { result.modelCalls++; result.modelMs += ms; }
      else { result.jevCalls++; result.jevMs += ms; }
      if (running) result.activeCalls++;
      if (trace.kind === 'model' && trace.ttftMs !== undefined) { ttftTotal += trace.ttftMs; ttftCount++; }
      if (!trace.usage || trace.usage.reported === false) {
        if (!running) result.unreportedCalls++;
        continue;
      }
      result.reportedCalls++;
      const usage = trace.usage;
      result.inputTokens = (result.inputTokens ?? 0) + usage.inputTokens;
      result.outputTokens = (result.outputTokens ?? 0) + usage.outputTokens;
      result.byKind[trace.kind].inputTokens += usage.inputTokens;
      result.byKind[trace.kind].outputTokens += usage.outputTokens;
      if (usage.reasoningTokens !== undefined) result.reasoningTokens = (result.reasoningTokens ?? 0) + usage.reasoningTokens;
      if (trace.kind === 'model' && usage.cachedInputTokens !== undefined) {
        result.cachedInputTokens = (result.cachedInputTokens ?? 0) + usage.cachedInputTokens;
        cacheInput += usage.inputTokens;
        result.cacheCoverage++;
      }
      if (trace.kind === 'model' && trace.generationMs && trace.generationMs > 0 && !running) {
        generationMs += trace.generationMs;
        generatedTokens += usage.outputTokens;
      }
    }
  }
  result.cacheHitRate = cacheInput > 0 ? Math.min(1, (result.cachedInputTokens ?? 0) / cacheInput) : null;
  result.ttftMs = ttftCount ? ttftTotal / ttftCount : null;
  result.tokensPerSecond = generationMs > 0 ? generatedTokens * 1000 / generationMs : null;
  return result;
}
