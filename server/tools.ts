import { z } from 'zod';
import type { Run, RunEvent } from '../shared/types.js';
import type { ToolDefinition } from './providers.js';
import { listWorkspaceFiles, parseCommand, readWorkspaceFile, runCommand, writeWorkspaceFile } from './workspace.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { type: 'function', function: { name: 'list_files', description: 'List regular workspace files; dependency/build directories and sensitive paths are omitted.', parameters: { type: 'object', properties: { directory: { type: 'string', description: 'Relative directory; defaults to the workspace root.' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'read_file', description: 'Read UTF-8 source or tests with explicit line pagination. The result reports totalLines and whether more content remains; read every page before replacing an existing file.', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'search_files', description: 'Search text literally across source files. Relevant candidates are ranked before returning context.', parameters: { type: 'object', properties: { query: { type: 'string' }, directory: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace a complete UTF-8 file in the isolated workspace. Read existing files before editing.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
  { type: 'function', function: { name: 'run_tests', description: 'Run the user-configured test command. You cannot replace this command. A passing result is required after the last change.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'finish', description: 'Finish only after there is a meaningful code diff and tests pass on the current revision. Report the changes and verification.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } },
];

const schemas = {
  list_files: z.object({ directory: z.string().min(1).max(500).optional() }).strict(),
  read_file: z.object({ path: z.string().min(1).max(500), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict(),
  search_files: z.object({ query: z.string().min(1).max(200), directory: z.string().min(1).max(500).optional() }).strict(),
  write_file: z.object({ path: z.string().min(1).max(500), content: z.string().max(512_000) }).strict(),
  run_tests: z.object({}).strict(),
  finish: z.object({ summary: z.string().min(1).max(8_000) }).strict(),
};

export interface ContextCandidate { path: string; content: string; line: number }
export interface ToolContext {
  run: Run;
  signal: AbortSignal;
  revision: number;
  syncDiff: () => Promise<void>;
  emit: (event: Omit<RunEvent, 'id' | 'at'>) => Promise<void>;
  rankContext: (candidates: ContextCandidate[]) => Promise<ContextCandidate[]>;
  classifyFailure: (output: string) => Promise<string>;
}

export async function executeTool(name: string, rawArgs: unknown, context: ToolContext): Promise<{ output: string; finished: boolean }> {
  context.signal.throwIfAborted();
  if (!Object.hasOwn(schemas, name)) throw new Error(`Unknown tool: ${name}`);
  const args = schemas[name as keyof typeof schemas].parse(rawArgs);
  const root = context.run.workspace;
  if (!root) throw new Error('Workspace is not ready.');
  let output: string;
  switch (name) {
    case 'list_files': {
      const input = args as z.infer<typeof schemas.list_files>;
      const files = await listWorkspaceFiles(root, input.directory);
      output = JSON.stringify({ files, truncated: files.length >= 1_000 });
      break;
    }
    case 'read_file': {
      const input = args as z.infer<typeof schemas.read_file>;
      const content = await readWorkspaceFile(root, input.path);
      const lines = content.split('\n');
      const start = input.startLine ?? 1;
      const requestedEnd = input.endLine ?? Math.min(lines.length, start + 399);
      if (start > lines.length || requestedEnd < start) throw new Error('Requested line range is outside the file.');
      let end = Math.min(requestedEnd, lines.length, start + 1999);
      let selected = lines.slice(start - 1, end).join('\n');
      while (selected.length > 35_000 && end > start) {
        end--;
        selected = lines.slice(start - 1, end).join('\n');
      }
      if (selected.length > 35_000) throw new Error('This line exceeds the 35 KB read limit. Use a more focused source file.');
      output = JSON.stringify({ path: input.path, startLine: start, endLine: end, totalLines: lines.length, truncated: start !== 1 || end < lines.length, nextStartLine: end < lines.length ? end + 1 : null, content: selected });
      break;
    }
    case 'search_files': {
      const input = args as z.infer<typeof schemas.search_files>;
      const files = await listWorkspaceFiles(root, input.directory);
      const candidates: ContextCandidate[] = [];
      let matchedFiles = 0;
      for (const file of files.slice(0, 400)) {
        context.signal.throwIfAborted();
        let content: string;
        try { content = await readWorkspaceFile(root, file); } catch { continue; }
        const lines = content.split('\n');
        const first = lines.findIndex(line => line.includes(input.query));
        if (first < 0) continue;
        matchedFiles++;
        if (candidates.length < 15) candidates.push({ path: file, line: first + 1, content: lines.slice(Math.max(0, first - 3), first + 12).join('\n').slice(0, 4_000) });
      }
      const ranked = candidates.length ? await context.rankContext(candidates) : [];
      output = JSON.stringify({ matches: ranked, matchedFiles, scannedFiles: Math.min(files.length, 400), truncated: files.length > 400 || matchedFiles > 15 });
      break;
    }
    case 'write_file': {
      const input = args as z.infer<typeof schemas.write_file>;
      await writeWorkspaceFile(root, input.path, input.content);
      await context.syncDiff();
      output = JSON.stringify({ written: input.path, bytes: Buffer.byteLength(input.content), revision: context.revision, reminder: 'Run tests after the final edit.' });
      break;
    }
    case 'run_tests': {
      await context.syncDiff();
      const revision = context.revision;
      const [executable, ...argv] = parseCommand(context.run.testCommand);
      const result = await runCommand(executable, argv, { cwd: root, signal: context.signal, timeoutMs: 120_000 });
      await context.syncDiff();
      const passed = result.exitCode === 0 && !result.timedOut;
      context.run.verification = { command: context.run.testCommand, exitCode: result.exitCode, output: result.output, passed, at: new Date().toISOString(), revision };
      await context.emit({ type: 'verification', title: passed ? 'Tests passed' : 'Tests failed', message: `${context.run.testCommand} · exit ${result.exitCode ?? 'terminated'}`, status: passed ? 'success' : 'error', data: { ...context.run.verification, currentRevision: context.revision } });
      const routingHint = passed ? undefined : await context.classifyFailure(result.output);
      output = JSON.stringify({ ...context.run.verification, output: result.output.slice(-30_000), outputTruncated: result.output.length > 30_000 || result.truncated, currentRevision: context.revision, routingHint });
      break;
    }
    case 'finish': {
      const input = args as z.infer<typeof schemas.finish>;
      await context.syncDiff();
      if (!context.run.files.some(file => file.additions > 0 || file.deletions > 0)) throw new Error('Cannot finish: no meaningful file changes exist.');
      if (!context.run.verification?.passed) throw new Error('Cannot finish: run the configured tests and resolve failures first.');
      if (context.run.verification.revision !== context.revision) throw new Error('Cannot finish: files changed after the last verification; run tests again.');
      context.run.summary = input.summary;
      output = input.summary;
      return { output, finished: true };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
  return { output, finished: false };
}
