import type { DisposableScope } from '@akl/lab-kit';

/**
 * Safe local-strip Y bounds for `.history-list` (`perspective: 700px`,
 * `rotateX(38deg) rotateY(-30deg) rotateZ(-8deg)`, `transform-origin: 50% 0`).
 *
 * On desktop (`width: 260px`), the bottom-right corner reaches the camera plane
 * `z = 700px` at `shiftedBottom ≈ 993.8px`. Culling before `965px` guarantees
 * `z < 681px` (never crossing behind the camera lens) while the card is already
 * well below the bottom edge of the viewport (`screenY > 1300px`).
 */
export const NEAR_PLANE_CULL_BOTTOM = 965;
export const NEAR_PLANE_CULL_TOP = 825;
export const FAR_PLANE_CULL_BOTTOM = -480;
export const END_STOP_LOCAL_TOP = 130;

export interface HistoryItemBox {
  readonly top: number;
  readonly height: number;
  readonly isCard: boolean;
}

export function computeHistoryMaxOffset(items: readonly HistoryItemBox[]): number {
  let cardCount = 0;
  let lastCardTop = 0;
  for (const item of items) {
    if (!item.isCard) continue;
    cardCount += 1;
    if (item.top > lastCardTop) lastCardTop = item.top;
  }
  if (cardCount <= 1) return 0;
  return Math.max(0, lastCardTop - END_STOP_LOCAL_TOP);
}

export function isHistoryItemCulled(box: HistoryItemBox, offset: number): boolean {
  const shiftedTop = box.top - offset;
  const shiftedBottom = shiftedTop + box.height;
  if (shiftedBottom > NEAR_PLANE_CULL_BOTTOM || shiftedTop > NEAR_PLANE_CULL_TOP) {
    return true;
  }
  if (shiftedBottom < FAR_PLANE_CULL_BOTTOM) {
    return true;
  }
  return false;
}

export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 360;
  return deltaY;
}

export function anchorHistoryPrepend(
  offset: number,
  targetOffset: number,
  addedStride: number,
  maxOffset: number,
): { offset: number; targetOffset: number } {
  if (addedStride <= 0 || targetOffset <= 4) {
    return {
      offset: Math.max(0, Math.min(maxOffset, offset)),
      targetOffset: Math.max(0, Math.min(maxOffset, targetOffset)),
    };
  }
  return {
    offset: Math.max(0, Math.min(maxOffset, offset + addedStride)),
    targetOffset: Math.max(0, Math.min(maxOffset, targetOffset + addedStride)),
  };
}

export function stepHistoryOffset(
  offset: number,
  targetOffset: number,
  maxOffset: number,
  dt: number,
): { offset: number; targetOffset: number } {
  const clampedTarget = Math.max(0, Math.min(maxOffset, targetOffset));
  const safeDt = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  const alpha = 1 - Math.exp(-16 * safeDt);
  const next = offset + (clampedTarget - offset) * alpha;
  return {
    offset: Math.abs(clampedTarget - next) < 0.2 ? clampedTarget : next,
    targetOffset: clampedTarget,
  };
}

interface CachedDomItem extends HistoryItemBox {
  el: HTMLElement;
  culled: boolean | null;
}

export interface HistoryRailController {
  reset(): void;
  clearLatch(): void;
  syncAfterPrepend(previousFirstCard: HTMLElement | null, previousFirstTop: number): void;
}

