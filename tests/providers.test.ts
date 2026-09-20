import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProvider, evaluateContext, evaluateFailure, routeModel, type ChatMessage, type ToolDefinition } from '../server/providers.js';
import { getDefaultModelId, getModelConfiguration, loadModelProfiles } from '../server/model-config.js';

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
