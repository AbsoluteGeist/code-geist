import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Run } from '../shared/types.js';
import { initializeDemoGit, writeWorkspaceFile } from './workspace.js';

export const DEMO_TASK = 'Fix slugify so it removes accents, trims surrounding whitespace, collapses repeated separators, and returns an empty string for punctuation-only input. Add regression coverage and run the tests.';

export const DEMO_FIX = `/** Convert a display label to a stable, ASCII URL slug. */
export function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

export const DEMO_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('lowercases simple labels', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('normalizes accents and surrounding whitespace', () => {
  assert.equal(slugify('  Crème Brûlée  '), 'creme-brulee');
});

test('collapses whitespace and repeated separators', () => {
  assert.equal(slugify('one  -- two___three'), 'one-two-three');
});

test('punctuation-only labels produce an empty slug', () => {
  assert.equal(slugify(' ! --- ___ '), '');
});

test('keeps digits and handles empty labels', () => {
  assert.equal(slugify('Version 2.0'), 'version-2-0');
  assert.equal(slugify(''), '');
});

test('normalizes precomposed and decomposed accents identically', () => {
  assert.equal(slugify('Café'), slugify('Cafe\\u0301'));
});
`;

export async function prepareDemoWorkspace(run: Run, dataDir: string, signal: AbortSignal): Promise<void> {
  const workspace = path.resolve(dataDir, 'workspaces', run.id);
  await mkdir(workspace, { recursive: true });
  await writeWorkspaceFile(workspace, 'package.json', JSON.stringify({ name: 'slugify-demo', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  await writeWorkspaceFile(workspace, 'README.md', '# Slugify demo\n\nA small utility with a reproducible bug. Run `node --test` to verify behavior.\n');
  await writeWorkspaceFile(workspace, 'src/slugify.js', `/** Convert a display label to a URL slug. */\nexport function slugify(value) {\n  return value.toLowerCase().replaceAll(' ', '-');\n}\n`);
  // The initial fixture includes real failing cases; later steps add regression coverage.
  await writeWorkspaceFile(workspace, 'test/slugify.test.js', DEMO_TESTS.slice(0, DEMO_TESTS.indexOf("test('keeps digits")));
  run.baseCommit = await initializeDemoGit(workspace, signal);
  run.workspace = workspace;
  run.branch = 'feat/demo-slugify';
  run.testCommand = 'node --test';
}

export const DEMO_STEPS: Array<{ name: string; args: Record<string, unknown>; message: string }> = [
  { name: 'list_files', args: {}, message: 'Locate the source utility and its existing tests.' },
  { name: 'run_tests', args: {}, message: 'Reproduce the reported behavior with the real test runner.' },
  { name: 'search_files', args: { query: 'slugify' }, message: 'Find the implementation and every existing test that uses it.' },
  { name: 'read_file', args: { path: 'src/slugify.js' }, message: 'Inspect how the current implementation handles separators and accents.' },
  { name: 'read_file', args: { path: 'test/slugify.test.js' }, message: 'Read the assertions before choosing a focused fix.' },
  { name: 'write_file', args: { path: 'src/slugify.js', content: DEMO_FIX }, message: 'Normalize accents, collapse non-alphanumeric runs, and trim edge separators.' },
  { name: 'write_file', args: { path: 'test/slugify.test.js', content: DEMO_TESTS }, message: 'Add regressions for empty input, digits, and decomposed Unicode accents.' },
  { name: 'run_tests', args: {}, message: 'Verify the final implementation with the complete Node test suite.' },
  { name: 'finish', args: { summary: 'Fixed slugify with Unicode accent normalization, consistent separator collapsing, and edge trimming. Added regression coverage for digits, empty input, and decomposed accents. All six tests pass in the isolated demo workspace.' }, message: 'The changed files and passing verification are ready for review.' },
];
