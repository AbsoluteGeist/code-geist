import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { createServer as createViteServer } from 'vite';
import viteConfig from '../vite.config.js';

test('API and project Vite config accept arbitrary hosts while preserving origin checks and LAN access', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'geist-lan-'));
  let executions = 0;
  const instance = await createApp({ dataDir, execute: async (run, options) => {
    executions++;
    run.status = 'completed';
    run.phase = 'complete';
    await options.onUpdate();
  } });
  const server = instance.app.listen(0, '0.0.0.0');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    instance.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  const send = (headers: Record<string, string>, route = '/api/config', body?: string, destinationPort = port) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: destinationPort, path: route, method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (route.endsWith('/events') && text.includes('\n\n')) {
          resolve({ status: res.statusCode!, body: text });
          req.destroy();
        }
      });
      res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });

  const host = `192.168.1.20:${port}`;
  const origin = `http://${host}`;
  assert.equal((await send({ Host: host, Origin: origin })).status, 200);
  assert.equal((await send({ Host: `geist.local:${port}`, Origin: `http://geist.local:${port}` })).status, 200);
  assert.equal((await send({ Host: `unregistered-custom.example:${port}`, Origin: `http://unregistered-custom.example:${port}` })).status, 200);
  assert.equal((await send({ Host: 'another-arbitrary-domain.example' })).status, 200);
  assert.equal((await send({ Host: `[::1]:${port}`, Origin: `http://[::1]:${port}` })).status, 200);
  assert.equal((await send({ Host: host })).status, 200);
  for (const foreign of ['https://attacker.example', 'null', `http://192.168.1.21:${port}`, 'http://192.168.1.20:9999', `${origin}/path`]) {
    assert.equal((await send({ Host: host, Origin: foreign }, '/api/runs', '{"mode":"demo"}')).status, 403);
  }
  assert.equal((await send({ Host: `unregistered-custom.example:${port}`, Origin: origin, 'X-Forwarded-Host': host })).status, 403, 'Forwarded Host must not bypass an actual Origin mismatch');
  assert.equal((await send({ Host: host, Origin: `https://${host}`, 'X-Forwarded-Proto': 'https' })).status, 403, 'Forwarded protocol must not bypass an actual Origin mismatch');
  assert.equal((await send({ Host: host, Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(executions, 0, 'Rejected requests must not start tasks');

  const created = await send({ Host: host, Origin: origin }, '/api/runs', '{"mode":"demo"}');
  assert.equal(created.status, 201);
  const run = JSON.parse(created.body);
  const stream = await send({ Host: host }, `/api/runs/${run.id}/events`);
  assert.equal(stream.status, 200);
  assert.match(stream.body, /event: snapshot/);
  assert.equal(executions, 1);

  // Use the application's actual Vite config to verify host acceptance and proxy authority.
  const priorHost = process.env.HOST;
  const priorPort = process.env.PORT;
  process.env.HOST = '0.0.0.0';
  process.env.PORT = String(port);
  let projectConfig;
  try {
    projectConfig = await viteConfig({ command: 'serve', mode: 'test' });
  } finally {
    if (priorHost === undefined) delete process.env.HOST; else process.env.HOST = priorHost;
    if (priorPort === undefined) delete process.env.PORT; else process.env.PORT = priorPort;
  }
  const serverConfig = projectConfig.server;
  assert.ok(serverConfig);
  assert.equal(serverConfig.allowedHosts, true);
  const apiProxy = serverConfig.proxy?.['/api'];
  assert.ok(apiProxy && typeof apiProxy !== 'string');
  assert.equal(apiProxy.changeOrigin, false);
  const vite = await createViteServer({ ...projectConfig, configFile: false, logLevel: 'silent', server: { ...serverConfig, port: 0, strictPort: false, ws: false } });
  try {
    await vite.listen();
    const proxyPort = (vite.httpServer!.address() as AddressInfo).port;
    const customHost = `unregistered-custom.example:${proxyPort}`;
    const proxyOrigin = `http://${customHost}`;
    const page = await send({ Host: customHost }, '/', undefined, proxyPort);
    assert.equal(page.status, 200, 'An arbitrary custom hostname must reach the Vite frontend');
    assert.match(page.body, /<div id="root"><\/div>/);
    const response = await send({ Host: customHost, Origin: proxyOrigin }, '/api/runs', '{"mode":"demo"}', proxyPort);
    assert.equal(response.status, 201, 'Same-origin browser POST must pass through Vite');
    const rejected = await send({ Host: customHost, Origin: 'http://different-origin.example' }, '/api/runs', '{"mode":"demo"}', proxyPort);
    assert.equal(rejected.status, 403);
  } finally {
    await vite.close();
  }

  // This uses the real interface address instead of merely faking the Host header.
  const address = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;
  if (address) {
    const response = await fetch(`http://${address}:${port}/api/config`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
  }
});
