import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DEMO_FIX, prepareDemoWorkspace } from '../server/demo.js';
import { childEnvironment, listWorkspaceFiles, parseCommand, prepareLiveWorkspace, readWorkspaceFile, runCommand, safePath, workspaceDiff, writeWorkspaceFile } from '../server/workspace.js';
import type { Run } from '../shared/types.js';

function run(id = 'fixture'): Run {
  return { id, title: 'test', task: 'test', mode: 'demo', status: 'queued', phase: 'prepare', createdAt: '', updatedAt: '', repository: '', testCommand: 'node --test', maxSteps: 20, step: 0, events: [], files: [], diff: '', metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 } };
}

test('workspace paths reject escape, secrets, and symlink traversal', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-paths-'));
  try {
    await writeFile(path.join(temp, 'safe.txt'), 'hello');
    await symlink(os.tmpdir(), path.join(temp, 'linked'));
    assert.equal(await readWorkspaceFile(temp, 'safe.txt'), 'hello');
    for (const unsafe of ['../outside', '/tmp/outside', '.git/config', '.GIT/config', '.env', '.ENV', 'nested/.Env.local', 'nested/.env.local', 'linked/anything', 'linked/new/file']) {
      await assert.rejects(safePath(temp, unsafe, true));
    }
    await assert.rejects(writeWorkspaceFile(temp, 'linked/escape', 'no'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('workspace roots with symlink aliases still produce usable relative file paths', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-root-alias-'));
  try {
    const actual = path.join(temp, 'actual');
    await writeWorkspaceFile(temp, 'actual/src/source.js', 'export const value = 1;\n');
    await symlink(actual, path.join(temp, 'alias'));
    const files = await listWorkspaceFiles(path.join(temp, 'alias'));
    assert.deepEqual(files, ['src/source.js']);
    assert.match(await readWorkspaceFile(path.join(temp, 'alias'), files[0]), /value = 1/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('argv parsing supports quoted arguments and rejects shell command chaining', () => {
  assert.deepEqual(parseCommand('node --test "test/my file.test.js"'), ['node', '--test', 'test/my file.test.js']);
  assert.deepEqual(parseCommand("node -e 'console.log(\"ok\")'"), ['node', '-e', 'console.log("ok")']);
  for (const invalid of ['', 'npm test && echo done', 'npm test\nnode run.js', 'node "unterminated']) assert.throws(() => parseCommand(invalid));
});

test('demo seed commits work when inherited repository config requires an unavailable signer', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-signing-'));
  const fixture = run('signing');
  const workspace = path.join(temp, 'workspaces', fixture.id);
  try {
    await mkdir(workspace, { recursive: true });
    await runCommand('git', ['init', '-b', 'feat/demo-slugify'], { cwd: workspace });
    await runCommand('git', ['config', 'commit.gpgsign', 'true'], { cwd: workspace });
    await runCommand('git', ['config', 'gpg.program', '/nonexistent-code-geist-test-signer'], { cwd: workspace });
    await prepareDemoWorkspace(fixture, temp, new AbortController().signal);
    const commit = await runCommand('git', ['log', '-1', '--format=%B'], { cwd: workspace });
    assert.equal(commit.exitCode, 0);
    assert.match(commit.output, /Signed-off-by: Code Geist Demo/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('test processes receive a minimal environment without provider credentials', async () => {
  const prior = process.env.GEIST_TEST_API_KEY;
  process.env.GEIST_TEST_API_KEY = 'do-not-pass';
  try {
    assert.equal(childEnvironment().GEIST_TEST_API_KEY, undefined);
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(String(process.env.GEIST_TEST_API_KEY))'], { cwd: os.tmpdir() });
    assert.equal(result.output, 'undefined');
  } finally {
    if (prior === undefined) delete process.env.GEIST_TEST_API_KEY; else process.env.GEIST_TEST_API_KEY = prior;
  }
});

test('exported patch applies cleanly with a spaced new filename and no final newline', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-patch-'));
  const fixture = run();
  try {
    await prepareDemoWorkspace(fixture, temp, new AbortController().signal);
    const workspace = fixture.workspace!;
    await writeWorkspaceFile(workspace, 'src/slugify.js', DEMO_FIX);
    await writeWorkspaceFile(workspace, 'new file.txt', 'new content without a final newline');
    const result = await workspaceDiff(workspace, fixture.baseCommit!);
    assert.equal(result.files.length, 2);
    assert.match(result.diff, /No newline at end of file/);
    const patchFile = path.join(temp, 'changes.patch');
    await writeFile(patchFile, result.diff);
    await runCommand('git', ['restore', '--worktree', '.'], { cwd: workspace });
    await rm(path.join(workspace, 'new file.txt'));
    const check = await runCommand('git', ['apply', '--check', patchFile], { cwd: workspace });
    assert.equal(check.exitCode, 0, check.output);
    const applied = await runCommand('git', ['apply', patchFile], { cwd: workspace });
    assert.equal(applied.exitCode, 0, applied.output);
    assert.equal(await readFile(path.join(workspace, 'new file.txt'), 'utf8'), 'new content without a final newline');
    assert.equal(await readFile(path.join(workspace, 'src/slugify.js'), 'utf8'), DEMO_FIX);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('live preparation isolates HEAD and preserves the original dirty checkout', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-isolation-'));
  const seed = run('source');
  try {
    await prepareDemoWorkspace(seed, temp, new AbortController().signal);
    const original = await readWorkspaceFile(seed.workspace!, 'src/slugify.js');
    await writeWorkspaceFile(seed.workspace!, 'src/slugify.js', original + '\n// local uncommitted change\n');
    const live = { ...run('isolated'), mode: 'live' as const, repository: seed.workspace! };
    await prepareLiveWorkspace(live, temp, new AbortController().signal);
    assert.equal(await readWorkspaceFile(live.workspace!, 'src/slugify.js'), original);
    assert.match(await readWorkspaceFile(seed.workspace!, 'src/slugify.js'), /local uncommitted change/);
    assert.equal(live.branch, 'feat/agent-isolated');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('cancelling a command terminates the spawned process group', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'geist-cancel-'));
  const marker = path.join(temp, 'child-survived');
  const controller = new AbortController();
  try {
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 600);`;
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio: 'inherit'}); setInterval(() => {}, 1000);`;
    const command = runCommand(process.execPath, ['-e', parentCode], { cwd: temp, signal: controller.signal });
    await delay(180);
    controller.abort();
    await assert.rejects(command);
    await delay(650);
    await assert.rejects(access(marker));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
