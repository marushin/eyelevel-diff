import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createSearchServer } from '../apps/api/server.js';
import { serverConfig } from './config.mjs';
import { deconstructConfig, startDeconstruct } from './deconstruct.mjs';

let api;
let web;
let deconstruct;
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  deconstruct?.stop();
  if (api) { api.close(); api.closeAllConnections(); }
  await web?.close();
  process.exitCode = code;
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });

try {
  const { port, options } = serverConfig();
  const deconstructService = deconstructConfig();
  if (deconstructService.enabled) deconstruct = startDeconstruct(deconstructService);
  api = createSearchServer({ ...options, searchLogger: console.log });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(port, '127.0.0.1', resolve);
  });
  web = await createServer({ root: fileURLToPath(new URL('../apps/web', import.meta.url)) });
  await web.listen();
  console.log(`Query API: http://127.0.0.1:${port}`);
  web.printUrls();
} catch (error) {
  console.error(error.message);
  await close(1);
}
