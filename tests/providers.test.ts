import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProvider, evaluateContext, evaluateFailure, routeModel, type ChatMessage, type ToolDefinition, type ProviderTraceObserver } from '../server/providers.js';
import { getDefaultModelId, getModelConfiguration, loadModelProfiles } from '../server/model-config.js';
import { createTraceRecorder, readTraceDetail } from '../server/trace.js';
import type { Run } from '../shared/types.js';

async function withEnv<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return await action();
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function mockHTTP<T>(handle: (request: IncomingMessage, response: ServerResponse, body: Record<string, any>) => void, action: (baseURL: string) => Promise<T>) {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk.toString();
    handle(request, response, raw ? JSON.parse(raw) : {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try { return await action(`http://127.0.0.1:${address.port}/v1`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function profiles<T>(baseURL: string, action: () => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'codegeist-providers-'));
  const file = join(directory, 'models.json');
  await writeFile(file, JSON.stringify({ defaultModel: 'deepseek', models: [
    { id: 'deepseek', name: 'DeepSeek', baseURL, model: 'deepseek-chat', apiKeyEnv: 'CG_TEST_DEEPSEEK_KEY', description: 'General code and tests' },
    { id: 'zhipu', name: 'Zhipu', baseURL, model: 'configured-glm', apiKeyEnv: 'CG_TEST_ZHIPU_KEY', description: 'Complex architecture and planning' },
  ] }));
  try {
    return await withEnv({
      CODEGEIST_MODELS_FILE: file,
      CG_TEST_DEEPSEEK_KEY: 'deepseek-secret', CG_TEST_ZHIPU_KEY: 'zhipu-secret',
      TYPESAFE_API_KEY: 'jev-secret', TYPESAFE_BASE_URL: baseURL, TYPESAFE_MODEL: 'jev-test',
    }, action);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('model profiles expose no API keys and support configurable endpoints, models, and default fallback', async () => {
  await profiles('https://example.test/compatible/v4/', async () => {
    const publicProfiles = loadModelProfiles();
    assert.equal(publicProfiles.length, 2);
    assert.equal(publicProfiles[1].baseURL, 'https://example.test/compatible/v4');
    assert.equal(publicProfiles[1].model, 'configured-glm');
    assert(!JSON.stringify(publicProfiles).includes('secret'));
    assert(!JSON.stringify(publicProfiles).includes('apiKey'));
    assert.equal(getDefaultModelId(), 'deepseek');
    assert.equal(getModelConfiguration('zhipu').apiKey, 'zhipu-secret');
    await withEnv({ CG_TEST_DEEPSEEK_KEY: undefined }, async () => {
      assert.equal(getDefaultModelId(), 'zhipu');
      assert.equal(getModelConfiguration().id, 'zhipu');
      assert.throws(() => getModelConfiguration('deepseek'), /no API key/);
    });
    assert.throws(() => getModelConfiguration('missing'), /does not exist/);
  });
});

test('OpenAI environment configuration requires an explicit model and never guesses one', async t => {
  const originalDirectory = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), 'codegeist-env-config-'));
  t.after(async () => {
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  });
  // The environment-only fixture must not read a developer's models.config.json.
  process.chdir(directory);
  await withEnv({ CODEGEIST_MODELS_FILE: '', OPENAI_MODEL: '', OPENAI_API_KEY: 'secret' }, async () => {
    assert.equal(loadModelProfiles().length, 0);
    assert.throws(() => createProvider(), /Configure OPENAI_MODEL/);
    await withEnv({ OPENAI_MODEL: 'custom-code-model', OPENAI_BASE_URL: 'https://custom.test/api/v4/' }, async () => {
      assert.equal(loadModelProfiles()[0].model, 'custom-code-model');
      assert.equal(getModelConfiguration().baseURL, 'https://custom.test/api/v4');
      const selection = await routeModel('Fix the bug');
      assert.equal(selection.source, 'fallback');
      assert.equal(selection.confidence, undefined);
    });
    await withEnv({ OPENAI_MODEL: 'custom', OPENAI_BASE_URL: 'https://user:private-secret@custom.test/v1' }, async () => {
      assert.throws(() => loadModelProfiles(), (error: unknown) => error instanceof Error && !error.message.includes('private-secret'));
    });
  });
});

test('Chat Completions performs multiple tool turns and preserves DeepSeek reasoning fields', async () => {
  let calls = 0;
  const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  await mockHTTP((request, response, body) => {
    calls++;
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer deepseek-secret');
    assert.equal(body.model, 'deepseek-chat');
    assert.deepEqual(body.tools, tools);
    if (calls === 1) {
      json(response, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'provider continuation data', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    } else if (calls === 2) {
      assert.equal(body.messages[2].reasoning_content, 'provider continuation data');
      assert.equal(body.messages[3].tool_call_id, 'call_1');
      json(response, { choices: [{ message: { role: 'assistant', content: 'Read tests next.', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"tests/index.test.ts"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
    } else {
      assert.equal(body.messages[5].tool_call_id, 'call_2');
      json(response, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'The change is verified.' } }], usage: { prompt_tokens: 35, completion_tokens: 8 } });
    }
  }, async (baseURL) => profiles(baseURL, async () => {
    const provider = createProvider('deepseek');
    const messages: ChatMessage[] = [{ role: 'system', content: 'Use tools.' }, { role: 'user', content: 'Fix the bug.' }];
    let inputTokens = 0;
    for (let turn = 0; turn < 3; turn++) {
      const result = await provider.next(messages, tools);
      inputTokens += result.usage.inputTokens;
      messages.push(result.message);
      if (result.toolCalls.length) messages.push({ role: 'tool', tool_call_id: result.toolCalls[0].id, content: 'file contents' });
      else assert.equal(result.content, 'The change is verified.');
    }
    assert.equal(inputTokens, 67);
  }));
  assert.equal(calls, 3);
});

test('Jev routes by profile IDs, scores context, and classifies failures using typed API requests', async () => {
  await mockHTTP((request, response, body) => {
    assert.equal(request.url, '/v1/systemone');
    assert.equal(request.headers.authorization, 'Bearer jev-secret');
    assert.equal(body.model, 'jev-test');
    const answers: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(body.questions)) {
      const question = raw as Record<string, any>;
      if (key === 'model') {
        assert.equal(question.type, 'choice');
        assert.match(question.criteria.zhipu, /architecture/);
        answers[key] = { type: 'choice', choice: 'zhipu', confidence: 0.91, probabilities: { deepseek: 0.04, zhipu: 0.94, __default__: 0.02 } };
      } else if (key === 'failure') {
        answers[key] = { type: 'choice', choice: 'assertion', confidence: 0.87, probabilities: { build: 0.02, assertion: 0.94, environment: 0.02, unknown: 0.02 } };
      } else {
        assert.equal(question.type, 'score');
        assert.equal(question.criteria.length, 3);
        const score = key === 'candidate_0' ? 0.2 : 1.8;
        answers[key] = { type: 'score', score, confidence: 0.8, probabilities: { '0': score === 0.2 ? 0.8 : 0, '1': 0.2, '2': score === 1.8 ? 0.8 : 0 }, legend: { '0': 'Unrelated', '1': 'Adjacent', '2': 'Direct' } };
      }
    }
    json(response, { model: 'jev-test', answers, usage: { input_tokens: 80, output_tokens: 10 } });
  }, async (baseURL) => profiles(baseURL, async () => {
    const selection = await routeModel('Refactor a complex architecture.');
    assert.equal(selection.modelId, 'zhipu');
    assert.equal(selection.source, 'jev');
    assert.equal(selection.confidence, 0.91);
    const contexts = await evaluateContext('Fix shipping', [{ path: 'README.md', content: 'Readme' }, { path: 'shipping.ts', content: 'function shipping() {}' }]);
    assert.equal(contexts.source, 'jev');
    assert.deepEqual(contexts.scores.map((score) => score.path), ['shipping.ts', 'README.md']);
    const failure = await evaluateFailure('Fix shipping', 'Assertion failed: 5 !== 6');
    assert.equal(failure.category, 'assertion');
    assert.equal(failure.usage?.inputTokens, 80);
  }));
});

test('unknown routes, weak confidence, malformed Jev responses, and missing keys use honest fallbacks', async () => {
  let variant = 'unknown';
  await mockHTTP((_request, response) => {
    if (variant === 'malformed') { response.end('not json'); return; }
    json(response, { answers: { model: { type: 'choice', choice: variant === 'unknown' ? 'invented' : 'zhipu', confidence: 0.1, probabilities: { deepseek: 0.3, zhipu: 0.4, __default__: 0.3 } } } });
  }, async (baseURL) => profiles(baseURL, async () => {
    let selection = await routeModel('Fix something');
    assert.equal(selection.modelId, 'deepseek');
    assert.equal(selection.source, 'fallback');
    assert.equal(selection.confidence, undefined);
    variant = 'weak';
    selection = await routeModel('Fix something');
    assert.equal(selection.modelId, 'deepseek');
    assert.equal(selection.source, 'fallback');
    assert.equal(selection.confidence, 0.1);
    variant = 'malformed';
    const context = await evaluateContext('Fix bug', [{ path: 'a.ts', content: 'a' }, { path: 'b.ts', content: 'b' }]);
    assert.equal(context.source, 'fallback');
    assert.deepEqual(context.scores, [{ path: 'a.ts', score: null }, { path: 'b.ts', score: null }]);
    assert.match(context.reason!, /invalid JSON/);
    await withEnv({ TYPESAFE_API_KEY: '' }, async () => {
      const result = await evaluateFailure('Fix bug', 'Failure');
      assert.equal(result.category, 'unknown');
      assert.equal(result.source, 'fallback');
      assert.equal(result.confidence, undefined);
      assert.equal(result.usage, undefined);
      assert.match(result.reason!, /not configured/);
    });
    const overridden = await routeModel('Fix bug', 'zhipu');
    assert.equal(overridden.source, 'override');
    assert.equal(overridden.modelId, 'zhipu');
  }));
});

test('malformed generation responses fail safely and provider error bodies never expose secrets', async () => {
  let variant = 'secret';
  await mockHTTP((_request, response) => {
    if (variant === 'secret') json(response, { error: 'Bearer deepseek-secret jev-secret private request' }, 401);
    else if (variant === 'tool') json(response, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: {} } }] } }] });
    else json(response, { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'truncated' } }] });
  }, async (baseURL) => profiles(baseURL, async () => {
    const provider = createProvider();
    await assert.rejects(provider.next([{ role: 'user', content: 'Fix bug' }], []), (error: unknown) => error instanceof Error && /HTTP 401/.test(error.message) && !error.message.includes('secret'));
    variant = 'tool';
    await assert.rejects(provider.next([{ role: 'user', content: 'Fix bug' }], []), /malformed tool call/);
    variant = 'truncated';
    await assert.rejects(provider.next([{ role: 'user', content: 'Fix bug' }], []), /truncated/);
  }));
});

