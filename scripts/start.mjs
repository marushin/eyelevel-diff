import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSearchServer } from '../apps/api/server.js';
import { serverConfig } from './config.mjs';
import { deconstructConfig, startDeconstruct } from './deconstruct.mjs';

try {
  const frontendDir = fileURLToPath(new URL('../dist', import.meta.url));
  try { await access(`${frontendDir}/index.html`); }
  catch { throw new Error('Frontend build is missing. Run pnpm build first.'); }
  const { port, options } = serverConfig();
  const deconstructService = deconstructConfig();
  const deconstruct = deconstructService.enabled ? startDeconstruct(deconstructService, { NODE_ENV: 'production' }) : null;
  const server = createSearchServer({
    ...options, frontendDir, ...(deconstruct ? { deconstructOrigin: deconstructService.origin } : {}),
  });
  server.on('error', (error) => {
    console.error(`Server failed to start: ${error.code ?? 'unknown error'}`);
    deconstruct?.stop();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    deconstruct?.stop(); server.close(); server.closeAllConnections();
  });
  server.listen(port, () => console.log(`Card Stack: http://localhost:${port}`));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
