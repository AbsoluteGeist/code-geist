import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { executeRun } from '../server/harness.js';
import type { Run } from '../shared/types.js';
import { readTraceDetail } from '../server/trace.js';

const exec = promisify(execFile);
const originalCode = 'export function add(a, b) { return a - b; }\n';
const fixedCode = 'export function add(a, b) { return a + b; }\n';
const finalCode = '// Add two numbers without changing their signs.\n' + fixedCode;

function sendJSON(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('live harness routes through Jev and completes real inspect/fail/edit/verify tool cycles in an isolated worktree', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codegeist-live-test-'));
  const repository = join(directory, 'source');
  const dataDir = join(directory, 'data');
  const savedRunPath = join(directory, 'run.json');
  const configPath = join(directory, 'models.json');
  const git = (args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repository });
  let generationCalls = 0;
  let jevCalls = 0;
  let mockError: unknown;
  const observedJevKinds = new Set<string>();
  const actions = [
    [{ name: 'list_files', args: {} }, { name: 'read_file', args: { path: 'src/math.js' } }, { name: 'search_files', args: { query: 'add' } }],
    [{ name: 'run_tests', args: {} }],
    [{ name: 'finish', args: { summary: 'Premature completion before edits.' } }],
    [{ name: 'write_file', args: { path: 'src/math.js', content: fixedCode } }, { name: 'finish', args: { summary: 'Premature completion without a passing test.' } }],
    [{ name: 'run_tests', args: {} }],
    [{ name: 'write_file', args: { path: 'src/math.js', content: finalCode } }, { name: 'finish', args: { summary: 'Premature completion using stale verification.' } }],
    [{ name: 'run_tests', args: {} }],
    [{ name: 'finish', args: { summary: 'Fixed add to use addition. Verified positive and negative inputs with node --test on the final revision.' } }],
  ];

  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      const payload = JSON.parse(body);
      if (request.url === '/v1/systemone') {
        jevCalls++;
        assert.equal(request.headers.authorization, 'Bearer local-jev-secret');
        assert.equal(payload.model, 'jev-local-test');
        const answers: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(payload.questions)) {
          const question = raw as { type: string; criteria: unknown };
          if (key === 'model') {
            observedJevKinds.add('route');
            assert.equal(question.type, 'choice');
            answers[key] = { type: 'choice', choice: 'specialist', confidence: 0.96, probabilities: { general: 0.01, specialist: 0.98, __default__: 0.01 } };
          } else if (key === 'failure') {
            observedJevKinds.add('failure');
            assert.equal(question.type, 'choice');
            assert.match(payload.state.output, /AssertionError|ERR_ASSERTION/);
            answers[key] = { type: 'choice', choice: 'assertion', confidence: 0.94, probabilities: { build: 0.01, assertion: 0.97, environment: 0.01, unknown: 0.01 } };
          } else {
            observedJevKinds.add('context');
            assert.equal(question.type, 'score');
            assert(Array.isArray(payload.state.candidates));
            answers[key] = { type: 'score', score: 1.9, confidence: 0.9, probabilities: { '0': 0, '1': 0.1, '2': 0.9 }, legend: { '0': 'Unrelated', '1': 'Adjacent', '2': 'Direct' } };
          }
        }
        sendJSON(response, { model: 'jev-local-test', answers, usage: { input_tokens: 40, output_tokens: 8 } });
        return;
      }

      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer local-specialist-secret');
      assert.equal(payload.model, 'local-function-calling-model');
      assert(payload.tools.some((tool: { function: { name: string } }) => tool.function.name === 'run_tests'));
      const step = generationCalls++;
      assert(step < actions.length, 'Harness should finish without extra model calls.');
      const assistants = payload.messages.filter((message: { role: string }) => message.role === 'assistant');
      assert.equal(assistants.length, step);
      assistants.forEach((message: { reasoning_content?: string }, index: number) => {
        assert.equal(message.reasoning_content, `local-reasoning-state-${index}`, 'Provider continuation fields must survive every tool turn.');
      });
      const observations = payload.messages.filter((message: { role: string }) => message.role === 'tool');
      const lastObservation = observations.at(-1)?.content ?? '';
      if (step === 1) {
        assert(observations.some((message: { content: string }) => JSON.parse(message.content).content === originalCode), JSON.stringify(observations));
        assert.match(lastObservation, /src\/math\.js/);
      }
      if (step === 2) {
        const verification = JSON.parse(lastObservation);
        assert.equal(verification.passed, false);
        assert.notEqual(verification.exitCode, 0);
        assert.match(verification.routingHint, /actual and expected/);
      }
      if (step === 3) assert.match(lastObservation, /no meaningful file changes/);
      if (step === 4) assert.match(lastObservation, /resolve failures first/);
      if (step === 5 || step === 7) assert.equal(JSON.parse(lastObservation).passed, true);
      if (step === 6) assert.match(lastObservation, /files changed after the last verification/);

      sendJSON(response, {
        choices: [{ finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, reasoning_content: `local-reasoning-state-${step}`,
          tool_calls: actions[step].map((action, index) => ({ id: `step_${step}_call_${index}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } })),
        } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    } catch (error) {
      mockError = error;
      sendJSON(response, { error: 'Mock protocol assertion failed' }, 500);
    }
  });

  const previousEnv: Record<string, string | undefined> = {};
  try {
    await mkdir(join(repository, 'src'), { recursive: true });
    await mkdir(join(repository, 'test'), { recursive: true });
    await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'live-agent-fixture', private: true, type: 'module' }));
    await writeFile(join(repository, 'src/math.js'), originalCode);
    await writeFile(join(repository, 'README.md'), '# Addition fixture\n');
    await writeFile(join(repository, 'test/math.test.js'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.js';",
      "test('adds positive values', () => assert.equal(add(2, 3), 5));",
      "test('adds negative values', () => assert.equal(add(-2, -3), -5));",
      '',
    ].join('\n'));
    await git(['init', '-b', 'feat/test-fixture']);
    await git(['add', '.']);
    await git(['-c', 'user.name=Code Geist Test', '-c', 'user.email=test@code-geist.local', 'commit', '--signoff', '-m', 'test: seed live integration fixture']);
    const baseCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const unchangedTests = await readFile(join(repository, 'test/math.test.js'), 'utf8');
    // The source checkout may contain unrelated work. The agent must leave it intact.
    await writeFile(join(repository, 'README.md'), '# Addition fixture\nLocal uncommitted note.\n');
    await writeFile(join(repository, 'personal-note.txt'), 'Keep this untracked file.\n');
    const initialStatus = (await git(['status', '--porcelain'])).stdout;

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(configPath, JSON.stringify({ defaultModel: 'general', models: [
      { id: 'general', name: 'General', baseURL, model: 'unused-general-model', apiKeyEnv: 'CG_LIVE_GENERAL_KEY', description: 'General coding' },
      { id: 'specialist', name: 'Arithmetic specialist', baseURL, model: 'local-function-calling-model', apiKeyEnv: 'CG_LIVE_SPECIALIST_KEY', description: 'Arithmetic bugs and regression tests' },
    ] }));
    const env = {
      CODEGEIST_MODELS_FILE: configPath,
      CG_LIVE_GENERAL_KEY: 'local-general-secret', CG_LIVE_SPECIALIST_KEY: 'local-specialist-secret',
      TYPESAFE_API_KEY: 'local-jev-secret', TYPESAFE_BASE_URL: baseURL, TYPESAFE_MODEL: 'jev-local-test',
      TYPESAFE_ROUTING_MIN_CONFIDENCE: '0.55',
    };
    for (const [key, value] of Object.entries(env)) { previousEnv[key] = process.env[key]; process.env[key] = value; }
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(), title: 'Fix arithmetic', task: 'Fix add so it adds positive and negative numbers. Preserve the existing tests.',
      mode: 'live', modelId: 'auto', status: 'queued', phase: 'prepare', createdAt: now, updatedAt: now,
      repository, testCommand: `"${process.execPath}" --test`, maxSteps: 10, step: 0,
      events: [], files: [], diff: '', metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    };
    let updates = 0;
    await executeRun(run, {
      dataDir, signal: new AbortController().signal,
      onUpdate: async () => { updates++; await writeFile(savedRunPath, JSON.stringify(run)); },
    });
    if (mockError) throw mockError;

    assert.equal(run.status, 'completed', run.error ?? 'Expected the live task to complete.');
    assert.equal(run.phase, 'complete');
    assert.equal(run.modelId, 'specialist');
    assert.equal(run.modelName, 'local-function-calling-model');
    assert.equal(run.baseCommit, baseCommit);
    assert.equal(run.step, 8);
    assert.equal(generationCalls, 8);
    assert.equal(jevCalls, 3);
    assert.deepEqual([...observedJevKinds].sort(), ['context', 'failure', 'route']);
    assert.equal(run.metrics.modelCalls, generationCalls);
    assert.equal(run.metrics.jevCalls, jevCalls);
    assert.equal(run.metrics.inputTokens, generationCalls * 100 + jevCalls * 40);
    assert.equal(run.metrics.outputTokens, generationCalls * 20 + jevCalls * 8);
    assert(run.workspace && run.workspace !== repository);
    assert.match(run.branch!, /^feat\/agent-/);
    assert.equal(await readFile(join(run.workspace, 'src/math.js'), 'utf8'), finalCode);
    assert.equal(await readFile(join(run.workspace, 'test/math.test.js'), 'utf8'), unchangedTests);
    assert.equal(await readFile(join(run.workspace, 'README.md'), 'utf8'), '# Addition fixture\n');
    assert.equal(await readFile(join(repository, 'src/math.js'), 'utf8'), originalCode);
    assert.equal((await git(['status', '--porcelain'])).stdout, initialStatus);
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), baseCommit);
    assert.deepEqual(run.files.map((file) => file.path), ['src/math.js']);
    assert.match(run.diff, /-export function add\(a, b\) \{ return a - b; \}/);
    assert.match(run.diff, /\+export function add\(a, b\) \{ return a \+ b; \}/);
    assert.equal(run.verification?.passed, true);
    assert.equal(run.verification?.exitCode, 0);
    assert.equal(run.verification?.revision, 2);
    assert.match(run.verification.output, /pass 2/);
    assert.equal(run.events.filter((event) => event.type === 'tool' && event.data?.name === 'finish' && event.status === 'error').length, 3);
    assert.deepEqual(run.events.filter((event) => event.type === 'verification').map((event) => event.data?.passed), [false, true, true]);
    assert.equal(run.events.filter((event) => event.type === 'jev' && event.data?.source === 'jev').length, 3);
    assert(!run.events.some((event) => event.data?.source === 'demo'));
    assert(updates > 30);
    const persistedText = await readFile(savedRunPath, 'utf8');
    const persisted: Run = JSON.parse(persistedText);
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.events.length, run.events.length);
    assert.equal(persisted.diff, run.diff);
    assert(!persistedText.includes('secret'), 'API credentials must never appear in saved events.');
    assert(!persistedText.includes('local-reasoning-state'), 'Provider reasoning continuation data must stay out of user-facing logs.');

    const traceEvents = persisted.events.filter((event) => event.trace);
    assert(traceEvents.every((event) => event.trace?.endedAt && event.status !== 'running'), 'Every request must finish its original span.');
    assert.deepEqual(traceEvents.map((event) => event.trace!.step), traceEvents.map((_, index) => index + 1));
    const models = traceEvents.filter((event) => event.trace?.kind === 'model');
    const toolEvents = traceEvents.filter((event) => event.trace?.kind === 'tool');
    const evaluations = traceEvents.filter((event) => event.trace?.kind === 'jev' && event.trace.source === 'live');
    assert.equal(models.length, generationCalls);
    assert.equal(evaluations.length, jevCalls);
    assert.equal(toolEvents.length, run.metrics.toolCalls);
    assert.equal(traceEvents.filter((event) => event.trace?.kind === 'input').length, 2);
    const firstModel = await readTraceDetail(dataDir, persisted, models[0].id);
    const firstRequest = firstModel.request as { method: string; headers: Record<string, string>; body: Record<string, any> };
    const firstResponse = firstModel.response as { status: number; body: Record<string, any> };
    assert.equal(firstRequest.method, 'POST');
    assert.equal(firstRequest.headers.authorization, '[REDACTED]');
    assert.equal(firstRequest.body.messages[0].role, 'system');
    assert.match(firstRequest.body.messages[0].content, /isolated Git worktree/);
    assert.match(firstRequest.body.messages[1].content, /Fix add so it adds positive and negative numbers/);
    assert.equal(firstRequest.body.tools.length, 6);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.body.choices[0].message.reasoning_content, 'local-reasoning-state-0');
    assert.equal(firstResponse.body.choices[0].message.tool_calls.length, 3);
    assert.equal((firstModel.schema as { tools: unknown[] }).tools.length, 6);
    assert.equal(firstModel.event.trace?.usage?.inputTokens, 100);
    const secondModel = await readTraceDetail(dataDir, persisted, models[1].id);
    const secondRequest = secondModel.request as { body: { messages: Array<Record<string, any>> } };
    assert.equal(secondRequest.body.messages[2].reasoning_content, 'local-reasoning-state-0');
    assert(secondRequest.body.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'step_0_call_1' && JSON.parse(message.content).content === originalCode));

    for (const event of toolEvents) {
      const parent = models.find((model) => model.id === event.trace?.parentId);
      assert(parent, `Tool ${event.title} must link to its exact model response.`);
      assert.equal(event.trace?.turn, parent.trace?.turn);
      const parentDetail = await readTraceDetail(dataDir, persisted, parent.id);
      const calls = (parentDetail.response as { body: any }).body.choices[0].message.tool_calls as Array<{ id: string }>;
      assert(calls.some((call) => call.id === event.trace?.toolCallId));
      const detail = await readTraceDetail(dataDir, persisted, event.id);
      assert(detail.request !== undefined && detail.response !== undefined && detail.schema !== undefined);
      assert(!JSON.stringify(detail).includes('secret'));
    }
    for (const event of evaluations) {
      const detail = await readTraceDetail(dataDir, persisted, event.id);
      const request = detail.request as { body: { state: Record<string, any>; questions: Record<string, any> } };
      const parent = traceEvents.find((candidate) => candidate.id === event.trace?.parentId);
      assert(parent, 'Jev request must link to the input or tool that caused it.');
      assert.equal(event.trace?.httpStatus, 200);
      assert.equal((detail.response as { status: number }).status, 200);
      if (request.body.questions.model) assert.equal(parent.trace?.kind, 'input');
      else if (request.body.questions.failure) {
        assert.equal(parent.data?.name, 'run_tests');
        assert.match(request.body.state.output, /ERR_ASSERTION|AssertionError/);
      } else {
        assert.equal(parent.data?.name, 'search_files');
        assert(request.body.state.candidates.some((candidate: { path: string }) => candidate.path === 'src/math.js'));
      }
      assert(!JSON.stringify(detail).includes('secret'));
    }
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
