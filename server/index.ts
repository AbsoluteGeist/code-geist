import 'dotenv/config';
import path from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 4317);
const { app, close } = await createApp({ dataDir: path.resolve(process.env.CODEGEIST_DATA_DIR || '.codegeist') });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Code Geist API → http://127.0.0.1:${port}`);
});
for (const event of ['SIGTERM', 'SIGINT'] as const) {
  process.once(event, () => {
    close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref();
  });
}
