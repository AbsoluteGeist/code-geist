import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, ToolCall } from './providers.js';
import { runCommand } from './workspace.js';

export interface PendingTool {
  call: ToolCall;
  state: 'planned' | 'started' | 'result_saved';
  result?: { output: string; finished: boolean };
}

export interface Checkpoint {
  version: 1;
  runId: string;
  workspace: string;
  baseCommit: string;
  branch?: string;
  modelId?: string;
  revision: number;
  fingerprint: string;
  modelIteration: number;
  messages: ChatMessage[];
  pendingTools: PendingTool[];
  demoCursor: number;
  demoFollowup: boolean;
  setupComplete: boolean;
  setupState?: 'not_started' | 'started' | 'completed';
  updatedAt: string;
}

/** Adapt completed history for a different provider while keeping tool protocol intact. */
export function adaptConversationMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (message.role === 'assistant') return { role: 'assistant', content: message.content, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
    if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id };
    return message;
  });
}

function checkpointPath(dataDir: string, runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid checkpoint identifier.');
  return path.resolve(dataDir, 'checkpoints', `${runId}.json`);
}

/** Private provider continuation state. Never return this through the public trace API. */
export async function saveCheckpoint(dataDir: string, checkpoint: Checkpoint): Promise<void> {
  const target = checkpointPath(dataDir, checkpoint.runId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(`${target}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 });
  await rename(`${target}.tmp`, target);
}

export async function readCheckpoint(dataDir: string, runId: string): Promise<Checkpoint | null> {
  let text: string;
  try { text = await readFile(checkpointPath(dataDir, runId), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(text) as Checkpoint;
  if (value.version !== 1 || value.runId !== runId || !value.workspace || !value.baseCommit
    || !Array.isArray(value.messages) || !Array.isArray(value.pendingTools)
    || !Number.isInteger(value.revision) || !Number.isInteger(value.modelIteration)) throw new Error('Checkpoint is invalid or unsupported.');
  return value;
}

/** Close old tool batches without replaying commands with uncertain side effects. */
export function reconcilePendingTools(checkpoint: Checkpoint): number {
  let interrupted = 0;
  for (const pending of checkpoint.pendingTools) {
    const batchIndex = checkpoint.messages.findLastIndex(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === pending.call.id));
    if (checkpoint.messages.slice(batchIndex + 1).some(message => message.role === 'tool' && message.tool_call_id === pending.call.id)) continue;
    const content = pending.state === 'result_saved' && pending.result ? pending.result.output : JSON.stringify({
      interrupted: true,
      executed: pending.state === 'planned' ? false : 'unknown',
      error: pending.state === 'planned'
        ? 'This tool was not executed because the prior attempt stopped. Inspect the current workspace and plan a new action.'
        : 'The prior attempt stopped during this tool. Its outcome is unknown; it has not been replayed. Inspect the current workspace and verify before finishing.',
    });
    checkpoint.messages.push({ role: 'tool', tool_call_id: pending.call.id, content });
    if (pending.state !== 'result_saved') interrupted++;
  }
  checkpoint.pendingTools = [];
  return interrupted;
}

export async function validateCheckpointWorkspace(checkpoint: Pick<Checkpoint, 'workspace' | 'baseCommit' | 'branch'>, signal?: AbortSignal): Promise<void> {
  const root = await realpath(checkpoint.workspace);
  for (const [args, expected] of [
    [['rev-parse', '--show-toplevel'], root],
    [['rev-parse', 'HEAD'], checkpoint.baseCommit],
    ...(checkpoint.branch ? [[['symbolic-ref', '--short', 'HEAD'], checkpoint.branch]] : []),
  ] as Array<[string[], string]>) {
    const result = await runCommand('git', args, { cwd: root, signal, timeoutMs: 30_000 });
    const actual = args[1] === '--show-toplevel' && result.exitCode === 0 ? await realpath(result.output.trim()) : result.output.trim();
    if (result.exitCode !== 0 || actual !== expected) throw new Error('The retained workspace Git identity changed. Review its branch and HEAD before continuing.');
  }
}