export function createHistoryRailController(
  appRoot: HTMLElement,
  list: HTMLOListElement,
  scope: DisposableScope,
  onSelectNode: (nodeId: string) => void,
  isPreviewOpen: () => boolean,
): HistoryRailController {
  let cachedItems: CachedDomItem[] = [];
  let maxOffset = 0;
  let offset = 0;
  let targetOffset = 0;
  let dirty = true;
  let wheelLatch: { x: number; y: number } | null = null;

  function applyVisualState() {
    list.style.setProperty('--history-offset', `${offset.toFixed(2)}px`);
    for (const item of cachedItems) {
      const culled = isHistoryItemCulled(item, offset);
      if (item.culled !== culled) {
        item.culled = culled;
        if (culled) item.el.dataset.culled = 'true';
        else delete item.el.dataset.culled;
      }
    }
  }

  function rebuildLayoutCache() {
    cachedItems = Array.from(list.children).map((child) => {
      const el = child as HTMLElement;
      return {
        el,
        top: el.offsetTop,
        height: el.offsetHeight,
        isCard: el.classList.contains('history-page'),
        culled: null,
      };
    });
    maxOffset = computeHistoryMaxOffset(cachedItems);
    targetOffset = Math.max(0, Math.min(maxOffset, targetOffset));
    offset = Math.max(0, Math.min(maxOffset, offset));
    dirty = true;
  }

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      rebuildLayoutCache();
      applyVisualState();
    });
    observer.observe(list);
    scope.add(() => observer.disconnect());
  }

  scope.trackListener(appRoot, 'pointermove', (event) => {
    if (!wheelLatch) return;
    const e = event as PointerEvent;
    if ((e.target as Element | null)?.closest('.history-page')) {
      wheelLatch = { x: e.clientX, y: e.clientY };
      return;
    }
    if (Math.hypot(e.clientX - wheelLatch.x, e.clientY - wheelLatch.y) > 12) {
      wheelLatch = null;
    }
  });

  scope.trackListener(
    appRoot,
    'wheel',
    (event) => {
      if (isPreviewOpen()) {
        wheelLatch = null;
        return;
      }
      const e = event as WheelEvent;
      const onCard = Boolean((e.target as Element | null)?.closest('.history-page'));
      if (!onCard && !wheelLatch) return;
      if (onCard) {
        wheelLatch = { x: e.clientX, y: e.clientY };
      }
      e.preventDefault();
      e.stopPropagation();
      const delta = normalizeWheelDelta(e.deltaY, e.deltaMode);
      if (delta === 0) return;
      targetOffset = Math.max(0, Math.min(maxOffset, targetOffset + delta));
      dirty = true;
    },
    { passive: false, capture: true },
  );

  let drag: { pointerId: number; lastY: number; moved: number } | null = null;
  let suppressClickUntil = 0;

  scope.trackListener(list, 'pointerdown', (event) => {
    const e = event as PointerEvent;
    if (e.button !== 0 || isPreviewOpen() || !(e.target as Element | null)?.closest('.history-page')) return;
    drag = { pointerId: e.pointerId, lastY: e.clientY, moved: 0 };
  });

  scope.trackListener(list, 'pointermove', (event) => {
    const e = event as PointerEvent;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dy = e.clientY - drag.lastY;
    drag.lastY = e.clientY;
    drag.moved += Math.abs(dy);
    if (drag.moved < 6) return;
    if (!list.hasPointerCapture?.(e.pointerId)) {
      list.setPointerCapture?.(e.pointerId);
    }
    targetOffset = Math.max(0, Math.min(maxOffset, targetOffset - dy));
    dirty = true;
  });

  const endDrag = (event: Event) => {
    const e = event as PointerEvent;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.moved >= 6) {
      suppressClickUntil = performance.now() + 120;
    }
    if (list.hasPointerCapture?.(e.pointerId)) {
      list.releasePointerCapture?.(e.pointerId);
    }
    drag = null;
  };
  scope.trackListener(list, 'pointerup', endDrag);
  scope.trackListener(list, 'pointercancel', endDrag);

  scope.trackListener(list, 'click', (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const historyItem = (event.target as Element | null)?.closest<HTMLElement>('.history-page[data-node-id]');
    if (!historyItem?.dataset.nodeId) return;
    wheelLatch = null;
    onSelectNode(historyItem.dataset.nodeId);
  });

  scope.trackRaf((_time, _wrapped, dt) => {
    if (!dirty && Math.abs(targetOffset - offset) < 0.05) return;
    const stepped = stepHistoryOffset(offset, targetOffset, maxOffset, dt);
    offset = stepped.offset;
    targetOffset = stepped.targetOffset;
    applyVisualState();
    dirty = Math.abs(targetOffset - offset) >= 0.05;
  });

  rebuildLayoutCache();
  applyVisualState();

  return {
    reset() {
      drag = null;
      wheelLatch = null;
      offset = 0;
      targetOffset = 0;
      rebuildLayoutCache();
      applyVisualState();
    },
    clearLatch() {
      wheelLatch = null;
    },
    syncAfterPrepend(previousFirstCard, previousFirstTop) {
      rebuildLayoutCache();
      if (previousFirstCard && previousFirstCard.parentElement === list) {
        const addedStride = previousFirstCard.offsetTop - previousFirstTop;
        const anchored = anchorHistoryPrepend(offset, targetOffset, addedStride, maxOffset);
        offset = anchored.offset;
        targetOffset = anchored.targetOffset;
      }
      applyVisualState();
      dirty = Math.abs(targetOffset - offset) >= 0.05;
    },
  };
}
