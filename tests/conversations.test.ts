import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import type { ConversationDetail, ConversationEvent, Run } from '../shared/types.js';

test('conversation queues followups, resumes the same turn, replays events and survives restart', { timeout: 25_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geist-conversation-'));
  const instance = await createApp({ dataDir: directory });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await instance.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (route: string, body: unknown) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  const initial = await post('/api/conversations', { mode: 'demo', maxSteps: 6 }) as ConversationDetail;
  const conversationId = initial.conversation.id;
  const firstId = initial.runs[0].id;
  const followup = { content: 'Document the game controls.', clientMessageId: 'followup-idempotent', maxSteps: 12 };
  const queued = await post(`/api/conversations/${conversationId}/messages`, followup) as Run;
  assert.equal(queued.turnIndex, 2);
  assert.equal(queued.status, 'queued');
  const duplicate = await post(`/api/conversations/${conversationId}/messages`, followup) as Run;
  assert.equal(duplicate.id, queued.id);
  const get = async () => await (await fetch(`${base}/api/conversations/${conversationId}`)).json() as ConversationDetail;
  const waitFor = async (predicate: (detail: ConversationDetail) => boolean) => {
    for (let i = 0; i < 160; i++) {
      const detail = await get();
      if (predicate(detail)) return detail;
      await delay(50);
    }
    throw new Error('Conversation did not reach the expected state.');
  };
  await waitFor(detail => detail.runs[0].status === 'budget_exhausted' && !detail.conversation.activeRunId);
  const continuation = { additionalSteps: 6, clientRequestId: 'resume-idempotent' };
  await post(`/api/runs/${firstId}/resume`, continuation);
  const repeated = await post(`/api/runs/${firstId}/resume`, continuation) as Run;
  assert.equal(repeated.maxSteps, 12);
  assert.equal(repeated.turnIndex, 1);
  const completed = await waitFor(detail => detail.runs.length === 2 && detail.runs.every(run => run.status === 'completed') && !detail.conversation.activeRunId);
  assert.equal(completed.runs[0].workspace, completed.runs[1].workspace);
  assert.equal(completed.runs[0].branch, completed.runs[1].branch);
  assert.ok(completed.runs.every(run => run.verification?.passed));
  assert.ok(completed.runs[1].diff.includes('Document the game controls.'));
  assert.ok(completed.runs[1].events.filter(event => event.trace).every(event => event.trace?.turn === 2));
  assert.ok(completed.runs[0].chatMessages?.length);

  const events = instance.conversations.replay(conversationId, 0);
  assert.ok(events.some(event => event.type === 'message.delta'));
  assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq));
  const replayAfter = Math.max(1, completed.lastSeq - 3);
  const stream = await fetch(`${base}/api/conversations/${conversationId}/events`, { headers: { 'Last-Event-ID': String(replayAfter) } });
  const reader = stream.body!.getReader();
  let contents = '';
  while (!contents.includes(`id: ${completed.lastSeq}\n`)) {
    const next = await reader.read();
    if (next.done) break;
    contents += new TextDecoder().decode(next.value);
  }
  await reader.cancel();
  const received = contents.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as ConversationEvent);
  assert.ok(received.length >= 3);
  assert.ok(received.every(event => event.seq > replayAfter));

  await post(`/api/conversations/${conversationId}/messages`, { content: 'Explain the current files.', clientMessageId: 'discussion-id', intent: 'discussion' });
  const answered = await waitFor(detail => detail.runs.length === 3 && detail.runs[2].status === 'completed' && !detail.conversation.activeRunId);
  assert.equal(answered.runs[2].workspace, completed.runs[0].workspace);
  assert.equal(answered.runs[2].diff, completed.runs[1].diff);
  await instance.close();
  const reopened = await createApp({ dataDir: directory });
  const restored = await reopened.conversations.detail(conversationId);
  assert.equal(restored.runs.length, 3);
  assert.deepEqual(restored.runs.map(run => run.chatMessages), answered.runs.map(run => run.chatMessages));
  assert.ok(restored.lastSeq > answered.lastSeq, 'Restart recovery is journaled for reconnecting clients');
  await reopened.close();
});

test('cancelled queued turns do not lose workspace inheritance and untouched queue survives restart', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geist-queue-restart-'));
  const instance = await createApp({ dataDir: directory, execute: async (run, options) => {
    run.status = 'running';
    run.workspace ??= path.join(directory, 'retained');
    run.baseCommit ??= 'fixture-base';
    await options.onUpdate();
    if (run.turnIndex === 1 && !options.resume && !options.signal.aborted) {
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    run.status = options.signal.aborted ? 'cancelled' : 'completed';
    run.resumable = options.signal.aborted;
    await options.onUpdate();
  } });
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  const detail = await instance.conversations.create({ mode: 'demo' });
  const id = detail.conversation.id;
  const first = detail.runs[0];
  const cancelled = await instance.conversations.send(id, { content: 'cancel this queued request', clientMessageId: 'cancel-queued-id' });
  await instance.conversations.cancel(cancelled.id);
  const pending = await instance.conversations.send(id, { content: 'keep this queued request', clientMessageId: 'keep-queued-id' });
  await instance.close();
  // Recover a syntactically valid last journal record that lost its final newline.
  const journal = path.join(directory, 'conversations', `${id}.jsonl`);
  await writeFile(journal, (await readFile(journal, 'utf8')).trimEnd());
  const inherited: Array<{ id: string; previous?: string; workspace?: string }> = [];
  const reopened = await createApp({ dataDir: directory, execute: async (run, options) => {
    inherited.push({ id: run.id, previous: options.previousRunId, workspace: run.workspace });
    run.status = 'completed';
    await options.onUpdate();
  } });
  try {
    assert.equal(reopened.store.runs.get(pending.id)?.status, 'queued');
    assert.equal(reopened.store.runs.get(cancelled.id)?.status, 'cancelled');
    await reopened.conversations.resume(first.id, 6, 'continue-after-restart');
    for (let i = 0; i < 100 && reopened.store.runs.get(pending.id)?.status !== 'completed'; i++) await delay(10);
    assert.equal(reopened.store.runs.get(pending.id)?.status, 'completed');
    const next = inherited.find(item => item.id === pending.id)!;
    assert.equal(next.previous, first.id, 'Untouched cancelled queue entries must not replace the workspace owner');
    assert.equal(next.workspace, path.join(directory, 'retained'));
    await reopened.close();
    const records = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.every((record, i) => !i || record.seq > records[i - 1].seq));
  } finally { await reopened.close(); }
});
