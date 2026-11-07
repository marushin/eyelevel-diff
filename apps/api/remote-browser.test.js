import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createSearchServer } from './server.js';
import { resolveChromeExecutable } from './remote-browser.js';

async function listen(t, options) {
  const server = createSearchServer({
    apiKey: 'test-serp',
    anthropicApiKey: 'test-anthropic',
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return {
    httpBase: `http://127.0.0.1:${server.address().port}`,
    wsBase: `ws://127.0.0.1:${server.address().port}`,
  };
}

test('WebSocket /preview-ws streams binary JPEG frames, state updates, and forwards client actions', async (t) => {
  const receivedActions = [];
  let closedCount = 0;

  const { wsBase } = await listen(t, {
    remoteSessionFactory: async (url, viewport, callbacks) => {
      assert.equal(url, 'https://example.com/article');
      assert.equal(viewport.width, 900);
      assert.equal(viewport.height, 600);
      callbacks.onState({
        url,
        title: 'Example Article',
        canGoBack: false,
        canGoForward: false,
        loading: false,
      });
      callbacks.onCursor('pointer');
      let acked = false;
      callbacks.onFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), () => {
        acked = true;
      });
      assert.equal(acked, true);
      return {
        async handleAction(action) {
          receivedActions.push(action);
        },
        async close() {
          closedCount++;
        },
      };
    },
  });

  const ws = new WebSocket(
    `${wsBase}/preview-ws?url=${encodeURIComponent('https://example.com/article')}&w=900&h=600&dpr=2`,
  );
  ws.binaryType = 'arraybuffer';

  const jsonMessages = [];
  const binaryPackets = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS frames')), 5_000);
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        jsonMessages.push(JSON.parse(event.data));
      } else {
        binaryPackets.push(new Uint8Array(event.data));
      }
      if (jsonMessages.length >= 2 && binaryPackets.length >= 1) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.addEventListener('error', reject, { once: true });
  });

  assert.deepEqual(jsonMessages[0], {
    type: 'state',
    url: 'https://example.com/article',
    title: 'Example Article',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  });
  assert.deepEqual(jsonMessages[1], { type: 'cursor', cursor: 'pointer' });
  assert.deepEqual([...binaryPackets[0]], [0x01, 0xff, 0xd8, 0xff, 0xd9]);

  ws.send(JSON.stringify({ type: 'wheel', x: 200, y: 150, deltaX: 0, deltaY: 240 }));
  ws.send(JSON.stringify({ type: 'mouse', event: 'mousePressed', x: 100, y: 80, button: 'left', buttons: 1 }));
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(receivedActions.length, 2);
  assert.equal(receivedActions[0].type, 'wheel');
  assert.equal(receivedActions[1].type, 'mouse');

  ws.close();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(closedCount, 1);
});

test('WebSocket /preview-ws rejects SSRF private/loopback targets by default', async (t) => {
  const { wsBase } = await listen(t, {});
  const ws = new WebSocket(
    `${wsBase}/preview-ws?url=${encodeURIComponent('http://127.0.0.1:8080/internal')}`,
  );

  const errorMsg = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Expected unsafe_url error')), 5_000);
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'error') {
          clearTimeout(timer);
          resolve(parsed);
        }
      }
    });
    ws.addEventListener('error', reject, { once: true });
  });

  assert.equal(errorMsg.reason, 'unsafe_url');
  ws.close();
});

test('Headless Chrome CDP integration absorbs target="_blank" and window.open into same-tab navigation with Back history', async (t) => {
  const chromeBin = await resolveChromeExecutable();
  if (!chromeBin) {
    t.skip('No local Chrome executable installed');
    return;
  }

  const site = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.url === '/page2') {
      res.end('<!doctype html><html><head><title>Second Page</title></head><body><h1>Page Two</h1><button id="pop" style="position:fixed;inset:0;width:100%;height:100%" onclick="window.open(\'/page3\', \'_blank\')">Open 3</button></body></html>');
      return;
    }
    if (req.url === '/page3') {
      res.end('<!doctype html><html><head><title>Third Page</title></head><body><h1>Page Three</h1></body></html>');
      return;
    }
    res.end('<!doctype html><html><head><title>First Page</title></head><body style="margin:0"><a id="blankLink" href="/page2" target="_blank" style="display:block;width:100vw;height:100vh;background:#eee">Open in Blank</a></body></html>');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  t.after(() => {
    site.close();
    site.closeAllConnections();
  });
  const siteBase = `http://127.0.0.1:${site.address().port}`;

  const { wsBase } = await listen(t, { __allowLoopbackForTest: true });
  const ws = new WebSocket(
    `${wsBase}/preview-ws?url=${encodeURIComponent(`${siteBase}/page1`)}&w=640&h=480&dpr=1`,
  );
  ws.binaryType = 'arraybuffer';
  t.after(() => ws.close());

  const states = [];
  let frameCount = 0;

  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state') states.push(msg);
    } else {
      frameCount++;
    }
  });

  const waitForUrl = (expectedUrl, predicate = () => true) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`Timed out waiting for ${expectedUrl}, got ${JSON.stringify(states.at(-1))}`)),
        8_000,
      );
      const check = setInterval(() => {
        const match = [...states].reverse().find((s) => s.url === expectedUrl && !s.loading && predicate(s));
        if (match) {
          clearInterval(check);
          clearTimeout(deadline);
          resolve(match);
        }
      }, 40);
    });

  // 1. Initial X-Frame-Options: DENY page loads with screencast frames and canGoBack=false
  const firstState = await waitForUrl(`${siteBase}/page1`);
  assert.equal(firstState.canGoBack, false);
  // Wait briefly if first JPEG frame is still encoding
  for (let i = 0; i < 30 && frameCount === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(frameCount > 0, 'Expected at least one JPEG screencast frame');

  // 2. Click <a target="_blank" href="/page2"> -> navigates IN-PLACE to /page2 (canGoBack=true)
  ws.send(JSON.stringify({ type: 'mouse', event: 'mousePressed', x: 120, y: 120, button: 'left', buttons: 1, clickCount: 1 }));
  ws.send(JSON.stringify({ type: 'mouse', event: 'mouseReleased', x: 120, y: 120, button: 'left', buttons: 0, clickCount: 1 }));
  const secondState = await waitForUrl(`${siteBase}/page2`, (s) => s.canGoBack === true);
  assert.equal(secondState.canGoBack, true);

  // 3. Click button calling window.open('/page3', '_blank') -> navigates IN-PLACE to /page3
  ws.send(JSON.stringify({ type: 'mouse', event: 'mousePressed', x: 120, y: 120, button: 'left', buttons: 1, clickCount: 1 }));
  ws.send(JSON.stringify({ type: 'mouse', event: 'mouseReleased', x: 120, y: 120, button: 'left', buttons: 0, clickCount: 1 }));
  const thirdState = await waitForUrl(`${siteBase}/page3`, (s) => s.canGoBack === true);
  assert.equal(thirdState.canGoBack, true);

  // 4. Send 'back' -> navigates back to /page2 with canGoForward=true
  ws.send(JSON.stringify({ type: 'back' }));
  const backState = await waitForUrl(`${siteBase}/page2`, (s) => s.canGoForward === true);
  assert.equal(backState.canGoForward, true);
});
