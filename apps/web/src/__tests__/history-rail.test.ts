import { describe, expect, it } from 'vitest';
import {
  END_STOP_LOCAL_TOP,
  anchorHistoryPrepend,
  computeHistoryMaxOffset,
  isHistoryItemCulled,
  normalizeWheelDelta,
  stepHistoryOffset,
  type HistoryItemBox,
} from '../history-rail.ts';

function buildSampleRail(cardCount: number): HistoryItemBox[] {
  const items: HistoryItemBox[] = [{ top: 0, height: 19, isCard: false }];
  for (let i = 0; i < cardCount; i++) {
    items.push({ top: 29 + i * 150, height: 140, isCard: true });
  }
  return items;
}

describe('history-rail 3D conveyor geometry and scroll state', () => {
  it('computes full scroll range up to the final card instead of collapsing', () => {
    expect(computeHistoryMaxOffset(buildSampleRail(0))).toBe(0);
    expect(computeHistoryMaxOffset(buildSampleRail(1))).toBe(0);
    const items18 = buildSampleRail(18);
    // Card #17 starts at 29 + 17 * 150 = 2579px and stops cleanly at END_STOP_LOCAL_TOP (130px).
    expect(computeHistoryMaxOffset(items18)).toBe(2579 - END_STOP_LOCAL_TOP);
  });

  it('culls cards before crossing the 700px perspective camera plane at every scroll offset', () => {
    const items = buildSampleRail(18);
    const maxOffset = computeHistoryMaxOffset(items);
    // At rest (offset = 0): title + cards 0..5 are unculled; card 6 (929..1069) and 7..17 are culled.
    expect(isHistoryItemCulled(items[0]!, 0)).toBe(false);
    for (let idx = 1; idx <= 6; idx++) {
      expect(isHistoryItemCulled(items[idx]!, 0)).toBe(false);
    }
    for (let idx = 7; idx < items.length; idx++) {
      expect(isHistoryItemCulled(items[idx]!, 0)).toBe(true);
    }

    // At the bottom of the rail (offset = maxOffset): card 17 sits at END_STOP_LOCAL_TOP and is visible;
    // early cards that receded far past the top edge are culled.
    expect(isHistoryItemCulled(items[18]!, maxOffset)).toBe(false);
    expect(isHistoryItemCulled(items[1]!, maxOffset)).toBe(true);

    // Camera-plane safety invariant across the entire scroll range:
    // For width=260px and rotateX(38deg) rotateY(-30deg) rotateZ(-8deg),
    // z_max = 39.583 + 0.664505 * shiftedBottom must stay strictly below 700px.
    for (let offset = 0; offset <= maxOffset; offset += 17) {
      for (const item of items) {
        if (isHistoryItemCulled(item, offset)) continue;
        const shiftedBottom = item.top - offset + item.height;
        const zMax = 39.583 + 0.664505 * shiftedBottom;
        expect(zMax).toBeLessThan(700);
      }
    }
  });

  it('anchors scroll position when new cards prepend while reading lower items', () => {
    // Resting at the top: keep offset at 0 so incoming cards stream naturally from the top.
    expect(anchorHistoryPrepend(0, 0, 150, 2729)).toEqual({ offset: 0, targetOffset: 0 });

    // Scrolled down to offset=600: prepending a 150px card shifts offset & targetOffset by +150
    // so the card currently in view keeps the exact same shiftedTop (item.top - offset).
    expect(anchorHistoryPrepend(600, 600, 150, 2729)).toEqual({
      offset: 750,
      targetOffset: 750,
    });
  });

  it('smoothly converges offset toward clamped targetOffset and normalizes wheel units', () => {
    expect(normalizeWheelDelta(120, 0)).toBe(120);
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(1, 2)).toBe(360);

    let state = { offset: 0, targetOffset: 900 };
    for (let step = 0; step < 60; step++) {
      state = stepHistoryOffset(state.offset, state.targetOffset, 600, 1 / 60);
    }
    expect(state.targetOffset).toBe(600);
    expect(state.offset).toBe(600);
  });
});
