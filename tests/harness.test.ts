import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Run } from '../shared/types.js';
import { DEMO_TASK, DEMO_STEPS, DEMO_FIX, prepareDemoWorkspace } from '../server/demo.js';
import { executeRun } from '../server/harness.js';
import { executeTool, type ToolContext } from '../server/tools.js';
import { writeWorkspaceFile } from '../server/workspace.js';
import { readTraceDetail } from '../server/trace.js';

function fixture(id: string): Run {
  return { id, title: 'Fix slugify', task: DEMO_TASK, mode: 'demo', status: 'queued', phase: 'prepare', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repository: '', testCommand: 'node --test', maxSteps: 20, step: 0, events: [], files: [], diff: '', metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 } };
}

test('demo runs real failing tests, edits code, and finishes with passing evidence', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-demo-'));
  const run = fixture('demo');
  let updates = 0;
  try {
    await executeRun(run, { dataDir: temp, signal: new AbortController().signal, onUpdate: () => { updates++; } });
    assert.equal(run.status, 'completed', run.error ?? 'Demo should complete');
    assert.equal(run.verification?.passed, true);
    assert.match(run.verification!.output, /pass 6/);
    assert.ok(run.events.some(event => event.type === 'verification' && event.status === 'error'));
    assert.ok(run.events.some(event => event.type === 'verification' && event.status === 'success'));
    assert.equal(run.files.length, 2);
    assert.match(run.diff, /normalize\('NFD'\)/);
    assert.equal(run.metrics.modelCalls, 0);
    assert.equal(run.metrics.jevCalls, 0);
    assert.equal(run.metrics.toolCalls, 9);
    assert.ok(updates > 20);
    const traced = run.events.filter(event => event.trace);
    assert.ok(traced.length > 20);
    assert.ok(traced.every(event => event.status !== 'running' && event.trace?.endedAt && typeof event.trace.durationMs === 'number'));
    assert.ok(traced.every(event => event.trace!.turn >= 1 && event.trace!.step >= 1));
    for (const tool of traced.filter(event => event.trace?.kind === 'tool')) {
      assert.ok(tool.trace!.toolCallId);
      assert.equal(run.events.find(event => event.id === tool.trace!.parentId)?.trace?.kind, 'model');
    }
    assert.ok(traced.filter(event => event.trace?.source === 'demo').every(event => !event.trace!.httpStatus && !event.trace!.url));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a hard step limit leaves a task failed and never claims completion', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-budget-'));
  const run = fixture('budget');
  run.maxSteps = 2;
  try {
    await executeRun(run, { dataDir: temp, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(run.status, 'failed');
    assert.match(run.error!, /Step budget exhausted/);
    assert.equal(run.step, 2);
    assert.equal(run.summary, undefined);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('cancellation persists a cancelled terminal state', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-harness-cancel-'));
  const run = fixture('cancel');
  const controller = new AbortController();
  try {
    await executeRun(run, { dataDir: temp, signal: controller.signal, onUpdate() {
      if (run.events.at(-1)?.title === 'Workspace ready') controller.abort();
    } });
    assert.equal(run.status, 'cancelled');
    assert.equal(run.events.at(-1)?.title, 'Run cancelled');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('finish gates reject empty, failing, and stale revisions', async () => {
  const run = fixture('gates');
  run.workspace = os.tmpdir();
  const context: ToolContext = {
    run, revision: 2, signal: new AbortController().signal, async syncDiff() {}, async emit() {}, async rankContext(candidates) { return candidates; }, async classifyFailure() { return 'unknown'; },
  };
  await assert.rejects(executeTool('finish', { summary: 'done' }, context), /no meaningful/);
  run.files = [{ path: 'source.js', additions: 1, deletions: 1, status: 'modified' }];
  await assert.rejects(executeTool('finish', { summary: 'done' }, context), /resolve failures/);
  run.verification = { command: 'node --test', exitCode: 0, output: 'passed', passed: true, at: '', revision: 1 };
  await assert.rejects(executeTool('finish', { summary: 'done' }, context), /changed after/);
  run.verification.revision = 2;
  assert.equal((await executeTool('finish', { summary: 'done' }, context)).finished, true);
  await assert.rejects(executeTool('run_tests', { command: 'echo bypass' }, context));
});

test('file reads expose pagination instead of silently losing content', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-read-'));
  const run = fixture('read');
  try {
    await prepareDemoWorkspace(run, temp, new AbortController().signal);
    await writeWorkspaceFile(run.workspace!, 'long.txt', Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n'));
    const context: ToolContext = {
      run, revision: 0, signal: new AbortController().signal, async syncDiff() {}, async emit() {}, async rankContext(candidates) { return candidates; }, async classifyFailure() { return 'unknown'; },
    };
    const first = JSON.parse((await executeTool('read_file', { path: 'long.txt' }, context)).output);
    assert.equal(first.truncated, true);
    assert.equal(first.nextStartLine, 401);
    const next = JSON.parse((await executeTool('read_file', { path: 'long.txt', startLine: 401 }, context)).output);
    assert.equal(next.endLine, 600);
    assert.equal(next.nextStartLine, null);
    assert.equal(`${first.content}\n${next.content}`, Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('trace details retain complete long tool requests and responses outside compact run events', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-trace-long-'));
  const run = fixture('trace-long');
  const marker = 'TRACE_PAYLOAD_END';
  const padding = `\n// ${'x'.repeat(32_000)}\n// ${marker}\n`;
  const writeStep = DEMO_STEPS.find(step => step.name === 'write_file' && step.args.path === 'src/slugify.js')!;
  const original = writeStep.args.content;
  writeStep.args.content = DEMO_FIX + padding;
  let prepared = false;
  try {
    await executeRun(run, { dataDir: temp, signal: new AbortController().signal, async onUpdate() {
      if (!prepared && run.events.at(-1)?.title === 'Workspace ready') {
        prepared = true;
        const source = await readFile(path.join(run.workspace!, 'src/slugify.js'), 'utf8');
        await writeWorkspaceFile(run.workspace!, 'src/slugify.js', source + padding);
      }
    } });
    assert.equal(run.status, 'completed', run.error ?? 'Long trace demo should complete');
    const read = run.events.find(event => event.type === 'tool' && event.data?.name === 'read_file' && (event.data.args as { path?: string } | undefined)?.path === 'src/slugify.js')!;
    const write = run.events.find(event => event.type === 'tool' && event.data?.name === 'write_file' && (event.data.args as { path?: string } | undefined)?.path === 'src/slugify.js')!;
    const readDetail = await readTraceDetail(temp, run, read.id);
    const writeDetail = await readTraceDetail(temp, run, write.id);
    assert.ok(JSON.stringify(readDetail.response).length > 30_000);
    assert.match(JSON.stringify(readDetail.response), new RegExp(marker));
    assert.match(JSON.stringify(writeDetail.request), new RegExp(marker));
    assert.ok(JSON.stringify(writeDetail.request).length > 30_000);
    assert.ok(JSON.stringify(read.data).length < 3_000);
    assert.ok(JSON.stringify(write.data).length < 3_000);
    assert.ok(writeDetail.schema);
  } finally {
    writeStep.args.content = original;
    await rm(temp, { recursive: true, force: true });
  }
});

test('cancelled tools preserve their invocation and close every started trace', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-trace-cancel-'));
  const run = fixture('trace-cancel');
  const controller = new AbortController();
  try {
    await executeRun(run, { dataDir: temp, signal: controller.signal, onUpdate() {
      const last = run.events.at(-1);
      if (last?.trace?.kind === 'tool' && last.status === 'running') controller.abort(new Error('Stopped from the test workbench'));
    } });
    assert.equal(run.status, 'cancelled');
    const tool = run.events.find(event => event.trace?.kind === 'tool')!;
    assert.equal(tool.status, 'error');
    assert.match(tool.trace!.error!, /cancelled/i);
    const detail = await readTraceDetail(temp, run, tool.id);
    assert.match(JSON.stringify(detail.request), /list_files/);
    assert.match(JSON.stringify(detail.response), /cancelled/);
    assert.ok(run.events.filter(event => event.trace).every(event => event.status !== 'running' && event.trace!.endedAt));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('cancelling an active verification retains stdout produced before the interruption', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-trace-output-'));
  const run = fixture('trace-partial-output');
  const controller = new AbortController();
  const marker = 'OUTPUT_BEFORE_CANCELLATION';
  const execution = executeRun(run, { dataDir: temp, signal: controller.signal, async onUpdate() {
    if (run.events.at(-1)?.title === 'Workspace ready') {
      await writeWorkspaceFile(run.workspace!, 'partial-output.cjs', `process.stdout.write('${marker}\\n', () => require('node:fs').writeFileSync('command.ready', 'ready')); setInterval(() => {}, 1000);\n`);
      run.testCommand = 'node partial-output.cjs';
    }
  } });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      if (run.workspace) {
        try { ready = (await readFile(path.join(run.workspace, 'command.ready'), 'utf8')) === 'ready'; } catch { /* The subprocess has not printed yet. */ }
      }
      if (ready) break;
      await delay(10);
    }
    controller.abort(new Error('User stopped verification after its first output'));
    await execution;
    assert.ok(ready, 'The subprocess must print real output before cancellation');
    assert.equal(run.status, 'cancelled');
    const tool = run.events.find(event => event.trace?.kind === 'tool' && event.data?.name === 'run_tests')!;
    assert.equal(tool.status, 'error');
    const detail = await readTraceDetail(temp, run, tool.id);
    assert.equal((detail.response as { cancelled: boolean }).cancelled, true);
    assert.match((detail.response as { output: string }).output, new RegExp(marker));
    assert.ok(run.events.filter(event => event.trace).every(event => event.status !== 'running'));
  } finally {
    controller.abort();
    await execution;
    await rm(temp, { recursive: true, force: true });
  }
});

test('malformed arguments and unknown tool calls have terminal error traces linked to the model turn', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-trace-errors-'));
  const source = fixture('source');
  const run = fixture('trace-errors');
  const previousFetch = globalThis.fetch;
  const previousConfig = process.env.CODEGEIST_MODELS_FILE;
  const previousKey = process.env.GEIST_TRACE_TEST_KEY;
  try {
    await prepareDemoWorkspace(source, temp, new AbortController().signal);
    run.mode = 'live';
    run.repository = source.workspace!;
    run.maxSteps = 1;
    run.setupCommand = 'node -e "process.stdout.write(\'setup trace complete\')"';
    process.env.GEIST_TRACE_TEST_KEY = 'trace-test-api-key';
    process.env.CODEGEIST_MODELS_FILE = path.join(temp, 'models.json');
    await writeFile(process.env.CODEGEIST_MODELS_FILE, JSON.stringify({ defaultModel: 'test', models: [{ id: 'test', name: 'Test model', model: 'fixture-model', baseURL: 'http://trace-provider.invalid/v1', apiKeyEnv: 'GEIST_TRACE_TEST_KEY' }] }));
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'broken-json', type: 'function', function: { name: 'read_file', arguments: '{' } },
      { id: 'missing-tool', type: 'function', function: { name: 'not_registered', arguments: '{}' } },
    ] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    await executeRun(run, { dataDir: temp, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(run.status, 'failed');
    const setup = run.events.find(event => event.trace?.kind === 'setup')!;
    assert.equal(setup.status, 'success');
    const setupDetail = await readTraceDetail(temp, run, setup.id);
    assert.match(JSON.stringify(setupDetail.request), /setup trace complete/);
    assert.match(JSON.stringify(setupDetail.response), /setup trace complete/);
    assert.ok(setupDetail.schema);
    const tools = run.events.filter(event => event.trace?.kind === 'tool');
    assert.equal(tools.length, 2);
    assert.ok(tools.every(event => event.status === 'error' && event.trace!.endedAt));
    assert.match(tools[0].trace!.error!, /Invalid tool arguments/);
    assert.match(tools[1].trace!.error!, /Unknown tool/);
    for (const tool of tools) assert.equal(run.events.find(event => event.id === tool.trace!.parentId)?.trace?.kind, 'model');
    const malformed = await readTraceDetail(temp, run, tools[0].id);
    assert.equal((malformed.request as { arguments: string }).arguments, '{');
    assert.ok(malformed.schema);
    assert.ok(run.events.filter(event => event.trace).every(event => event.status !== 'running'));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousConfig === undefined) delete process.env.CODEGEIST_MODELS_FILE; else process.env.CODEGEIST_MODELS_FILE = previousConfig;
    if (previousKey === undefined) delete process.env.GEIST_TRACE_TEST_KEY; else process.env.GEIST_TRACE_TEST_KEY = previousKey;
    await rm(temp, { recursive: true, force: true });
  }
});
