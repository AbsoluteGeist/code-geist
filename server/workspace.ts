import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile, Run } from '../shared/types.js';

const MAX_OUTPUT = 64_000;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next', 'coverage']);
export const MAX_FILE_BYTES = 512_000;

export function childEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TERM'];
  const result: NodeJS.ProcessEnv = { CI: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of names) if (process.env[name]) result[name] = process.env[name];
  return result;
}

export interface CommandResult { exitCode: number | null; output: string; timedOut: boolean; truncated: boolean }

/** Keeps output produced before cancellation while the command still rejects. */
export class CommandCancelledError extends Error {
  constructor(readonly result: CommandResult, reason: unknown) {
    super(reason instanceof Error ? reason.message : 'Command cancelled', { cause: reason });
    this.name = 'AbortError';
  }
}

export async function runCommand(
  executable: string, args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxOutput?: number; onOutput?: (delta: string) => Promise<void> | void },
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: childEnvironment(), shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let truncated = false;
    let pendingOutput = '';
    let outputDelivery = Promise.resolve();
    const flushOutput = () => {
      if (!pendingOutput || !options.onOutput) return;
      const delta = pendingOutput;
      pendingOutput = '';
      outputDelivery = outputDelivery.then(() => options.onOutput!(delta));
      void outputDelivery.catch(() => {});
    };
    const outputTimer = setInterval(flushOutput, 100);
    outputTimer.unref();
    const maxOutput = options.maxOutput ?? MAX_OUTPUT;
    const append = (data: Buffer) => {
      const text = data.toString('utf8');
      if (output.length + text.length > maxOutput) truncated = true;
      const accepted = text.slice(0, Math.max(0, maxOutput - output.length));
      output += accepted;
      pendingOutput += accepted;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* The child may already have exited. */ }
    };
    const abort = () => kill();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? 120_000);
    const cleanup = () => { clearTimeout(timer); clearInterval(outputTimer); flushOutput(); options.signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', async exitCode => {
      cleanup();
      try { await outputDelivery; } catch (error) { reject(error); return; }
      const result = { exitCode, timedOut, truncated, output: output + (truncated ? '\n[Output truncated]' : '') + (timedOut ? '\n[Command timed out]' : '') };
      if (options.signal?.aborted) { reject(new CommandCancelledError(result, options.signal.reason)); return; }
      resolve(result);
    });
  });
}

export function parseCommand(command: string): [string, ...string[]] {
  if (/[\r\n\0]/.test(command)) throw new Error('Test command must be a single line without null bytes.');
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let active = false;
  for (const ch of command) {
    if (escaped) { current += ch; escaped = false; active = true; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; active = true; continue; }
    if (quote) { if (ch === quote) quote = undefined; else current += ch; active = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; active = true; continue; }
    if (/\s/.test(ch)) { if (active) { args.push(current); current = ''; active = false; } continue; }
    if (/[|;&<>`\n\r]/.test(ch)) throw new Error('Test command must be one executable and its arguments; shell operators are unsupported.');
    current += ch; active = true;
  }
  if (quote || escaped) throw new Error('Test command has an unfinished quote or escape.');
  if (active) args.push(current);
  if (!args[0]) throw new Error('A test command is required, for example: npm test');
  return args as [string, ...string[]];
}

export function isProtectedPath(relative: string): boolean {
  return relative.split(/[\\/]/).some(segment => {
    const normalized = segment.toLowerCase();
    return normalized === '.git' || normalized === '.env' || normalized.startsWith('.env.');
  });
}

export async function safePath(root: string, relative: string, allowMissing = false): Promise<string> {
  if (!relative || relative.includes('\0') || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Use a workspace-relative path.');
  const segments = relative.split('/');
  if (segments.some(segment => segment === '..') || isProtectedPath(relative)) throw new Error('Path traversal and .git/.env access are forbidden.');
  const resolvedRoot = await realpath(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) throw new Error('Path is outside the workspace.');
  let partial = resolvedRoot;
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    partial = path.join(partial, segment);
    try {
      const entry = await lstat(partial);
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not accessible to agent tools.');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return target;
}

export async function listWorkspaceFiles(root: string, directory = '.'): Promise<string[]> {
  root = await realpath(root);
  const base = await safePath(root, directory);
  const files: string[] = [];
  let inspected = 0;
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++inspected > 10_000 || files.length >= 1_000) return;
      const relative = path.relative(root, path.join(current, entry.name)).split(path.sep).join('/');
      if (entry.isSymbolicLink() || isProtectedPath(relative)) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) await visit(path.join(current, entry.name)); }
      else if (entry.isFile()) files.push(relative);
    }
  }
  await visit(base);
  return files;
}

export async function readWorkspaceFile(root: string, relative: string): Promise<string> {
  const target = await safePath(root, relative);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Read requires a regular text file under ${MAX_FILE_BYTES} bytes.`);
  const content = await readFile(target, 'utf8');
  if (content.includes('\0')) throw new Error('Binary files are not supported.');
  return content;
}

export async function writeWorkspaceFile(root: string, relative: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0')) throw new Error('Write requires text under 512 KB.');
  const target = await safePath(root, relative, true);
  await mkdir(path.dirname(target), { recursive: true });
  await safePath(root, relative, true);
  await writeFile(target, content, 'utf8');
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, signal, timeoutMs: 30_000, maxOutput: 2_000_000 });
  if (result.exitCode !== 0) throw new Error(result.output.trim() || `git ${args[0]} failed`);
  if (result.truncated) throw new Error('Git output exceeds the 2 MB supported limit; narrow the task to export a complete patch.');
  return result.output;
}

