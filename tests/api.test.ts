import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { RunStore } from '../server/store.js';
import type { Run } from '../shared/types.js';

test('API rejects cross-site requests, validates inputs, and persists completed real demo', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codegeist-api-'));
  const instance = await createApp({ dataDir });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await instance.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${base}/api/config`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'invalid' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'live', task: 'Fix bug', repository: 'relative', testCommand: 'node --test' }) })).status, 400);

  const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'demo' }) });
  assert.equal(response.status, 201);
  const initial = await response.json() as Run;
  const stream = await fetch(`${base}/api/runs/${initial.id}/events`);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: Run | undefined;
  const timeout = setTimeout(() => reader.cancel(), 25_000);
  try {
    while (!completed) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop()!;
      for (const part of parts) {
        const data = part.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const snapshot = JSON.parse(data.slice(6)) as Run;
        if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) completed = snapshot;
      }
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }
  assert.ok(completed, 'SSE should deliver a terminal run');
  assert.equal(completed.status, 'completed', completed.error ?? 'Demo should complete');
  assert.equal(completed.verification?.passed, true);
  assert.equal(completed.verification?.exitCode, 0);
  assert.ok(completed.events.some(event => event.type === 'verification' && event.data?.passed === false), 'Demo must reproduce failing tests before repair');
  assert.ok(completed.diff.includes('slugify'));
  assert.ok(completed.files.length > 0);
  assert.equal((await (await fetch(`${base}/api/runs/${initial.id}/patch`)).text()), completed.diff);

  const traced = completed.events.find(event => event.trace?.hasRequest);
  assert.ok(traced, 'New runs must record inspectable trace payloads');
  const detailResponse = await fetch(`${base}/api/runs/${initial.id}/events/${traced.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.event.id, traced.id);
  assert.ok(detail.request);
  assert.equal((await fetch(`${base}/api/runs/${initial.id}/events/not-found`)).status, 404);
  const exportResponse = await fetch(`${base}/api/runs/${initial.id}/trace`);
  assert.match(exportResponse.headers.get('content-type') ?? '', /application\/x-ndjson/);
  const records = (await exportResponse.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, completed.events.length);
  assert.equal(records.find(record => record.event.id === traced.id).event.trace.kind, traced.trace!.kind);

  const restored = new RunStore(dataDir);
  await restored.initialize();
  assert.equal(restored.runs.get(initial.id)?.status, 'completed');
  assert.ok(restored.runs.get(initial.id)?.events.length);
});

test('cancellation interrupts a run, and concurrent execution is rejected', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codegeist-cancel-'));
  const instance = await createApp({ dataDir, execute: async (run, options) => {
    run.status = 'running';
    await options.onUpdate();
    if (!options.signal.aborted) await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    run.status = 'cancelled';
    await options.onUpdate();
  } });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await instance.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const post = () => fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'demo' }) });
  const initial = await (await post()).json() as Run;
  assert.equal((await post()).status, 409);
  const cancelled = await (await fetch(`${base}/api/runs/${initial.id}/cancel`, { method: 'POST' })).json() as Run;
  assert.equal(cancelled.status, 'cancelled');
});

test('unfinished persisted runs are marked interrupted on restart', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'codegeist-restart-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new RunStore(dataDir);
  await store.initialize();
  const run: Run = {
    id: 'abcdef12-1234', title: 'Interrupted task', task: 'Fix', mode: 'demo', status: 'running', phase: 'edit',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repository: 'demo',
    testCommand: 'node --test', maxSteps: 24, step: 3, events: [], files: [], diff: '',
    metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
  };
  await store.save(run);
  const reopened = new RunStore(dataDir);
  await reopened.initialize();
  assert.equal(reopened.runs.get(run.id)?.status, 'interrupted');
  assert.match(reopened.runs.get(run.id)?.error ?? '', /restarted/);
});
