import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const host = env.HOST?.trim() || '0.0.0.0';
  const port = Number(env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const apiHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const proxyHost = apiHost.includes(':') ? `[${apiHost}]` : apiHost;
  return {
    plugins: [react()],
    server: {
      host,
      port: 5173,
      strictPort: true,
      allowedHosts: true,
      proxy: {
        '/api': { target: `http://${proxyHost}:${port}`, changeOrigin: false },
      },
    },
  };
});
