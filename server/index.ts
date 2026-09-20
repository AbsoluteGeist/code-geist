import 'dotenv/config';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const host = process.env.HOST?.trim() || '0.0.0.0';
const { app, close } = await createApp({ dataDir: path.resolve(process.env.CODEGEIST_DATA_DIR || '.codegeist') });
const server = app.listen(port, host, () => {
  const addresses = new Set<string>();
  if (host === '0.0.0.0' || host === '::') {
    addresses.add(host === '::' ? '::1' : '127.0.0.1');
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal || (host === '0.0.0.0' && entry.family !== 'IPv4')) continue;
        // Link-local IPv6 addresses need interface scopes and are not portable browser URLs.
        if (entry.address.toLowerCase().startsWith('fe80:') || entry.address.includes('%')) continue;
        addresses.add(entry.address);
      }
    }
  } else {
    addresses.add(host);
  }
  for (const address of addresses) {
    const urlHost = address.includes(':') ? `[${address}]` : address;
    console.log(`Code Geist API → http://${urlHost}:${port}`);
  }
});
let shuttingDown = false;
for (const event of ['SIGTERM', 'SIGINT'] as const) {
  process.once(event, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    setTimeout(() => process.exit(0), 5000).unref();
    void close().finally(() => { server.closeAllConnections(); process.exit(0); });
  });
}
