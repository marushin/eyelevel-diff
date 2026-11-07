import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSearchServer } from '../apps/api/server.js';

async function listen(t, options) {
  const server = createSearchServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('production serves only frontend entry/assets and keeps the search contract', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'card-stack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const frontendDir = join(dir, 'dist');
  await mkdir(join(frontendDir, 'assets'), { recursive: true });
  await writeFile(join(frontendDir, 'index.html'), '<main>Card Stack</main>');
  await writeFile(join(frontendDir, 'assets/app.js'), 'console.log("cards")');
  await writeFile(join(frontendDir, 'assets/style.css'), 'body{margin:0}');
  await writeFile(join(frontendDir, 'assets/horse.gif'), 'GIF89a');
  await writeFile(join(dir, '.env'), 'SECRET=private');
  await symlink(join(dir, '.env'), join(frontendDir, 'assets/leak.js'));
  let calls = 0;
  const base = await listen(t, { frontendDir, fetchImpl: () => { calls++; throw new Error('unexpected upstream'); } });
  for (const [path, mime] of [['/', 'text/html'], ['/assets/app.js', 'text/javascript'],
    ['/assets/style.css', 'text/css'], ['/assets/horse.gif', 'image/gif']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(mime));
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
  }
  for (const path of ['/.env', '/server.js', '/apps/api/server.js', '/package.json',
    '/API_SPEC.html', '/assets/../.env', '/assets/%2e%2e%2f.env', '/assets/leak.js',
    '/assets/missing.js', '/assets/%00.js', '/deconstruct?url=https://example.com']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const post = await fetch(base + '/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const search = await fetch(base + '/search?query=art&goodCount=0&awesomeCount=0');
  assert.equal(search.status, 200);
  assert.deepEqual(await search.json(), { good: [], awesome: {} });
  assert.equal(calls, 0);
});

test('disconnecting a search cancels its upstream work', async t => {
  let started;
  let cancelled;
  const began = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const base = await listen(t, {
    apiKey: 'test',
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true });
      started();
    }),
  });
  const controller = new AbortController();
  const pending = fetch(base + '/search?query=art&awesomeCount=0', { signal: controller.signal });
  await began;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await aborted;
});

test('deconstruct proxy forwards only the public route and survives a stopped service', async t => {
  const seen = [];
  const upstream = createServer((request, response) => {
    seen.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ contents: [], weights: [] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const base = await listen(t, { deconstructOrigin: `http://127.0.0.1:${upstream.address().port}` });

  const ok = await fetch(`${base}/deconstruct?url=${encodeURIComponent('https://example.com/?a=1')}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { contents: [], weights: [] });
  assert.deepEqual(seen, ['/deconstruct?url=https%3A%2F%2Fexample.com%2F%3Fa%3D1']);

  assert.equal((await fetch(`${base}/deconstruct/phrases?text=a`)).status, 200);
  assert.equal(seen.pop(), '/deconstruct/phrases?text=a');
  assert.equal((await fetch(`${base}/deconstruct?url=x`, { method: 'POST' })).status, 405);
  for (const path of ['/health', '/debug/extract?url=x', '/deconstruct/../health']) {
    assert.equal(seen.includes(path), false);
    await fetch(base + path);
  }
  assert.deepEqual(seen, ['/deconstruct?url=https%3A%2F%2Fexample.com%2F%3Fa%3D1']);

  const stopped = await listen(t, { deconstructOrigin: 'http://127.0.0.1:1' });
  const failure = await fetch(`${stopped}/deconstruct?url=x`);
  assert.equal(failure.status, 502);
  assert.equal((await failure.json()).error.code, 'DECONSTRUCT_UNAVAILABLE');
});