test('cancellation interrupts active generation and Jev requests instead of returning a fallback', async () => {
  await mockHTTP(() => {}, async (baseURL) => profiles(baseURL, async () => {
    for (const request of [
      (signal: AbortSignal) => createProvider().next([{ role: 'user', content: 'Fix bug' }], [], signal),
      (signal: AbortSignal) => evaluateFailure('Fix bug', 'Error', signal),
      (signal: AbortSignal) => routeModel('Fix bug', undefined, signal),
    ]) {
      const controller = new AbortController();
      const promise = request(controller.signal);
      const timer = setTimeout(() => controller.abort(), 15);
      try { await assert.rejects(promise, (error: unknown) => error instanceof Error && error.name === 'AbortError'); }
      finally { clearTimeout(timer); }
    }
    await withEnv({ MODEL_TIMEOUT_MS: '15', TYPESAFE_TIMEOUT_MS: '15' }, async () => {
      await assert.rejects(createProvider().next([{ role: 'user', content: 'Fix bug' }], []), /timed out/);
      const failure = await evaluateFailure('Fix bug', 'Error');
      assert.equal(failure.source, 'fallback');
      assert.match(failure.reason!, /timed out/);
    });
  }));
});

function traceRun(): Run {
  const now = new Date().toISOString();
  return { id: 'provider-trace-test', title: 'Trace provider', task: 'Fix bug', mode: 'live', status: 'running', phase: 'plan',
    createdAt: now, updatedAt: now, repository: '/unused', testCommand: 'node --test', maxSteps: 8, step: 1,
    events: [], files: [], diff: '', metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 } };
}

