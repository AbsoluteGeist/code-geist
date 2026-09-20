import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeRun } from '../server/harness.js';
import { DEMO_FIX, DEMO_TASK, prepareDemoWorkspace } from '../server/demo.js';
import { readCheckpoint, reconcilePendingTools, saveCheckpoint, type Checkpoint } from '../server/checkpoint.js';
import { workspaceDiff } from '../server/workspace.js';
import type { Run, RuntimeUpdate } from '../shared/types.js';

function fixture(id: string): Run {
  return { id, conversationId: 'conversation', turnIndex: 1, title: 'Fix slugify', task: DEMO_TASK, mode: 'demo', status: 'queued', phase: 'prepare', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repository: '', testCommand: 'node --test', maxSteps: 20, step: 0, events: [], files: [], diff: '', metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 } };
}

test('budget continuation and a later user turn keep the same workspace and exact checkpoint context', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-checkpoint-'));
  const run = fixture('first');
  run.maxSteps = 3;
  try {
    await executeRun(run, { dataDir: temp, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(run.status, 'budget_exhausted');
    assert.equal(run.resumable, true);
    const workspace = run.workspace;
    const checkpoint = await readCheckpoint(temp, run.id);
    assert.equal(checkpoint?.demoCursor, 3);
    assert.equal((await stat(path.join(temp, 'checkpoints', 'first.json'))).mode & 0o777, 0o600);
    const eventIds = run.events.map(event => event.id);
    run.maxSteps = 20;
    await executeRun(run, { dataDir: temp, resume: true, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(run.status, 'completed', run.error ?? 'Resumed demo should complete');
    assert.equal(run.workspace, workspace);
    assert.equal(run.metrics.toolCalls, 9, 'Completed tools must not be replayed');
    assert.equal(run.step, 9);
    assert.deepEqual(run.events.slice(0, eventIds.length).map(event => event.id), eventIds);
    assert.ok(run.events.filter(event => event.trace).every(event => event.trace!.turn === 1));
    const steps = run.events.filter(event => event.trace).map(event => event.trace!.step);
    assert.equal(new Set(steps).size, steps.length);

    const followup = fixture('second');
    followup.turnIndex = 2;
    followup.task = 'Document that this is the second turn.';
    const updates: RuntimeUpdate[] = [];
    await executeRun(followup, { dataDir: temp, previousRunId: run.id, signal: new AbortController().signal, onUpdate() {}, onEvent(event) { updates.push(event); } });
    assert.equal(followup.status, 'completed', followup.error ?? 'Follow-up should complete');
    assert.equal(followup.workspace, workspace);
    assert.equal(followup.branch, run.branch);
    assert.equal(followup.step, 4);
    assert.ok(followup.events.filter(event => event.trace).every(event => event.trace!.turn === 2));
    assert.match(await readFile(path.join(workspace!, 'README.md'), 'utf8'), /second turn/);
    assert.ok(updates.some(event => event.type === 'message.delta'));
    assert.ok(updates.some(event => event.type === 'tool.output.delta'));
    assert.equal(followup.metrics.inputTokens, 0, 'Scripted demo has no fabricated model usage');
    const next = await readCheckpoint(temp, followup.id);
    assert.ok(next!.messages.length > checkpoint!.messages.length);
    assert.ok(next!.messages.some(message => message.role === 'user' && message.content?.includes('second turn')));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('resume closes uncertain tools without replay and preserves private provider fields', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-pending-'));
  const run = fixture('pending');
  const oldFetch = globalThis.fetch;
  const oldConfig = process.env.CODEGEIST_MODELS_FILE;
  const oldKey = process.env.GEIST_CHECKPOINT_KEY;
  try {
    await prepareDemoWorkspace(run, temp, new AbortController().signal);
    run.mode = 'live';
    run.intent = 'discussion';
    run.step = 1;
    run.setupCommand = 'node -e "require(\'fs\').writeFileSync(\'unexpected-setup\',\'bad\')"';
    const call = { id: 'uncertain-write', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"must-not-exist.txt","content":"do not replay"}' } };
    const fingerprint = (await workspaceDiff(run.workspace!, run.baseCommit!)).fingerprint;
    await saveCheckpoint(temp, { version: 1, runId: run.id, workspace: run.workspace!, baseCommit: run.baseCommit!, branch: run.branch, revision: 0, fingerprint, modelIteration: 1, messages: [
      { role: 'system', content: 'Original system' }, { role: 'user', content: 'Original request' },
      { role: 'assistant', content: null, reasoning_content: 'private-provider-continuation', tool_calls: [call] },
    ], pendingTools: [{ call, state: 'started' }], demoCursor: 0, demoFollowup: false, setupComplete: false, updatedAt: new Date().toISOString() });
    process.env.GEIST_CHECKPOINT_KEY = 'checkpoint-api-key-not-for-persistence';
    process.env.CODEGEIST_MODELS_FILE = path.join(temp, 'models.json');
    await writeFile(process.env.CODEGEIST_MODELS_FILE, JSON.stringify({ defaultModel: 'test', models: [{ id: 'test', name: 'Test model', model: 'fixture', baseURL: 'http://checkpoint.invalid/v1', apiKeyEnv: 'GEIST_CHECKPOINT_KEY' }] }));
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'The earlier write was interrupted. Its outcome must be checked before continuing code changes.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
    };
    await executeRun(run, { dataDir: temp, resume: true, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(run.status, 'completed', run.error ?? 'Discussion should finish without a diff');
    await assert.rejects(access(path.join(run.workspace!, 'must-not-exist.txt')));
    await assert.rejects(access(path.join(run.workspace!, 'unexpected-setup')));
    assert.ok(run.events.some(event => event.title === 'Previous setup outcome is unknown'));
    const body = JSON.stringify(requestBody);
    assert.match(body, /private-provider-continuation/);
    assert.match(body, /outcome is unknown/);
    assert.match(body, /\[Harness budget\]/);
    assert.match(body, /workspace revision/);
    const tools = requestBody!.tools as Array<{ function: { name: string } }>;
    assert.ok(tools.every(tool => !['write_file', 'run_tests'].includes(tool.function.name)));
    const checkpointText = await readFile(path.join(temp, 'checkpoints', `${run.id}.json`), 'utf8');
    assert.match(checkpointText, /private-provider-continuation/);
    assert.ok(!checkpointText.includes(process.env.GEIST_CHECKPOINT_KEY));
    assert.ok(!JSON.stringify(run).includes('private-provider-continuation'));
    assert.equal((await readCheckpoint(temp, run.id))!.pendingTools.length, 0);

    // A human edit between attempts invalidates earlier successful verification.
    await writeFile(path.join(run.workspace!, 'README.md'), '# Edited outside the agent\n');
    run.intent = 'coding';
    run.maxSteps = run.step + 1;
    run.verification = { command: run.testCommand, exitCode: 0, output: 'Earlier verification', passed: true, revision: 0, at: new Date().toISOString() };
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'premature-finish', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }] } }] }), { headers: { 'content-type': 'application/json' } });
    await executeRun(run, { dataDir: temp, resume: true, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(run.status, 'budget_exhausted');
    assert.equal(run.revision, 1);
    assert.equal(run.verification.revision, 0);
    assert.ok(run.events.some(event => event.trace?.kind === 'tool' && event.status === 'error' && event.trace.error?.includes('changed after the last verification')));

    await writeFile(process.env.CODEGEIST_MODELS_FILE, JSON.stringify({ defaultModel: 'other', models: [{ id: 'other', name: 'Other provider', model: 'other-model', baseURL: 'http://other-checkpoint.invalid/v1', apiKeyEnv: 'GEIST_CHECKPOINT_KEY' }] }));
    const followup = fixture('changed-model');
    followup.mode = 'live';
    followup.intent = 'discussion';
    followup.turnIndex = 2;
    followup.modelId = 'other';
    followup.task = 'Explain the current changes.';
    let switchedRequest = '';
    globalThis.fetch = async (_input, init) => {
      switchedRequest = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'The current change updates the README.', reasoning_content: 'new-provider-private-state' } }] }), { headers: { 'content-type': 'application/json' } });
    };
    await executeRun(followup, { dataDir: temp, previousRunId: run.id, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(followup.status, 'completed');
    assert.ok(!switchedRequest.includes('private-provider-continuation'));
    assert.match(switchedRequest, /uncertain-write/);
    assert.match(switchedRequest, /outcome is unknown/);
    assert.ok(followup.events.some(event => event.title === 'Adapted previous model context'));
    const switchedCheckpoint = await readCheckpoint(temp, followup.id);
    assert.equal(switchedCheckpoint!.modelId, 'other');
    assert.ok(switchedCheckpoint!.messages.some(message => message.reasoning_content === 'new-provider-private-state'));

    const legacy = { ...fixture('legacy'), mode: 'live' as const, intent: 'discussion' as const, task: 'Explain the retained README change.', workspace: run.workspace, branch: run.branch, baseCommit: run.baseCommit };
    await executeRun(legacy, { dataDir: temp, resume: true, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(legacy.status, 'completed');
    assert.match(switchedRequest, /Explain the retained README change/);
    assert.match(switchedRequest, /Fresh context recovered from retained workspace/);
    assert.match(switchedRequest, /Edited outside the agent/);
    assert.ok(legacy.events.some(event => event.title === 'Recovering retained workspace'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldConfig === undefined) delete process.env.CODEGEIST_MODELS_FILE; else process.env.CODEGEIST_MODELS_FILE = oldConfig;
    if (oldKey === undefined) delete process.env.GEIST_CHECKPOINT_KEY; else process.env.GEIST_CHECKPOINT_KEY = oldKey;
    await rm(temp, { recursive: true, force: true });
  }
});

test('saved tool results are reused once, including provider IDs repeated in older turns', () => {
  const call = { id: 'same-id', type: 'function' as const, function: { name: 'run_tests', arguments: '{}' } };
  const checkpoint = { messages: [
    { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'old result' },
    { role: 'assistant', content: null, tool_calls: [call] },
  ], pendingTools: [{ call, state: 'result_saved', result: { output: 'new saved result', finished: false } }] } as Checkpoint;
  assert.equal(reconcilePendingTools(checkpoint), 0);
  assert.equal(checkpoint.messages.at(-1)?.content, 'new saved result');
  const length = checkpoint.messages.length;
  assert.equal(reconcilePendingTools(checkpoint), 0);
  assert.equal(checkpoint.messages.length, length);
});

test('Ask defers setup until the first Code turn and successful setup runs only once', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-setup-transition-'));
  const source = fixture('setup-source');
  const oldFetch = globalThis.fetch;
  const oldConfig = process.env.CODEGEIST_MODELS_FILE;
  const oldKey = process.env.GEIST_CHECKPOINT_KEY;
  try {
    await prepareDemoWorkspace(source, temp, new AbortController().signal);
    process.env.GEIST_CHECKPOINT_KEY = 'setup-fixture-key';
    process.env.CODEGEIST_MODELS_FILE = path.join(temp, 'models.json');
    await writeFile(process.env.CODEGEIST_MODELS_FILE, JSON.stringify({ defaultModel: 'test', models: [{ id: 'test', name: 'Test model', model: 'fixture', baseURL: 'http://setup.invalid/v1', apiKeyEnv: 'GEIST_CHECKPOINT_KEY' }] }));
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { tools: Array<{ function: { name: string } }> };
      const coding = body.tools.some(tool => tool.function.name === 'write_file');
      const message = coding ? { role: 'assistant', content: null, tool_calls: [
        { id: 'write-source', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/slugify.js', content: DEMO_FIX }) } },
        { id: 'verify', type: 'function', function: { name: 'run_tests', arguments: '{}' } },
        { id: 'finish', type: 'function', function: { name: 'finish', arguments: '{"summary":"Fixed and verified the slugify utility."}' } },
      ] } : { role: 'assistant', content: 'The repository contains a slugify utility and its tests.' };
      return new Response(JSON.stringify({ choices: [{ finish_reason: coding ? 'tool_calls' : 'stop', message }] }), { headers: { 'content-type': 'application/json' } });
    };
    const setupCode = "const f=require('node:fs');const p='setup-count.txt';f.writeFileSync(p,String(f.existsSync(p)?Number(f.readFileSync(p,'utf8'))+1:1));";
    const ask = { ...fixture('setup-ask'), mode: 'live' as const, intent: 'discussion' as const, repository: source.workspace!, setupCommand: `node -e "${setupCode}"` };
    await executeRun(ask, { dataDir: temp, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(ask.status, 'completed', ask.error ?? 'Ask should complete');
    await assert.rejects(access(path.join(ask.workspace!, 'setup-count.txt')));
    assert.equal((await readCheckpoint(temp, ask.id))!.setupState, 'not_started');
    const code = { ...fixture('setup-code'), mode: 'live' as const, intent: 'coding' as const, turnIndex: 2, repository: source.workspace!, setupCommand: ask.setupCommand };
    await executeRun(code, { dataDir: temp, previousRunId: ask.id, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(code.status, 'completed', code.error ?? 'Code should complete');
    assert.equal(code.workspace, ask.workspace);
    assert.equal(await readFile(path.join(code.workspace!, 'setup-count.txt'), 'utf8'), '1');
    assert.equal((await readCheckpoint(temp, code.id))!.setupState, 'completed');
    const again = { ...fixture('setup-again'), mode: 'live' as const, intent: 'coding' as const, turnIndex: 3, repository: source.workspace!, setupCommand: ask.setupCommand };
    await executeRun(again, { dataDir: temp, previousRunId: code.id, signal: new AbortController().signal, onUpdate() {} });
    assert.equal(again.status, 'completed');
    assert.equal(await readFile(path.join(again.workspace!, 'setup-count.txt'), 'utf8'), '1');
    assert.ok(!again.events.some(event => event.trace?.kind === 'setup'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldConfig === undefined) delete process.env.CODEGEIST_MODELS_FILE; else process.env.CODEGEIST_MODELS_FILE = oldConfig;
    if (oldKey === undefined) delete process.env.GEIST_CHECKPOINT_KEY; else process.env.GEIST_CHECKPOINT_KEY = oldKey;
    await rm(temp, { recursive: true, force: true });
  }
});
