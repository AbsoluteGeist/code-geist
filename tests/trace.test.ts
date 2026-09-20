import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Run } from '../shared/types.js';
import { createTraceRecorder, readTraceDetail, redactTraceValue } from '../server/trace.js';
import { RunStore } from '../server/store.js';

function fixture(): Run {
  return {
    id: randomUUID(), title: 'Trace fixture', task: 'Fix a bug', mode: 'demo', status: 'running', phase: 'inspect',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repository: 'demo', testCommand: 'node --test',
    maxSteps: 24, step: 1, events: [], files: [], diff: '',
    metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
  };
}

test('trace payloads retain complete bodies on disk, redact credentials, and keep snapshots compact', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geist-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = fixture();
  const updates: string[] = [];
  const recorder = createTraceRecorder(run, directory, () => { updates.push(run.events.at(-1)!.status!); });
  const secret = 'trace-test-private-credential';
  const longBody = 'implementation\n'.repeat(9_000) + 'COMPLETE_PAYLOAD_TAIL';
  const request = { headers: { Authorization: `Bearer ${secret}` }, body: {
    messages: [{ role: 'user', content: longBody }],
    tool_calls: [{ function: { arguments: JSON.stringify({ password: 'unknown-password', content: longBody }) } }],
  } };
  const id = await recorder.start({ type: 'model', title: 'Coding request', trace: { kind: 'model', source: 'live', turn: 1, step: 1, model: 'fixture-model' }, request, schema: { tools: [{ name: 'write_file' }] }, secrets: [secret] });
  const pending = await readTraceDetail(directory, run, id);
  assert.equal(pending.event.status, 'running');
  assert.equal(pending.response, undefined);
  await recorder.finish(id, { status: 'success', httpStatus: 200, response: {
    headers: { 'set-cookie': 'session=private' },
    body: { content: longBody, reasoning_content: 'Provider-supplied continuation content', echoed: `credential=${secret}` },
  }, usage: { inputTokens: 20, outputTokens: 10 } });
  assert.equal(run.events.length, 1, 'One request stays one row throughout its lifecycle');
  assert.deepEqual(updates, ['running', 'success']);
  assert.ok(run.events[0].trace!.durationMs! >= 0);
  assert.equal(run.events[0].trace!.httpStatus, 200);
  assert.ok(JSON.stringify(run).length < 3000, 'Snapshots must not duplicate large payloads');
  const detail = await readTraceDetail(directory, run, id);
  const requestBody = detail.request as typeof request;
  assert.equal(requestBody.body.messages[0].content, longBody);
  assert.equal(requestBody.headers.Authorization, '[REDACTED]');
  assert.equal(JSON.parse(requestBody.body.tool_calls[0].function.arguments).password, '[REDACTED]');
  const response = detail.response as { body: { content: string; reasoning_content: string } };
  assert.equal(response.body.content, longBody);
  assert.equal(response.body.reasoning_content, 'Provider-supplied continuation content');
  const disk = await readFile(path.join(directory, 'traces', run.id, `${id}.json`), 'utf8');
  assert.ok(!disk.includes(secret));
  assert.ok(!disk.includes('unknown-password'));
  assert.ok(!disk.includes('session=private'));
  assert.equal(request.headers.Authorization, `Bearer ${secret}`, 'Logging must not mutate the actual request');
});

test('credential redaction preserves token counts and user data with similar field names', () => {
  const value = { apiKey: 'private', access_token: 'private', input_tokens: 100, passwordPolicy: 'min length 12', text: 'Bearer private-token', body: '{"client_secret":"nested-private","code":"const value = 1;"}' };
  const safe = redactTraceValue(value);
  assert.equal(safe.apiKey, '[REDACTED]');
  assert.equal(safe.access_token, '[REDACTED]');
  assert.equal(safe.input_tokens, 100);
  assert.equal(safe.passwordPolicy, 'min length 12');
  assert.equal(JSON.parse(safe.body).code, 'const value = 1;');
  assert.ok(!JSON.stringify(safe).includes('nested-private'));
});

test('redaction preserves harmless JSON and code strings byte for byte, including duplicate keys and large integers', () => {
  const source = '{\n  "duplicate": 1,\n  "duplicate": 2,\n  "large": 9007199254740993123456789,\n  "decimal": 1.2300e+004,\n  "escaped": "\\u0061\\/b",\n  "negativeZero": -0\n}\n';
  const nested = `{ "arguments" : ${JSON.stringify(source)}, "keepSpacing" : true }\n`;
  const code = '{\n  const obj = { "name": "fixture" };\n  return obj;\n}\n';
  const input = { content: source, encoded: nested, code };
  assert.deepEqual(redactTraceValue(input), input);
});

