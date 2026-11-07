import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  server: {
    host: '127.0.0.1',
    // Allow rotating ngrok tunnel subdomains.
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.io'],
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
    proxy: {
      '/search': {
        target: `http://127.0.0.1:${process.env.PORT || 3000}`,
        timeout: 130_000,
        proxyTimeout: 130_000,
      },
      '/deconstruct': {
        target: `http://127.0.0.1:${process.env.DECONSTRUCT_PORT || 3001}`,
        timeout: 170_000,
        proxyTimeout: 170_000,
      },
      '/preview': {
        target: `http://127.0.0.1:${process.env.PORT || 3000}`,
        timeout: 15_000,
        proxyTimeout: 15_000,
      },
      '/preview-ws': {
        target: `ws://127.0.0.1:${process.env.PORT || 3000}`,
        ws: true,
      },
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: '../../dist', emptyOutDir: true },
});
