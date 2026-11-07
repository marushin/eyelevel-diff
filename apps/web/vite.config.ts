import { defineConfig } from 'vite';

// There is no backend: /search, /deconstruct and /preview are answered inside the page (src/local/).
export default defineConfig({
  base: '/',
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
  },
  // transformers.js ships its own WASM loader; pre-bundling it breaks the worker's dynamic imports.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: '../../dist', emptyOutDir: true },
});