function traceObserver(run: Run, directory: string, onStart?: () => void): ProviderTraceObserver {
  const recorder = createTraceRecorder(run, directory, () => {});
  return {
    async start(input) {
      const id = await recorder.start({ type: input.kind, title: input.title, request: input.request, schema: input.schema, secrets: input.secrets,
        trace: { kind: input.kind, source: 'live', turn: 1, step: run.events.length + 1, parentId: 'task-input', method: input.method, url: input.url, model: input.model } });
      onStart?.();
      return id;
    },
    finish: (id, result) => recorder.finish(id, result),
  };
}

test('provider tracing stores complete request, response, schema, and usage outside lightweight events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codegeist-provider-trace-'));
  const run = traceRun();
  let started = false;
  const source = 'full source context '.repeat(4000);
  const responseBody = { choices: [{ message: { role: 'assistant', content: 'Done.', reasoning_content: 'Full provider continuation state.', provider_extension: { full: true } } }], usage: { prompt_tokens: 1234, completion_tokens: 56 } };
  const tool: ToolDefinition = { type: 'function', function: { name: 'read_file', description: 'Read code', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
  try {
    await mockHTTP((_request, response, body) => {
      assert(started, 'The span must be persisted before the HTTP request starts.');
      assert.equal(body.messages[1].content, source);
      response.setHeader('x-request-id', 'local-provider-request');
      response.setHeader('set-cookie', 'private-cookie=hidden');
      json(response, responseBody);
    }, async (baseURL) => profiles(baseURL, async () => {
      const result = await createProvider('deepseek').next([{ role: 'system', content: 'Use tools.' }, { role: 'user', content: source }], [tool], undefined,
        traceObserver(run, directory, () => { started = true; }));
      assert(result.traceId);
      assert.equal(run.events.length, 1);
      const detail = await readTraceDetail(directory, run, result.traceId);
      const request = detail.request as { method: string; url: string; headers: Record<string, string>; body: Record<string, any> };
      const response = detail.response as { status: number; headers: Record<string, string>; body: unknown };
      assert.equal(request.method, 'POST');
      assert.equal(request.url, `${baseURL}/chat/completions`);
      assert.equal(request.headers.authorization, '[REDACTED]');
      assert.equal(request.body.messages[1].content, source);
      assert.deepEqual(request.body.tools, [tool]);
      assert.deepEqual((detail.schema as { tools: unknown }).tools, [tool]);
      assert.deepEqual(response.body, responseBody);
      assert.equal(response.headers['x-request-id'], 'local-provider-request');
      assert.equal(response.headers['set-cookie'], '[REDACTED]');
      assert.equal(detail.event.status, 'success');
      assert.equal(detail.event.trace?.httpStatus, 200);
      assert.equal(detail.event.trace?.parentId, 'task-input');
      assert.deepEqual(detail.event.trace?.usage, { inputTokens: 1234, outputTokens: 56, reported: true });
      assert.equal(detail.event.trace?.hasSchema, true);
      assert(detail.event.trace?.endedAt);
      assert.equal(typeof detail.event.trace?.durationMs, 'number');
      assert(!JSON.stringify(run.events).includes(source));
      assert(!JSON.stringify(run.events).includes('continuation state'));
      assert(!JSON.stringify(detail).includes('deepseek-secret'));
    }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP errors, invalid JSON, invalid schemas, network failures, timeout, and abort finish their original trace span', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codegeist-provider-errors-'));
  const run = traceRun();
  const observer = traceObserver(run, directory);
  let mode = 'unauthorized';
  try {
    await mockHTTP((request, response) => {
      if (mode === 'unauthorized') json(response, { message: 'Echo deepseek-secret', extra: JSON.stringify({ api_key: 'otherwise-unknown-key', text: 'deepseek-secret' }) }, 401);
      else if (mode === 'limited') { response.writeHead(429); response.end('Slow down deepseek-secret'); }
      else if (mode === 'invalid-json') { response.writeHead(200); response.end('broken JSON: deepseek-secret'); }
      else if (mode === 'invalid-schema') json(response, { choices: [], provider_diagnostic: 'Schema details retained' });
      else if (mode === 'network') request.socket.destroy();
      else if (mode === 'partial-timeout') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"partial":"deepseek-secret"'); }
      // timeout and abort intentionally leave the connection open.
    }, async (baseURL) => profiles(baseURL, async () => {
      const provider = createProvider();
      for (const variant of ['unauthorized', 'limited', 'invalid-json', 'invalid-schema', 'network', 'timeout', 'partial-timeout', 'abort']) {
        mode = variant;
        const controller = new AbortController();
        const timer = variant === 'abort' ? setTimeout(() => controller.abort(), 15) : undefined;
        await withEnv({ MODEL_TIMEOUT_MS: variant.includes('timeout') ? '30' : '1000' }, async () => {
          await assert.rejects(provider.next([{ role: 'user', content: 'Fix bug' }], [], controller.signal, observer));
        });
        if (timer) clearTimeout(timer);
        const event = run.events.at(-1)!;
        assert.equal(event.status, 'error', variant);
        assert(event.trace?.endedAt, variant);
        assert.equal(typeof event.trace?.durationMs, 'number', variant);
        assert(event.trace?.error, variant);
        const detail = await readTraceDetail(directory, run, event.id);
        assert(!JSON.stringify(detail).includes('deepseek-secret'), variant);
        assert(!JSON.stringify(detail).includes('otherwise-unknown-key'), variant);
        if (variant === 'unauthorized') {
          assert.equal(event.trace.httpStatus, 401);
          assert.deepEqual((detail.response as { body: unknown }).body, { message: 'Echo [REDACTED]', extra: JSON.stringify({ api_key: '[REDACTED]', text: '[REDACTED]' }) });
        } else if (variant === 'limited') {
          assert.equal(event.trace.httpStatus, 429);
          assert.equal((detail.response as { body: unknown }).body, 'Slow down [REDACTED]');
        } else if (variant === 'invalid-json') {
          assert.equal(event.trace.httpStatus, 200);
          assert.equal((detail.response as { body: unknown }).body, 'broken JSON: [REDACTED]');
          assert.equal((detail.response as { truncated?: boolean }).truncated, undefined, 'A complete invalid JSON body is not a truncated stream.');
        } else if (variant === 'invalid-schema') {
          assert.equal(event.trace.httpStatus, 200);
          assert.deepEqual((detail.response as { body: unknown }).body, { choices: [], provider_diagnostic: 'Schema details retained' });
        } else if (variant === 'partial-timeout') {
          assert.equal(event.trace.httpStatus, 200);
          assert.equal(event.trace.hasResponse, true);
          assert.equal((detail.response as { truncated?: boolean }).truncated, true);
          assert.equal((detail.response as { body: unknown }).body, '{"partial":"[REDACTED]"');
          assert.match(event.trace.error, /timed out/);
        } else {
          assert.equal(event.trace.httpStatus, undefined);
          assert.equal(event.trace.hasResponse, false);
          assert.equal(detail.response, undefined);
        }
      }
      assert.equal(run.events.length, 8, 'Each request must produce one event, updated on completion.');
    }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Jev invalid answers keep full diagnostic bodies and mark the request error before fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codegeist-jev-errors-'));
  const run = traceRun();
  const observer = traceObserver(run, directory);
  try {
    await mockHTTP((_request, response) => json(response, { answers: { failure: { type: 'choice', choice: 'invented', confidence: 2 } }, diagnostic: 'Original schema failure' }),
      async (baseURL) => profiles(baseURL, async () => {
        const result = await evaluateFailure('Fix bug', 'Assertion failed with full output.', undefined, observer);
        assert.equal(result.source, 'fallback');
        assert(result.traceId);
        const detail = await readTraceDetail(directory, run, result.traceId);
        assert.equal(detail.event.status, 'error');
        assert.equal(detail.event.trace?.kind, 'jev');
        assert.equal(detail.event.trace?.httpStatus, 200);
        assert.match(detail.event.trace?.error ?? '', /invalid choice/);
        assert.equal((detail.request as { body: any }).body.state.output, 'Assertion failed with full output.');
        assert.equal((detail.schema as { questions: any }).questions.failure.type, 'choice');
        assert.equal((detail.response as { body: any }).body.diagnostic, 'Original schema failure');
        await withEnv({ TYPESAFE_API_KEY: '' }, async () => {
          const fallback = await evaluateFailure('Fix bug', 'Error', undefined, observer);
          assert.equal(fallback.traceId, undefined);
          assert.equal(run.events.length, 1, 'Missing credentials must not create a fictitious HTTP span.');
        });
      }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function sse(data: unknown, multiline = false): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, multiline ? 2 : undefined);
  return text.split('\n').map((line) => `data: ${line}\r\n`).join('') + '\r\n';
}

async function streamPieces(response: ServerResponse, pieces: Buffer[]) {
  for (const piece of pieces) {
    if (response.destroyed) return;
    response.write(piece);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  response.end();
}

test('SSE streaming assembles indexed tool fragments and reasoning across UTF-8, CRLF, and multiline event boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codegeist-sse-'));
  const run = traceRun();
  const updates: Array<Parameters<NonNullable<ProviderTraceObserver['delta']>>[1]> = [];
  let finished: Parameters<ProviderTraceObserver['finish']>[1] | undefined;
  const recorder = traceObserver(run, directory);
  const observer: ProviderTraceObserver = {
    ...recorder,
    delta: async (_id, update) => { updates.push(update); },
    finish: async (id, result) => { finished = result; await recorder.finish(id, result); },
  };
  const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'chat-stream', model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }] });
  try {
    await mockHTTP((_request, response, body) => {
      assert.equal(body.stream, true);
      assert.equal(body.stream_options, undefined, 'Usage opt-in is not universally supported.');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': heartbeat\r\n\r\n' + sse(chunk({ role: 'assistant', content: '' })));
      setTimeout(() => {
        const payload = [
          sse(chunk({ reasoning_content: 'check ' })),
          sse(chunk({ reasoning_content: 'source' })),
          sse(chunk({ content: 'Fix ' }), true),
          sse(chunk({ content: '你好' })),
          sse(chunk({ tool_calls: [{ index: 1, id: 'call_1', type: 'function', function: { name: 'run_tests', arguments: '{' } }] })),
          sse(chunk({ tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'read_', arguments: '{"pa' } }] })),
          sse(chunk({ tool_calls: [{ index: 0, id: '0', function: { name: 'file', arguments: 'th":"src/math.ts"}' } }, { index: 1, function: { arguments: '}' } }] })),
          sse(chunk({}, 'tool_calls')),
          sse({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 35, prompt_cache_hit_tokens: 80, completion_tokens_details: { reasoning_tokens: 20 } } }),
          sse('[DONE]'),
        ].join('');
        const buffer = Buffer.from(payload);
        const unicode = buffer.indexOf(Buffer.from('你'));
        const crlf = buffer.indexOf(Buffer.from('\r\n'));
        const boundaries = [...new Set([0, 5, crlf + 1, unicode + 1, unicode + 2, unicode + 4, buffer.length])].sort((a, b) => a - b);
        void streamPieces(response, boundaries.slice(0, -1).map((start, index) => buffer.subarray(start, boundaries[index + 1])));
      }, 30);
    }, async (baseURL) => profiles(baseURL, async () => {
      const result = await createProvider().next([{ role: 'user', content: 'Fix the source.' }], [], undefined, observer);
      assert.equal(result.content, 'Fix 你好');
      assert.equal(result.message.reasoning_content, 'check source');
      assert.deepEqual(result.toolCalls, [
        { id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/math.ts"}' } },
        { id: 'call_1', type: 'function', function: { name: 'run_tests', arguments: '{}' } },
      ]);
      assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 35, reported: true, cachedInputTokens: 80, reasoningTokens: 20 });
      assert.deepEqual(updates.filter((update) => update.content !== undefined).map((update) => update.content), ['Fix ', 'Fix 你好']);
      assert(!JSON.stringify(updates).includes('check source'), 'Reasoning is retained privately, never emitted as public assistant text.');
      assert(updates[0].firstTokenAt, 'The first reasoning delta is an effective token even before public content.');
      assert.equal(updates[0].content, undefined);
      assert(finished?.firstTokenAt);
      assert(finished.ttftMs! >= 20, 'Empty role chunks and heartbeats must not count as first token.');
      assert(finished.generationMs! >= 0);
      assert.deepEqual(finished.usage, result.usage);
      const detail = await readTraceDetail(directory, run, result.traceId!);
      const traceResponse = detail.response as { body: any; stream: { done: boolean; events: Array<{ data: any }> } };
      assert.equal(traceResponse.body.choices[0].message.reasoning_content, 'check source');
      assert.equal(traceResponse.stream.done, true);
      assert(traceResponse.stream.events.some((event) => event.data.usage?.prompt_cache_hit_tokens === 80));
      assert.equal((detail.request as { body: any }).body.stream, true);
    }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stream usage can arrive on the finishing chunk, while absent usage remains explicitly unreported', async () => {
  let provideUsage = true;
  await mockHTTP((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Completed.' }, finish_reason: 'stop' }],
      ...(provideUsage ? { usage: { prompt_tokens: 17, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 4 } } } : {}),
    }) + sse('[DONE]'));
  }, async (baseURL) => profiles(baseURL, async () => {
    const provider = createProvider();
    const first = await provider.next([{ role: 'user', content: 'Finish.' }], []);
    assert.deepEqual(first.usage, { inputTokens: 17, outputTokens: 9, reported: true, cachedInputTokens: 5, reasoningTokens: 4 });
    provideUsage = false;
    const second = await provider.next([{ role: 'user', content: 'Finish.' }], []);
    assert.deepEqual(second.usage, { inputTokens: 0, outputTokens: 0, reported: false });
  }));
});

