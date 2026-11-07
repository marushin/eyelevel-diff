import { defineConfig, type UserConfig } from 'vite';

export interface PrototypeViteOptions {
  slug?: string;
  port?: number;
  overrides?: UserConfig;
}

/**
 * Shared Vite configuration helper reading `process.env.PUBLIC_BASE_PATH || './'`
 * so every prototype runs identically under `/p/<slug>/` in the Lab Gateway and `/`
 * when promoted as the production Flagship.
 */
export function definePrototypeViteConfig(options: PrototypeViteOptions = {}): UserConfig {
  const base = process.env.PUBLIC_BASE_PATH || './';

  return defineConfig({
    base,
    server: {
      ...(options.port ? { port: options.port, strictPort: true } : {}),
      host: '127.0.0.1',
    },
    worker: {
      format: 'es',
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
    ...options.overrides,
  });
}
