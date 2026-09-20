import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run, RunSummary } from '../shared/types.js';

export class RunStore {
  readonly runs = new Map<string, Run>();
  readonly events = new EventEmitter();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(readonly dataDir: string) {
    this.events.setMaxListeners(100);
  }

  async initialize() {
    const directory = path.join(this.dataDir, 'runs');
    await mkdir(directory, { recursive: true });
    for (const filename of await readdir(directory)) {
      if (!/^[a-f0-9-]+\.json$/.test(filename)) continue;
      try {
        const run = JSON.parse(await readFile(path.join(directory, filename), 'utf8')) as Run;
        if (!run.id || !Array.isArray(run.events) || !run.metrics) continue;
        this.runs.set(run.id, run);
        if (run.status === 'running' || run.status === 'queued') {
          run.status = 'failed';
          run.error = 'The server restarted before this run finished. Start a new run to continue.';
          run.events.push({ id: randomUUID(), at: new Date().toISOString(), type: 'error', title: 'Run interrupted', message: run.error, status: 'error' });
          await this.save(run);
        }
      } catch {
        console.warn(`Skipped an unreadable run record: ${filename}`);
      }
    }
  }

  list(): RunSummary[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ events: _events, diff: _diff, ...summary }) => summary);
  }

  save(run: Run): Promise<void> {
    run.updatedAt = new Date().toISOString();
    this.runs.set(run.id, run);
    const snapshot = structuredClone(run);
    const previous = this.writes.get(run.id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const target = path.join(this.dataDir, 'runs', `${run.id}.json`);
      await writeFile(`${target}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(`${target}.tmp`, target);
      this.events.emit(run.id, snapshot);
    });
    this.writes.set(run.id, pending);
    void pending.finally(() => {
      if (this.writes.get(run.id) === pending) this.writes.delete(run.id);
    }).catch(() => {});
    return pending;
  }
}