test('profile streaming adapters opt into usage or nonstream JSON without retrying requests', async () => {
  let calls = 0;
  await mockHTTP((_request, response, body) => {
    calls++;
    if (calls === 1) {
      assert.equal(body.stream, true);
      assert.deepEqual(body.stream_options, { include_usage: true });
    } else {
      assert.equal(body.stream, false);
      assert.equal(body.stream_options, undefined);
    }
    json(response, { choices: [{ message: { role: 'assistant', content: 'JSON compatibility response.' } }] });
  }, async (baseURL) => profiles(baseURL, async () => {
    const filename = process.env.CODEGEIST_MODELS_FILE!;
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.models[0].streamUsage = true;
    config.models[1].streaming = false;
    await writeFile(filename, JSON.stringify(config));
    assert.equal(loadModelProfiles()[0].streamUsage, true);
    assert.equal(loadModelProfiles()[1].streaming, false);
    for (const model of ['deepseek', 'zhipu']) {
      const result = await createProvider(model).next([{ role: 'user', content: 'Respond.' }], []);
      assert.equal(result.content, 'JSON compatibility response.');
      assert.equal(result.usage.reported, false);
    }
  }));
  assert.equal(calls, 2);
});

test('unfinished streamed tool calls and stream cancellation retain partial evidence but never return executable calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codegeist-sse-errors-'));
  const run = traceRun();
  let mode = 'early-done';
  let abort: AbortController | undefined;
  const base = traceObserver(run, directory);
  const observer: ProviderTraceObserver = { ...base, delta: async (_id, update) => { if (mode === 'cancel' && update.content) abort!.abort(); } };
  try {
    await mockHTTP((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse({ choices: [{ index: 0, delta: { content: 'Partial explanation', tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'write_file', arguments: '{"path":' } }] }, finish_reason: null }], usage: { prompt_tokens: 23, completion_tokens: 7 } }));
      if (mode === 'early-done') response.end(sse('[DONE]'));
      else if (mode === 'early-eof') response.end();
      // Cancellation leaves the live response open until the client aborts.
    }, async (baseURL) => profiles(baseURL, async () => {
      for (const variant of ['early-done', 'early-eof', 'cancel']) {
        mode = variant;
        abort = new AbortController();
        await assert.rejects(createProvider().next([{ role: 'user', content: 'Fix code.' }], [], abort.signal, observer), variant === 'cancel'
          ? (error: unknown) => error instanceof Error && error.name === 'AbortError'
          : /before a finish reason/);
        const event = run.events.at(-1)!;
        assert.equal(event.status, 'error');
        assert.equal(event.trace?.usage?.inputTokens, 23);
        assert.equal(event.trace?.usage?.outputTokens, 7);
        const detail = await readTraceDetail(directory, run, event.id);
        const response = detail.response as { body: any; truncated?: boolean; stream: { events: unknown[] } };
        assert.equal(response.body.choices[0].message.content, 'Partial explanation');
        assert.equal(response.body.choices[0].message.tool_calls[0].function.arguments, '{"path":');
        assert(response.stream.events.length > 0);
        assert.equal(response.truncated, true);
      }
    }));
    assert.equal(run.events.length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
