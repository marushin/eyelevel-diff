import { describe, expect, it } from 'vitest';
import { appendSearch } from '../continuation.ts';
import { createSiteFixture } from '../data.ts';
import { layoutStacks, placeContinuation } from '../stack-layout.ts';

describe('continuation placement', () => {
  it('keeps old positions and binds new roots to the selected card', () => {
    const current = createSiteFixture({ query: '나비', seed: 4201 });
    const incoming = createSiteFixture({ query: '날개의 구조', seed: 4201 });
    const anchor = current.pages[5]!.node;
    const positions = layoutStacks(current);
    const before = JSON.stringify([...positions]);
    const combined = appendSearch(current, incoming, anchor.id, 1);
    expect(combined.pages).toHaveLength(36);
    const newPages = combined.pages.filter((page) => page.node.id.startsWith('search-1:'));
    const newRoots = newPages.filter((page) => page.node.parentId === anchor.id);
    expect(newRoots.length).toBeGreaterThan(0);
    const additions = placeContinuation(positions, { ...combined, root: anchor, pages: newPages }, anchor.id);
    expect(additions.size).toBe(18);
    expect(JSON.stringify([...positions])).toBe(before);
    const firstGood = newPages.find((page) => page.group === 'original')!;
    const first = additions.get(firstGood.node.id)!;
    const source = positions.get(anchor.id)!;
    expect(first.x).toBe(source.x - 105);
    expect(first.z).toBe(source.z + 155);
    expect(Math.hypot(first.x - source.x, first.z - source.z)).toBeLessThan(200);
    for (const page of newPages.filter((page) => page.group === 'drift')) {
      const point = additions.get(page.node.id)!;
      for (const old of positions.values()) {
        expect(Math.abs(point.x - old.x) >= 540 || Math.abs(point.z - old.z) >= 750).toBe(true);
      }
    }
    expect(current.pages).toHaveLength(18);
  });
});
