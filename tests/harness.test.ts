import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Run } from '../shared/types.js';
import { DEMO_TASK, prepareDemoWorkspace } from '../server/demo.js';
import { executeRun } from '../server/harness.js';
import { executeTool, type ToolContext } from '../server/tools.js';
import { writeWorkspaceFile } from '../server/workspace.js';

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