export async function prepareLiveWorkspace(run: Run, dataDir: string, signal: AbortSignal): Promise<void> {
  const repo = await realpath(run.repository);
  const root = (await git(repo, ['rev-parse', '--show-toplevel'], signal)).trim();
  const base = (await git(root, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
  const workspace = path.resolve(dataDir, 'workspaces', run.id);
  const branch = `feat/agent-${run.id.replace(/[^a-z0-9-]/g, '').slice(0, 40)}`;
  await mkdir(path.dirname(workspace), { recursive: true });
  await git(root, ['worktree', 'add', '-b', branch, workspace, base], signal);
  run.workspace = workspace;
  run.branch = branch;
  run.baseCommit = base;
}

export async function initializeDemoGit(workspace: string, signal: AbortSignal): Promise<string> {
  await git(workspace, ['init', '-b', 'feat/demo-slugify'], signal);
  await git(workspace, ['add', '--', 'package.json', 'src/slugify.js', 'test/slugify.test.js', 'README.md'], signal);
  await git(workspace, ['-c', 'user.name=Code Geist Demo', '-c', 'user.email=demo@code-geist.local', '-c', 'commit.gpgsign=false', 'commit', '--signoff', '-m', 'chore: seed coding agent demo'], signal);
  return (await git(workspace, ['rev-parse', 'HEAD'], signal)).trim();
}

export interface WorkspaceDiff { diff: string; files: ChangedFile[]; fingerprint: string }

export async function workspaceDiff(root: string, base: string, signal?: AbortSignal): Promise<WorkspaceDiff> {
  const pathspec = ['--', '.', ':(exclude,glob,icase)**/.env', ':(exclude,glob,icase)**/.env.*'];
  const common = ['--no-ext-diff', '--no-textconv', '--no-renames', base];
  const [patch, stats, untracked, names] = await Promise.all([
    git(root, ['diff', ...common, ...pathspec], signal),
    git(root, ['diff', '--numstat', '-z', ...common, ...pathspec], signal),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal),
    git(root, ['diff', '--name-status', '-z', ...common, ...pathspec], signal),
  ]);
  const statuses = new Map<string, string>();
  const nameParts = names.split('\0');
  for (let i = 0; i + 1 < nameParts.length; i += 2) statuses.set(nameParts[i + 1], nameParts[i]);
  const files: ChangedFile[] = [];
  for (const row of stats.split('\0').filter(Boolean)) {
    const [added, deleted, ...name] = row.split('\t');
    const relative = name.join('\t');
    if (!relative || isProtectedPath(relative)) continue;
    const status: ChangedFile['status'] = statuses.get(relative) === 'A' ? 'added' : statuses.get(relative) === 'D' ? 'deleted' : 'modified';
    files.push({ path: relative, additions: Number(added) || 0, deletions: Number(deleted) || 0, status });
  }
  let diff = patch;
  const addedFiles = untracked.split('\0').filter(Boolean);
  if (addedFiles.length > 200) throw new Error('More than 200 new files exist; narrow the task before exporting the patch.');
  for (const relative of addedFiles) {
    if (isProtectedPath(relative) || relative.split('/').some(part => SKIP_DIRECTORIES.has(part))) continue;
    let content: string;
    try { content = await readWorkspaceFile(root, relative); } catch { continue; }
    const lines = content ? content.replace(/\n$/, '').split('\n') : [];
    files.push({ path: relative, additions: lines.length, deletions: 0, status: 'added' });
    const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', relative], { cwd: root, signal, timeoutMs: 30_000, maxOutput: 2_000_000 });
    if (result.truncated || (result.exitCode !== 0 && result.exitCode !== 1)) throw new Error('Unable to export a complete patch for a new file.');
    diff += result.output;
  }
  if (diff.length > 2_000_000) throw new Error('Patch exceeds the 2 MB supported limit; narrow the task before review.');
  const fingerprint = createHash('sha256').update(diff).digest('hex');
  return { diff, files, fingerprint };
}
