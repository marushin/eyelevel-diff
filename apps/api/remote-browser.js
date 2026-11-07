import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_USER_AGENT,
  UnsafeUrlError,
  assertSafePublicUrl,
  isGoogleRedirectUrl,
  unwrapGoogleRedirectUrl,
} from './preview.js';

const MAX_CONCURRENT_SESSIONS = 6;
const DNS_SAFETY_CACHE_TTL_MS = 60_000;
const CHROME_STARTUP_TIMEOUT_MS = 10_000;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

async function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChromeExecutable(explicitPath = process.env.CHROME_BIN?.trim()) {
  if (explicitPath && (await isExecutable(explicitPath))) {
    return explicitPath;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (await isExecutable(candidate)) return candidate;
  }
  const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (await isExecutable(full)) return full;
    }
  }
  return null;
}

const NEW_DOCUMENT_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  } catch {}

  const sendBridge = (payload) => {
    try {
      if (typeof window.__aklBridge === 'function') {
        window.__aklBridge(JSON.stringify(payload));
      }
    } catch {}
  };

  const resolveHttpUrl = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
      return null;
    }
    try {
      const parsed = new URL(trimmed, window.location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch {}
    return null;
  };

  window.open = function (url) {
    const targetUrl = resolveHttpUrl(typeof url === 'string' ? url : String(url ?? ''));
    if (targetUrl) {
      try {
        if (window.top && window.top !== window) {
          window.top.location.assign(targetUrl);
        } else {
          window.location.assign(targetUrl);
        }
      } catch {
        sendBridge({ type: 'openUrl', url: targetUrl });
      }
    }
    return window;
  };

  document.addEventListener(
    'click',
    (event) => {
      const el = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null;
      if (!el) return;
      const rawHref = el.getAttribute('href') || '';
      const resolved = resolveHttpUrl(rawHref || el.href);
      if (!resolved) return;
      const targetAttr = (el.getAttribute('target') || '').trim().toLowerCase();
      if (window.top && window.top !== window) {
        if (targetAttr === '_blank' || targetAttr === '_top' || targetAttr === '_parent' || targetAttr === 'blank') {
          event.preventDefault();
          event.stopPropagation();
          try {
            window.top.location.assign(resolved);
          } catch {
            sendBridge({ type: 'openUrl', url: resolved });
          }
        }
      } else if (targetAttr && targetAttr !== '_self') {
        el.setAttribute('target', '_self');
      }
    },
    true,
  );

  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement) {
        const targetAttr = (form.getAttribute('target') || '').trim().toLowerCase();
        if (targetAttr && targetAttr !== '_self') {
          form.setAttribute('target', '_self');
        }
      }
    },
    true,
  );

  let lastCursor = 'default';
  let lastCursorCheck = 0;
  document.addEventListener(
    'mousemove',
    (event) => {
      const now = performance.now();
      if (now - lastCursorCheck < 45) return;
      lastCursorCheck = now;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      let next = 'default';
      if (
        target.closest(
          'a[href], button, [role="button"], summary, select, label[for], input[type="submit"], input[type="button"]',
        )
      ) {
        next = 'pointer';
      } else if (
        target.closest(
          'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]',
        )
      ) {
        next = 'text';
      } else {
        const computed = window.getComputedStyle(target).cursor;
        if (computed === 'pointer') next = 'pointer';
        else if (computed === 'text') next = 'text';
      }
      if (next !== lastCursor) {
        lastCursor = next;
        sendBridge({ type: 'cursor', cursor: next });
      }
    },
    { passive: true, capture: true },
  );
})();`;

const SPECIAL_KEY_CODES = {
  Backspace: { keyCode: 8, code: 'Backspace' },
  Tab: { keyCode: 9, code: 'Tab' },
  Enter: { keyCode: 13, code: 'Enter', text: '\r' },
  Escape: { keyCode: 27, code: 'Escape' },
  ' ': { keyCode: 32, code: 'Space', text: ' ' },
  PageUp: { keyCode: 33, code: 'PageUp' },
  PageDown: { keyCode: 34, code: 'PageDown' },
  End: { keyCode: 35, code: 'End' },
  Home: { keyCode: 36, code: 'Home' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown' },
  Delete: { keyCode: 46, code: 'Delete' },
};

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampFloat(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

class CdpConnection {
  constructor(wsEndpoint) {
    this.wsEndpoint = wsEndpoint;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionListeners = new Map();
    this.browserListeners = new Set();
    this.closed = false;
  }

  async connect() {
    const ws = new WebSocket(this.wsEndpoint);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 5_000);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error('CDP WebSocket error'));
        },
        { once: true },
      );
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'CDP command failed'));
        } else {
          entry.resolve(msg.result ?? {});
        }
        return;
      }
      if (msg.method) {
        if (msg.sessionId) {
          const listeners = this.sessionListeners.get(msg.sessionId);
          if (listeners) {
            for (const fn of listeners) {
              try {
                fn(msg.method, msg.params ?? {});
              } catch {
                // Ignore event handler error.
              }
            }
          }
        } else {
          for (const fn of this.browserListeners) {
            try {
              fn(msg.method, msg.params ?? {});
            } catch {
              // Ignore browser event handler error.
            }
          }
        }
      }
    });

    const handleDisconnect = () => {
      if (this.closed) return;
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    };
    ws.addEventListener('close', handleDisconnect);
    ws.addEventListener('error', handleDisconnect);
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 8_000) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP connection is not open'));
    }
    const id = this.nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  onSessionEvent(sessionId, fn) {
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  onBrowserEvent(fn) {
    this.browserListeners.add(fn);
    return () => this.browserListeners.delete(fn);
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // Ignore close error.
    }
  }
}

export function createRemoteBrowserManager({
  chromeExecutable,
  lookupImpl,
  fetchImpl = globalThis.fetch,
  sessionFactory,
  allowLoopbackForTest = false,
} = {}) {
  let browserStartup = null;
  let activeChrome = null;
  let activeCdp = null;
  let activeUserDataDir = null;
  let shuttingDown = false;

  const activeSessions = new Set();
  const hostSafetyCache = new Map();

  async function validateTargetUrl(rawUrl) {
    if (allowLoopbackForTest) {
      const parsed = new URL(rawUrl);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname === '127.0.0.1') {
        return parsed;
      }
    }
    return assertSafePublicUrl(rawUrl, { lookupImpl, fetchImpl });
  }

  async function isSafeHttpTarget(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (allowLoopbackForTest && parsed.hostname === '127.0.0.1') return true;
    const hostKey = parsed.hostname.toLowerCase();
    const now = Date.now();
    const cached = hostSafetyCache.get(hostKey);
    if (cached && cached.expiresAt > now) {
      return cached.safe;
    }
    try {
      await assertSafePublicUrl(parsed.href, { lookupImpl, fetchImpl });
      hostSafetyCache.set(hostKey, { safe: true, expiresAt: now + DNS_SAFETY_CACHE_TTL_MS });
      return true;
    } catch {
      hostSafetyCache.set(hostKey, { safe: false, expiresAt: now + DNS_SAFETY_CACHE_TTL_MS });
      return false;
    }
  }

  async function isAllowedSubresourceOrDocument(rawUrl, resourceType) {
    if (resourceType !== 'Document') {
      if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl === 'about:blank') {
        return true;
      }
    } else if (rawUrl === 'about:blank') {
      return true;
    }
    return isSafeHttpTarget(rawUrl);
  }

  async function ensureBrowser() {
    if (shuttingDown) throw new Error('Remote browser manager is shutting down');
    if (activeCdp && !activeCdp.closed && activeChrome && activeChrome.exitCode === null) {
      return activeCdp;
    }
    if (browserStartup) return browserStartup;

    browserStartup = (async () => {
      const binary = await resolveChromeExecutable(chromeExecutable);
      if (!binary) {
        throw new Error('Chrome executable not found');
      }
      const userDataDir = await mkdtemp(join(tmpdir(), 'akl-remote-chrome-'));
      const args = [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--mute-audio',
        '--hide-crash-restore-bubble',
        '--lang=ko-KR',
        'about:blank',
      ];

      const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const onProcessExit = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore.
        }
      };
      process.once('exit', onProcessExit);

      const wsEndpoint = await new Promise((resolve, reject) => {
        let stderrText = '';
        const timer = setTimeout(() => {
          reject(new Error('Timed out waiting for Chrome DevTools endpoint'));
        }, CHROME_STARTUP_TIMEOUT_MS);
        timer.unref?.();

        const onData = (chunk) => {
          stderrText += chunk.toString('utf8');
          const match = stderrText.match(/DevTools listening on (ws:\/\/[^\s\r\n]+)/);
          if (match) {
            clearTimeout(timer);
            child.stderr.off('data', onData);
            resolve(match[1]);
          }
        };

        child.stderr.on('data', onData);
        child.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Chrome exited prematurely (${code ?? 'signal'})`));
        });
      }).catch(async (err) => {
        process.off('exit', onProcessExit);
        try {
          child.kill('SIGKILL');
        } catch {}
        await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      });

      const cdp = new CdpConnection(wsEndpoint);
      await cdp.connect();
      await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});

      activeChrome = child;
      activeCdp = cdp;
      activeUserDataDir = userDataDir;

      child.once('exit', () => {
        process.off('exit', onProcessExit);
        cdp.close();
        if (activeChrome === child) {
          activeChrome = null;
          activeCdp = null;
          activeUserDataDir = null;
        }
        rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      });

      return cdp;
    })();

    try {
      return await browserStartup;
    } finally {
      browserStartup = null;
    }
  }

  async function createCdpSession(initialUrl, { width, height, dpr }, callbacks) {
    const safeInitial = (await validateTargetUrl(initialUrl)).href;
    const unwrappedInitial = await unwrapGoogleRedirectUrl(safeInitial, {
      fetchImpl,
      lookupImpl,
      timeoutMs: 4_000,
    });
    const startUrl = (await validateTargetUrl(unwrappedInitial)).href;

    const cdp = await ensureBrowser();
    const { browserContextId } = await cdp.send('Target.createBrowserContext', {
      disposeOnDetach: true,
    });

    let disposed = false;
    let sessionId = null;
    let mainTargetId = null;
    let viewportWidth = clampInt(width, 320, 1920, 1100);
    let viewportHeight = clampInt(height, 240, 1200, 640);
    let viewportDpr = clampFloat(dpr, 1, 2, 2);
    let removeSessionListener = null;
    let removeBrowserListener = null;
    let historySyncPending = false;
    let isLoading = true;
    let currentUrl = startUrl;
    let currentTitle = '';

    const cleanup = async () => {
      if (disposed) return;
      disposed = true;
      removeSessionListener?.();
      removeBrowserListener?.();
      if (sessionId) {
        await cdp.send('Page.stopScreencast', {}, sessionId, 1_500).catch(() => {});
      }
      await cdp.send('Target.disposeBrowserContext', { browserContextId }, undefined, 2_500).catch(() => {});
    };

    try {
      await cdp
        .send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId })
        .catch(() => {});

      const created = await cdp.send('Target.createTarget', {
        url: 'about:blank',
        width: viewportWidth,
        height: viewportHeight,
        browserContextId,
      });
      mainTargetId = created.targetId;

      const attached = await cdp.send('Target.attachToTarget', {
        targetId: mainTargetId,
        flatten: true,
      });
      sessionId = attached.sessionId;

      const syncHistoryState = async () => {
        if (disposed || historySyncPending) return;
        historySyncPending = true;
        try {
          const history = await cdp.send('Page.getNavigationHistory', {}, sessionId, 3_000);
          if (disposed) return;
          const entries = Array.isArray(history.entries) ? history.entries : [];
          const idx = typeof history.currentIndex === 'number' ? history.currentIndex : 0;
          const active = entries[idx];
          const firstRealIdx = entries.findIndex(
            (entry) => entry.url && entry.url !== 'about:blank' && !isGoogleRedirectUrl(entry.url),
          );
          if (active?.url && active.url !== 'about:blank') {
            currentUrl = active.url;
          }
          if (active?.title) {
            currentTitle = active.title;
          }
          callbacks.onState({
            url: currentUrl,
            title: currentTitle,
            canGoBack: firstRealIdx !== -1 && idx > firstRealIdx,
            canGoForward: firstRealIdx !== -1 && idx < entries.length - 1,
            loading: isLoading,
          });
        } catch {
          // Ignore transient navigation state errors.
        } finally {
          historySyncPending = false;
        }
      };

      const navigateInPlace = async (rawTargetUrl) => {
        if (disposed) return;
        const ok = await isSafeHttpTarget(rawTargetUrl);
        if (!ok) return;
        const unwrapped = await unwrapGoogleRedirectUrl(rawTargetUrl, {
          fetchImpl,
          lookupImpl,
          timeoutMs: 3_500,
        });
        if (!(await isSafeHttpTarget(unwrapped))) return;
        isLoading = true;
        currentUrl = unwrapped;
        callbacks.onState({ url: currentUrl, title: currentTitle, loading: true });
        await cdp.send('Page.navigate', { url: unwrapped }, sessionId).catch(() => {});
      };

      // Absorb any popup target opened in the same BrowserContext into mainTargetId.
      const sessionStartedAt = Date.now();
      const redirectedPopups = new Set();
      const handlePopupTarget = (targetInfo) => {
        if (disposed || !targetInfo) return;
        if (targetInfo.browserContextId !== browserContextId) return;
        if (targetInfo.targetId === mainTargetId) return;
        if (targetInfo.type !== 'page') return;
        const candidateUrl = targetInfo.url?.trim() ?? '';
        if (candidateUrl && candidateUrl !== 'about:blank' && !redirectedPopups.has(targetInfo.targetId)) {
          redirectedPopups.add(targetInfo.targetId);
          cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
          void navigateInPlace(candidateUrl);
        }
      };

      removeBrowserListener = cdp.onBrowserEvent((method, params) => {
        if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
          handlePopupTarget(params.targetInfo);
        }
      });

      removeSessionListener = cdp.onSessionEvent(sessionId, (method, params) => {
        if (disposed) return;

        if (method === 'Fetch.requestPaused') {
          const { requestId, request, resourceType } = params;
          void isAllowedSubresourceOrDocument(request?.url ?? '', resourceType).then((allowed) => {
            if (disposed) return;
            if (allowed) {
              cdp.send('Fetch.continueRequest', { requestId }, sessionId, 3_000).catch(() => {});
            } else {
              cdp
                .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId, 3_000)
                .catch(() => {});
            }
          });
          return;
        }

        if (method === 'Page.screencastFrame') {
          const { data, sessionId: frameId } = params;
          const ack = () => {
            if (!disposed) {
              cdp.send('Page.screencastFrameAck', { sessionId: frameId }, sessionId, 2_000).catch(() => {});
            }
          };
          if (isGoogleRedirectUrl(currentUrl) && Date.now() - sessionStartedAt < 5_000) {
            ack();
            return;
          }
          callbacks.onFrame(Buffer.from(data, 'base64'), ack);
          return;
        }

        if (method === 'Page.javascriptDialogOpening') {
          cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId, 2_000).catch(() => {});
          return;
        }

        if (method === 'Runtime.bindingCalled' && params.name === '__aklBridge') {
          try {
            const msg = JSON.parse(params.payload);
            if (msg?.type === 'cursor' && typeof msg.cursor === 'string') {
              callbacks.onCursor(msg.cursor);
            } else if (msg?.type === 'openUrl' && typeof msg.url === 'string') {
              void navigateInPlace(msg.url);
            }
          } catch {
            // Ignore malformed bridge message.
          }
          return;
        }

        if (method === 'Page.frameStartedLoading' && !params.frameId?.includes(':')) {
          isLoading = true;
          void syncHistoryState();
          return;
        }

        if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
          if (params.frame?.url && params.frame.url !== 'about:blank') {
            currentUrl = params.frame.url;
          }
          void syncHistoryState();
          return;
        }

        if (method === 'Page.navigatedWithinDocument') {
          if (params.url && params.url !== 'about:blank') {
            currentUrl = params.url;
          }
          void syncHistoryState();
          return;
        }

        if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') {
          isLoading = false;
          void syncHistoryState();
        }
      });

      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Runtime.addBinding', { name: '__aklBridge' }, sessionId).catch(() => {});
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send(
        'Network.setUserAgentOverride',
        {
          userAgent: BROWSER_USER_AGENT,
          acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          platform: 'MacIntel',
        },
        sessionId,
      );
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId).catch(() => {});
      await cdp.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
        sessionId,
      );
      await cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: NEW_DOCUMENT_INIT_SCRIPT },
        sessionId,
      );

      const applyViewportAndScreencast = async (nextW, nextH, nextDpr) => {
        if (disposed) return;
        viewportWidth = clampInt(nextW, 320, 1920, viewportWidth);
        viewportHeight = clampInt(nextH, 240, 1200, viewportHeight);
        viewportDpr = clampFloat(nextDpr, 1, 2, viewportDpr);
        await cdp
          .send(
            'Emulation.setDeviceMetricsOverride',
            {
              width: viewportWidth,
              height: viewportHeight,
              deviceScaleFactor: viewportDpr,
              mobile: false,
            },
            sessionId,
          )
          .catch(() => {});
        await cdp.send('Page.stopScreencast', {}, sessionId).catch(() => {});
        await cdp
          .send(
            'Page.startScreencast',
            {
              format: 'jpeg',
              quality: 82,
              maxWidth: Math.round(viewportWidth * viewportDpr),
              maxHeight: Math.round(viewportHeight * viewportDpr),
              everyNthFrame: 1,
            },
            sessionId,
          )
          .catch(() => {});
      };

      await applyViewportAndScreencast(viewportWidth, viewportHeight, viewportDpr);

      callbacks.onState({
        url: startUrl,
        title: '',
        canGoBack: false,
        canGoForward: false,
        loading: true,
      });

      await cdp.send('Page.navigate', { url: startUrl }, sessionId);

      return {
        async handleAction(action) {
          if (disposed || !action || typeof action !== 'object') return;
          switch (action.type) {
            case 'mouse': {
              const eventType = action.event;
              if (
                eventType !== 'mousePressed' &&
                eventType !== 'mouseReleased' &&
                eventType !== 'mouseMoved'
              ) {
                return;
              }
              const x = clampFloat(action.x, 0, viewportWidth, 0);
              const y = clampFloat(action.y, 0, viewportHeight, 0);
              const button =
                action.button === 'right' || action.button === 'middle' || action.button === 'left'
                  ? action.button
                  : 'none';
              await cdp
                .send(
                  'Input.dispatchMouseEvent',
                  {
                    type: eventType,
                    x,
                    y,
                    button,
                    buttons: clampInt(action.buttons, 0, 7, 0),
                    clickCount: clampInt(action.clickCount, 0, 3, eventType === 'mouseMoved' ? 0 : 1),
                    modifiers: clampInt(action.modifiers, 0, 15, 0),
                  },
                  sessionId,
                  2_000,
                )
                .catch(() => {});
              break;
            }
            case 'wheel': {
              const x = clampFloat(action.x, 0, viewportWidth, viewportWidth / 2);
              const y = clampFloat(action.y, 0, viewportHeight, viewportHeight / 2);
              const deltaX = clampFloat(action.deltaX, -4000, 4000, 0);
              const deltaY = clampFloat(action.deltaY, -4000, 4000, 0);
              await cdp
                .send(
                  'Input.dispatchMouseEvent',
                  {
                    type: 'mouseWheel',
                    x,
                    y,
                    deltaX,
                    deltaY,
                    modifiers: clampInt(action.modifiers, 0, 15, 0),
                  },
                  sessionId,
                  2_000,
                )
                .catch(() => {});
              break;
            }
            case 'text': {
              if (typeof action.text === 'string' && action.text.length > 0 && action.text.length <= 500) {
                await cdp
                  .send('Input.insertText', { text: action.text }, sessionId, 2_000)
                  .catch(() => {});
              }
              break;
            }
            case 'key': {
              const key = typeof action.key === 'string' ? action.key : '';
              const special = SPECIAL_KEY_CODES[key];
              const eventType = action.event === 'keyUp' ? 'keyUp' : 'rawKeyDown';
              const keyCode = special?.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
              if (!keyCode) return;
              const payload = {
                type: eventType,
                key,
                code: special?.code ?? (typeof action.code === 'string' ? action.code : ''),
                windowsVirtualKeyCode: keyCode,
                nativeVirtualKeyCode: keyCode,
                modifiers: clampInt(action.modifiers, 0, 15, 0),
              };
              if (eventType === 'rawKeyDown' && special?.text) {
                payload.text = special.text;
                payload.unmodifiedText = special.text;
              }
              await cdp.send('Input.dispatchKeyEvent', payload, sessionId, 2_000).catch(() => {});
              break;
            }
            case 'resize': {
              await applyViewportAndScreencast(action.width, action.height, action.dpr);
              break;
            }
            case 'back':
            case 'forward': {
              const history = await cdp.send('Page.getNavigationHistory', {}, sessionId, 3_000).catch(() => null);
              if (!history || !Array.isArray(history.entries)) return;
              const firstRealIdx = history.entries.findIndex(
                (entry) => entry.url && entry.url !== 'about:blank' && !isGoogleRedirectUrl(entry.url),
              );
              const targetIdx =
                action.type === 'back' ? history.currentIndex - 1 : history.currentIndex + 1;
              if (
                firstRealIdx !== -1 &&
                targetIdx >= firstRealIdx &&
                targetIdx < history.entries.length
              ) {
                isLoading = true;
                await cdp
                  .send(
                    'Page.navigateToHistoryEntry',
                    { entryId: history.entries[targetIdx].id },
                    sessionId,
                    3_000,
                  )
                  .catch(() => {});
              }
              break;
            }
            case 'reload': {
              isLoading = true;
              callbacks.onState({ url: currentUrl, title: currentTitle, loading: true });
              await cdp.send('Page.reload', {}, sessionId, 3_000).catch(() => {});
              break;
            }
            case 'navigate': {
              if (typeof action.url === 'string') {
                await navigateInPlace(action.url);
              }
              break;
            }
          }
        },
        close: cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async function attachWebSocketClient(ws, queryParams) {
    const rawUrl = queryParams.get('url')?.trim() ?? '';
    if (!rawUrl) {
      ws.sendJson({ type: 'error', reason: 'missing_url', message: 'URL이 필요합니다.' });
      ws.close(1008, 'url required');
      return;
    }

    const width = clampInt(queryParams.get('w'), 320, 1920, 1100);
    const height = clampInt(queryParams.get('h'), 240, 1200, 640);
    const dpr = clampFloat(queryParams.get('dpr'), 1, 2, 2);

    while (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
      const oldest = activeSessions.values().next().value;
      if (!oldest) break;
      activeSessions.delete(oldest);
      oldest.forceClose();
    }

    let session = null;
    let closed = false;

    const record = {
      forceClose() {
        if (closed) return;
        closed = true;
        ws.close(1000, 'Session replaced');
        void session?.close();
      },
    };
    activeSessions.add(record);

    ws.onClose(() => {
      closed = true;
      activeSessions.delete(record);
      void session?.close();
    });

    const createImpl = sessionFactory ?? createCdpSession;

    try {
      session = await createImpl(
        rawUrl,
        { width, height, dpr },
        {
          onFrame(jpegBytes, ack) {
            if (closed || ws.closed) return;
            const packet = Buffer.allocUnsafe(1 + jpegBytes.length);
            packet[0] = 0x01;
            jpegBytes.copy(packet, 1);
            ws.sendBinary(packet);
            if (ws.bufferedAmount > 512 * 1024) {
              setTimeout(ack, 35).unref?.();
            } else {
              ack();
            }
          },
          onState(state) {
            if (closed || ws.closed) return;
            ws.sendJson({ type: 'state', ...state });
          },
          onCursor(cursor) {
            if (closed || ws.closed) return;
            ws.sendJson({ type: 'cursor', cursor });
          },
        },
      );

      if (closed || ws.closed) {
        await session.close();
        return;
      }

      ws.onMessage((raw, isBinary) => {
        if (closed || isBinary || typeof raw !== 'string') return;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        void session.handleAction(parsed);
      });
    } catch (error) {
      activeSessions.delete(record);
      if (!closed && !ws.closed) {
        const reason = error instanceof UnsafeUrlError ? 'unsafe_url' : 'browser_unavailable';
        ws.sendJson({
          type: 'error',
          reason,
          message: error instanceof UnsafeUrlError ? error.message : '원격 브라우저를 시작할 수 없습니다.',
        });
        ws.close(1011, reason);
      }
    }
  }

  async function shutdown() {
    shuttingDown = true;
    for (const rec of activeSessions) {
      rec.forceClose();
    }
    activeSessions.clear();
    activeCdp?.close();
    activeCdp = null;
    if (activeChrome) {
      try {
        activeChrome.kill('SIGTERM');
      } catch {}
      activeChrome = null;
    }
    if (activeUserDataDir) {
      const dir = activeUserDataDir;
      activeUserDataDir = null;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    attachWebSocketClient,
    shutdown,
  };
}
