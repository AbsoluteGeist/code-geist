import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Run, AppConfig } from '../shared/types.js';
import { RunStore } from './store.js';
import { executeRun } from './harness.js';
import { DEMO_TASK } from './demo.js';
import { loadModelProfiles, getJevConfiguration } from './model-config.js';

const createSchema = z.object({
  mode: z.enum(['demo', 'live']),
  modelId: z.string().max(120).optional(),
  task: z.string().trim().max(12_000).optional(),
  repository: z.string().trim().max(4096).optional(),
  testCommand: z.string().trim().max(1000).optional(),
  setupCommand: z.string().trim().max(1000).optional(),
  maxSteps: z.number().int().min(6).max(60).optional(),
}).strict();

export async function createApp(options: {
  dataDir: string;
  cwd?: string;
  execute?: typeof executeRun;
}) {
  const app = express();
  app.disable('x-powered-by');
  const store = new RunStore(options.dataDir);
  await store.initialize();
  const controllers = new Map<string, AbortController>();
  const execute = options.execute ?? executeRun;
  const cwd = options.cwd ?? process.cwd();

  app.use((req, res, next) => {
    const hostname = req.hostname;
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
      res.status(403).json({ error: 'This workbench accepts localhost requests only.' });
      return;
    }
    const origin = req.get('origin');
    if (origin) {
      try {
        const url = new URL(origin);
        const ownPort = String(process.env.PORT || '4317');
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          || !['5173', ownPort, req.get('host')?.split(':').pop()].includes(url.port)) throw new Error();
      } catch {
        res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
        return;
      }
    }
    if (req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'Cross-site requests are not allowed.' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/config', (_req, res) => {
    let models: AppConfig['models'] = [];
    let jev = { configured: false, model: 'jev-1.13.0' };
    let configurationError: string | undefined;
    try {
      models = loadModelProfiles();
      jev = getJevConfiguration();
    } catch (error) {
      configurationError = error instanceof Error ? error.message : 'Model configuration could not be loaded.';
    }
    const config: AppConfig = {
      modelConfigured: models.some(model => model.configured),
      jevConfigured: jev.configured,
      model: models.find(model => model.configured)?.model ?? '',
      jevModel: jev.model,
      defaultRepository: cwd,
      demoTask: DEMO_TASK,
      models,
      configurationError,
    };
    res.json(config);
  });

  app.get('/api/runs', (_req, res) => res.json(store.list()));

  app.post('/api/runs', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
      return;
    }
    const input = parsed.data;
    if (controllers.size) {
      res.status(409).json({ error: 'A task is already running. Stop it or wait for it to finish.' });
      return;
    }
    if (input.mode === 'live') {
      if (!input.task || !input.repository || !input.testCommand) {
        res.status(400).json({ error: 'A task, absolute repository path, and verification command are required.' });
        return;
      }
      if (!path.isAbsolute(input.repository)) {
        res.status(400).json({ error: 'Repository must be an absolute path to a local Git repository.' });
        return;
      }
      const available = loadModelProfiles().filter(model => model.configured);
      if (!available.length) {
        res.status(400).json({ error: 'Configure a model and its API key in .env or models.config.json before running a live task.' });
        return;
      }
      if (input.modelId && input.modelId !== 'auto' && !available.some(model => model.id === input.modelId)) {
        res.status(400).json({ error: 'The selected model is unavailable or its API key is not configured.' });
        return;
      }
    }
    const now = new Date().toISOString();
    const task = input.mode === 'demo' ? DEMO_TASK : input.task!;
    const firstLine = task.split('\n')[0];
    const title = input.mode === 'demo' ? 'Fix Unicode and separator handling in slugify'
      : firstLine.length > 100 ? `${firstLine.slice(0, 97).trimEnd()}…` : firstLine;
    const run: Run = {
      id: randomUUID(), title, task,
      mode: input.mode, modelId: input.modelId ?? 'auto',
      status: 'queued', phase: 'prepare', createdAt: now, updatedAt: now,
      repository: input.mode === 'demo' ? 'Built-in demo repository' : input.repository!,
      testCommand: input.mode === 'demo' ? 'node --test' : input.testCommand!,
      setupCommand: input.mode === 'live' ? input.setupCommand || undefined : undefined,
      maxSteps: input.maxSteps ?? 24, step: 0, events: [], files: [], diff: '',
      metrics: { modelCalls: 0, jevCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    };
    const controller = new AbortController();
    controllers.set(run.id, controller);
    try {
      await store.save(run);
    } catch (error) {
      controllers.delete(run.id);
      throw error;
    }
    res.status(201).json(run);
    void execute(run, { dataDir: options.dataDir, signal: controller.signal, onUpdate: () => store.save(run) })
      .catch(async (error: unknown) => {
        run.status = controller.signal.aborted ? 'cancelled' : 'failed';
        run.error = error instanceof Error ? error.message : 'Run failed unexpectedly.';
        run.events.push({ id: randomUUID(), at: new Date().toISOString(), type: 'error', title: 'Run stopped', message: run.error, status: 'error' });
        await store.save(run);
      }).finally(() => controllers.delete(run.id))
      .catch(() => console.error('Could not persist the final run state. Check the data directory.'));
  });

  app.param('id', (req, res, next, id: string) => {
    if (!store.runs.has(id)) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }
    next();
  });

  app.get('/api/runs/:id', (req, res) => res.json(store.runs.get(String(req.params.id))));

  app.get('/api/runs/:id/events', (req, res) => {
    const id = String(req.params.id);
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (run: Run) => res.write(`event: snapshot\ndata: ${JSON.stringify(run)}\n\n`);
    store.events.on(id, send);
    send(store.runs.get(id)!);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off(id, send);
    });
  });

  app.post('/api/runs/:id/cancel', async (req, res) => {
    const id = String(req.params.id);
    const run = store.runs.get(id)!;
    const controller = controllers.get(id);
    if (controller && !controller.signal.aborted && (run.status === 'queued' || run.status === 'running')) {
      controller.abort();
      run.status = 'cancelled';
      run.events.push({ id: randomUUID(), at: new Date().toISOString(), type: 'phase', title: 'Cancellation requested', message: 'Stopping the current operation. Workspace and execution records are retained.', status: 'info' });
      await store.save(run);
    }
    res.json(run);
  });

  app.get('/api/runs/:id/patch', (req, res) => {
    const run = store.runs.get(String(req.params.id))!;
    res.type('text/plain').attachment(`code-geist-${run.id.slice(0, 8)}.patch`).send(run.diff);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  const dist = path.resolve(cwd, 'dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text').send('Code Geist API is running. Use npm run dev for the workbench, or npm run build before npm start.'));
  }
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(error.message);
    res.status(error.status ?? 500).json({ error: error.status === 400 ? 'Invalid JSON request body.' : 'The server could not complete this request. Check the local server log.' });
  });

  return { app, store, close: () => { for (const controller of controllers.values()) controller.abort(); } };
}