test('redaction changes only sensitive JSON value spans while preserving surrounding source text', () => {
  const source = '{\n  "duplicate": 1,\n  "duplicate": 2,\n  "large": 9007199254740993123456789,\n  "pass\\u0077ord"  :  "private-password",\n  "nested": { "api_key" : ["key-one", {"private": "key-two"}], "keep": 1.2300e+004 },\n  "escaped": "\\u0061\\/b"\n}\n';
  const expected = source.replace('"private-password"', '"[REDACTED]"').replace('["key-one", {"private": "key-two"}]', '"[REDACTED]"');
  assert.equal(redactTraceValue({ content: source }).content, expected);
  const outer = `{ "arguments" : ${JSON.stringify(source)}, "duplicate": 1, "duplicate": 2 }`;
  assert.equal(redactTraceValue(outer), outer.replace(JSON.stringify(source), JSON.stringify(expected)));
  const truncated = '{ "large": 9007199254740993123456789, "password" : "partial-private';
  assert.equal(redactTraceValue(truncated), '{ "large": 9007199254740993123456789, "password" : "[REDACTED]"');
});

test('configured secrets are masked in object keys, JSON keys, escaped strings, and embedded source', () => {
  const key = 'trace-private-"quote\\slash\nline';
  const escaped = JSON.stringify(key).slice(1, -1);
  const jsonText = `{\n  ${JSON.stringify(key)} : "diagnostic",\n  "echo" : ${JSON.stringify(key)},\n  "large": 9007199254740993123456789\n}\n`;
  const code = `const credential = "${escaped}";\n`;
  const input = { [key]: { text: key }, jsonText, code };
  const safe = redactTraceValue(input, [key]);
  assert.deepEqual((safe as Record<string, unknown>)['[REDACTED]'], { text: '[REDACTED]' });
  assert.equal(safe.jsonText, '{\n  "[REDACTED]" : "diagnostic",\n  "echo" : "[REDACTED]",\n  "large": 9007199254740993123456789\n}\n');
  assert.equal(safe.code, 'const credential = "[REDACTED]";\n');
  assert(!JSON.stringify(safe).includes(escaped));
  const unicodeSecret = 'trace-dummy-key';
  const unicodeJSON = '{ "echo": "trace-dummy-\\u006bey", "trace-dummy-\\u006bey": "diagnostic" }';
  assert.equal(redactTraceValue(unicodeJSON, [unicodeSecret]), '{ "echo": "[REDACTED]", "[REDACTED]": "diagnostic" }');
  assert.equal(input[key].text, key, 'Redaction must not modify the live input.');
});

test('legacy and interrupted runs remain inspectable without inventing response bodies', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geist-trace-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = fixture();
  const store = new RunStore(directory);
  await store.initialize();
  const recorder = createTraceRecorder(run, directory, () => store.save(run));
  const id = await recorder.start({ type: 'tool', title: 'run_tests', trace: { kind: 'tool', source: 'harness', turn: 1, step: 2 }, request: { command: 'node --test' } });
  const reopened = new RunStore(directory);
  await reopened.initialize();
  const restored = reopened.runs.get(run.id)!;
  const detail = await readTraceDetail(directory, restored, id);
  assert.equal(detail.event.status, 'error');
  assert.match(detail.event.trace!.error!, /restart/);
  assert.equal(detail.response, undefined);
  run.events.push({ id: 'legacy-event', at: run.createdAt, type: 'tool', title: 'read_file', data: { args: { path: 'old.ts' }, result: 'Old saved result' } });
  const legacy = await readTraceDetail(directory, run, 'legacy-event');
  assert.match(legacy.note!, /summary event/);
  assert.equal(legacy.response, 'Old saved result');
  await assert.rejects(readTraceDetail(directory, run, '../escape'), /not found/);

  const cancelled = fixture();
  const pendingRecorder = createTraceRecorder(cancelled, directory, () => store.save(cancelled));
  const pendingId = await pendingRecorder.start({ type: 'model', title: 'Pending request', trace: { kind: 'model', source: 'live', turn: 1, step: 1 }, request: { model: 'fixture' } });
  cancelled.status = 'cancelled';
  await store.save(cancelled);
  const afterCancellation = new RunStore(directory);
  await afterCancellation.initialize();
  const cancelledRun = afterCancellation.runs.get(cancelled.id)!;
  assert.equal(cancelledRun.status, 'cancelled');
  const cancelledDetail = await readTraceDetail(directory, cancelledRun, pendingId);
  assert.equal(cancelledDetail.event.status, 'error');
  assert.equal(cancelledDetail.response, undefined);
});
