import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DECONSTRUCT_PORT = 3001;

/** The deconstruct service needs about 1.5 GB, so teams can opt out with DECONSTRUCT_ENABLED=false. */
export function deconstructConfig(env = process.env) {
  const port = Number(env.DECONSTRUCT_PORT ?? DEFAULT_DECONSTRUCT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DECONSTRUCT_PORT must be an integer from 1 to 65535');
  return { enabled: env.DECONSTRUCT_ENABLED !== 'false', port, origin: `http://127.0.0.1:${port}` };
}

/** Search keeps working if this child fails, so its failure is reported instead of being fatal. */
export function startDeconstruct({ port }, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: fileURLToPath(new URL('../apps/deconstruct/', import.meta.url)),
    // The service always stays on loopback; only the /deconstruct proxy is reachable from outside.
    env: { LOG_LEVEL: 'warn', ...process.env, ...extraEnv, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let stopping = false;
  child.once('error', (error) => { console.error(`Deconstruct API failed to start: ${error.message}`); });
  child.once('exit', (code) => {
    if (!stopping) console.error(`Deconstruct API stopped (exit ${code ?? 'signal'}). Search continues; 분해 is unavailable.`);
  });
  return { stop() { stopping = true; if (child.exitCode === null) child.kill('SIGTERM'); } };
}
