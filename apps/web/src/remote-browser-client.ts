export interface RemoteBrowserState {
  url: string;
  title?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface RemoteBrowserCallbacks {
  onState(state: RemoteBrowserState): void;
  onFirstFrame?(): void;
  onUnavailable?(reason: string): void;
}

export interface RemoteBrowserController {
  goBack(): void;
  goForward(): void;
  reload(): void;
  navigate(url: string): void;
  dispose(): void;
}

const FORWARDED_SPECIAL_KEYS = new Set([
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'PageUp',
  'PageDown',
  'End',
  'Home',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Delete',
]);

function modifierBitmask(event: MouseEvent | KeyboardEvent | WheelEvent): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function buttonName(button: number): 'left' | 'middle' | 'right' | 'none' {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'none';
}

export function mountRemoteBrowser(
  host: HTMLElement,
  buildWsUrl: (width: number, height: number, dpr: number) => string | null,
  callbacks: RemoteBrowserCallbacks,
  WebSocketImpl: typeof WebSocket = WebSocket,
): RemoteBrowserController {
  const viewport = document.createElement('div');
  viewport.className = 'remote-browser-viewport';

  const canvas = document.createElement('canvas');
  canvas.className = 'remote-browser-canvas';

  const imeInput = document.createElement('textarea');
  imeInput.className = 'remote-browser-ime';
  imeInput.name = 'preview-ime';
  imeInput.setAttribute('aria-label', '웹페이지 텍스트 입력');
  imeInput.autocapitalize = 'off';
  imeInput.autocomplete = 'off';
  imeInput.spellcheck = false;

  const statusOverlay = document.createElement('div');
  statusOverlay.className = 'preview-loading remote-browser-status';
  statusOverlay.textContent = '웹페이지를 불러오는 중입니다…';

  viewport.append(canvas, imeInput, statusOverlay);
  host.replaceChildren(viewport);

  const ctx = canvas.getContext('2d', { alpha: false });
  let disposed = false;
  let hasPaintedFrame = false;
  let unavailableReported = false;
  let frameSeq = 0;
  let paintedSeq = 0;

  let viewportWidth = Math.max(320, Math.round(host.clientWidth || 1100));
  let viewportHeight = Math.max(240, Math.round(host.clientHeight || 620));
  let viewportDpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);

  const initialWsUrl = buildWsUrl(viewportWidth, viewportHeight, viewportDpr);
  if (!initialWsUrl) {
    callbacks.onUnavailable?.('invalid_ws_url');
    return {
      goBack() {},
      goForward() {},
      reload() {},
      navigate() {},
      dispose() {
        disposed = true;
      },
    };
  }

  const ws = new WebSocketImpl(initialWsUrl);
  ws.binaryType = 'arraybuffer';

  let currentState: RemoteBrowserState = {
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: true,
  };

  function sendJson(payload: Record<string, unknown>): void {
    if (disposed || ws.readyState !== WebSocketImpl.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Ignore send errors while closing.
    }
  }

  function reportUnavailable(reason: string): void {
    if (disposed || unavailableReported) return;
    unavailableReported = true;
    callbacks.onUnavailable?.(reason);
  }

  function paintFrameBuffer(buffer: ArrayBuffer): void {
    const view = new Uint8Array(buffer);
    if (view.byteLength < 2 || view[0] !== 0x01 || !ctx) return;
    const seq = ++frameSeq;
    const blob = new Blob([view.subarray(1)], { type: 'image/jpeg' });

    if (typeof createImageBitmap === 'function') {
      void createImageBitmap(blob)
        .then((bitmap) => {
          if (disposed || seq < paintedSeq) {
            bitmap.close();
            return;
          }
          paintedSeq = seq;
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          if (!hasPaintedFrame) {
            hasPaintedFrame = true;
            statusOverlay.hidden = true;
            callbacks.onFirstFrame?.();
          }
        })
        .catch(() => {});
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      if (disposed || seq < paintedSeq) return;
      paintedSeq = seq;
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      ctx.drawImage(img, 0, 0);
      if (!hasPaintedFrame) {
        hasPaintedFrame = true;
        statusOverlay.hidden = true;
        callbacks.onFirstFrame?.();
      }
    };
    img.onerror = () => URL.revokeObjectURL(objectUrl);
    img.src = objectUrl;
  }

  ws.addEventListener('message', (event) => {
    if (disposed) return;
    if (event.data instanceof ArrayBuffer) {
      paintFrameBuffer(event.data);
      return;
    }
    if (typeof event.data !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'state') {
      currentState = {
        url: typeof msg.url === 'string' && msg.url ? msg.url : currentState.url,
        title: typeof msg.title === 'string' ? msg.title : currentState.title,
        canGoBack: typeof msg.canGoBack === 'boolean' ? msg.canGoBack : currentState.canGoBack,
        canGoForward:
          typeof msg.canGoForward === 'boolean' ? msg.canGoForward : currentState.canGoForward,
        loading: typeof msg.loading === 'boolean' ? msg.loading : currentState.loading,
      };
      callbacks.onState(currentState);
    } else if (msg.type === 'cursor' && typeof msg.cursor === 'string') {
      canvas.style.cursor =
        msg.cursor === 'pointer' || msg.cursor === 'text' ? msg.cursor : 'default';
    } else if (msg.type === 'error') {
      const reason = typeof msg.reason === 'string' ? msg.reason : 'remote_error';
      if (!hasPaintedFrame) {
        reportUnavailable(reason);
      }
    }
  });

  ws.addEventListener('error', () => {
    if (!hasPaintedFrame) reportUnavailable('ws_error');
  });

  ws.addEventListener('close', () => {
    if (!disposed && !hasPaintedFrame) {
      reportUnavailable('ws_closed_before_frame');
    }
  });

  function mapCanvasCoords(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const relX = (clientX - rect.left) / Math.max(1, rect.width);
    const relY = (clientY - rect.top) / Math.max(1, rect.height);
    return {
      x: Math.max(0, Math.min(viewportWidth, relX * viewportWidth)),
      y: Math.max(0, Math.min(viewportHeight, relY * viewportHeight)),
    };
  }

  let lastClickTime = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  let clickCount = 0;

  let moveRaf: number | null = null;
  let pendingMove: { x: number; y: number; buttons: number; modifiers: number } | null = null;

  let wheelRaf: number | null = null;
  let pendingWheel: { x: number; y: number; deltaX: number; deltaY: number; modifiers: number } | null =
    null;

  const onPointerDown = (e: PointerEvent) => {
    if (disposed) return;
    imeInput.focus({ preventScroll: true });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore pointer capture errors in synthetic test events.
    }
    const now = performance.now();
    const { x, y } = mapCanvasCoords(e.clientX, e.clientY);
    if (now - lastClickTime < 350 && Math.hypot(x - lastClickX, y - lastClickY) < 8) {
      clickCount = (clickCount % 3) + 1;
    } else {
      clickCount = 1;
    }
    lastClickTime = now;
    lastClickX = x;
    lastClickY = y;

    sendJson({
      type: 'mouse',
      event: 'mousePressed',
      x,
      y,
      button: buttonName(e.button),
      buttons: e.buttons,
      clickCount,
      modifiers: modifierBitmask(e),
    });
  };

  const onPointerMove = (e: PointerEvent) => {
    if (disposed) return;
    const { x, y } = mapCanvasCoords(e.clientX, e.clientY);
    pendingMove = { x, y, buttons: e.buttons, modifiers: modifierBitmask(e) };
    if (moveRaf !== null) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      if (!pendingMove || disposed) return;
      const move = pendingMove;
      pendingMove = null;
      sendJson({
        type: 'mouse',
        event: 'mouseMoved',
        x: move.x,
        y: move.y,
        button: 'none',
        buttons: move.buttons,
        clickCount: 0,
        modifiers: move.modifiers,
      });
    });
  };

  const onPointerUp = (e: PointerEvent) => {
    if (disposed) return;
    const { x, y } = mapCanvasCoords(e.clientX, e.clientY);
    sendJson({
      type: 'mouse',
      event: 'mouseReleased',
      x,
      y,
      button: buttonName(e.button),
      buttons: e.buttons,
      clickCount: clickCount || 1,
      modifiers: modifierBitmask(e),
    });
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  const onWheel = (e: WheelEvent) => {
    if (disposed) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = mapCanvasCoords(e.clientX, e.clientY);
    const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? viewportHeight * 0.85 : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    if (pendingWheel) {
      pendingWheel.x = x;
      pendingWheel.y = y;
      pendingWheel.deltaX += dx;
      pendingWheel.deltaY += dy;
      pendingWheel.modifiers = modifierBitmask(e);
    } else {
      pendingWheel = { x, y, deltaX: dx, deltaY: dy, modifiers: modifierBitmask(e) };
    }
    if (wheelRaf !== null) return;
    wheelRaf = requestAnimationFrame(() => {
      wheelRaf = null;
      if (!pendingWheel || disposed) return;
      const wheel = pendingWheel;
      pendingWheel = null;
      sendJson({
        type: 'wheel',
        x: wheel.x,
        y: wheel.y,
        deltaX: wheel.deltaX,
        deltaY: wheel.deltaY,
        modifiers: wheel.modifiers,
      });
    });
  };

  let isComposing = false;
  const onCompositionStart = () => {
    isComposing = true;
  };
  const onCompositionEnd = (e: CompositionEvent) => {
    isComposing = false;
    if (e.data) {
      sendJson({ type: 'text', text: e.data });
    }
    imeInput.value = '';
  };
  const onInput = () => {
    if (isComposing) return;
    if (imeInput.value) {
      sendJson({ type: 'text', text: imeInput.value });
      imeInput.value = '';
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isComposing) return;
    if (FORWARDED_SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      sendJson({
        type: 'key',
        event: 'rawKeyDown',
        key: e.key,
        code: e.code,
        modifiers: modifierBitmask(e),
      });
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (isComposing) return;
    if (FORWARDED_SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      sendJson({
        type: 'key',
        event: 'keyUp',
        key: e.key,
        code: e.code,
        modifiers: modifierBitmask(e),
      });
    }
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  imeInput.addEventListener('compositionstart', onCompositionStart);
  imeInput.addEventListener('compositionend', onCompositionEnd);
  imeInput.addEventListener('input', onInput);
  imeInput.addEventListener('keydown', onKeyDown);
  imeInput.addEventListener('keyup', onKeyUp);

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (disposed) return;
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            if (disposed) return;
            const nextW = Math.max(320, Math.round(host.clientWidth || viewportWidth));
            const nextH = Math.max(240, Math.round(host.clientHeight || viewportHeight));
            const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
            if (
              Math.abs(nextW - viewportWidth) > 4 ||
              Math.abs(nextH - viewportHeight) > 4 ||
              nextDpr !== viewportDpr
            ) {
              viewportWidth = nextW;
              viewportHeight = nextH;
              viewportDpr = nextDpr;
              sendJson({
                type: 'resize',
                width: viewportWidth,
                height: viewportHeight,
                dpr: viewportDpr,
              });
            }
          }, 120);
        })
      : null;
  resizeObserver?.observe(host);

  return {
    goBack() {
      sendJson({ type: 'back' });
    },
    goForward() {
      sendJson({ type: 'forward' });
    },
    reload() {
      sendJson({ type: 'reload' });
    },
    navigate(url: string) {
      sendJson({ type: 'navigate', url });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (moveRaf !== null) cancelAnimationFrame(moveRaf);
      if (wheelRaf !== null) cancelAnimationFrame(wheelRaf);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      imeInput.removeEventListener('compositionstart', onCompositionStart);
      imeInput.removeEventListener('compositionend', onCompositionEnd);
      imeInput.removeEventListener('input', onInput);
      imeInput.removeEventListener('keydown', onKeyDown);
      imeInput.removeEventListener('keyup', onKeyUp);
      try {
        ws.close();
      } catch {
        // Ignore close error.
      }
    },
  };
}
