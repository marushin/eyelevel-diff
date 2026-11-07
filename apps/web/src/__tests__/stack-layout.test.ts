import { describe, expect, it } from 'vitest';
import { createSiteFixture } from '../data.ts';
import { layoutStacks } from '../stack-layout.ts';

describe('sideways drift stacks', () => {
  it('branches from the actual original parent and keeps subsequent drift pages in that stack', () => {
    const fixture = createSiteFixture({ query: '사과', seed: 4201 });
    const before = JSON.stringify(fixture);
    const layout = layoutStacks(fixture);
    expect(layout.size).toBe(18);
    for (const page of fixture.pages) {
      const parent = layout.get(page.node.parentId ?? '');
      if (!parent) continue;
      const parentPage = fixture.pages.find((item) => item.node.id === page.node.parentId)!;
      const point = layout.get(page.node.id)!;
      if (page.group === 'drift' && parentPage.group === 'original') {
        expect(point.stack).not.toBe(parent.stack);
        expect(point.branchFrom).toBe(page.node.parentId);
        expect(Math.abs(point.x - parent.x) >= 540 || Math.abs(point.z - parent.z) >= 750).toBe(true);
        expect(fixture.edges.some((edge) => edge.source === page.node.parentId && edge.target === page.node.id)).toBe(true);
      } else {
        expect(point.stack).toBe(parent.stack);
      }
    }
    const cards = [...layout.values()];
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        if (cards[i]!.stack !== cards[j]!.stack) {
          expect(Math.abs(cards[i]!.x - cards[j]!.x) >= 540 || Math.abs(cards[i]!.z - cards[j]!.z) >= 750).toBe(true);
        }
      }
    }
    const good = fixture.pages.filter((page) => page.group === 'original').map((page) => layout.get(page.node.id)!);
    expect(new Set(good.map((point) => point.stack)).size).toBe(1);
    expect(good.every((point, index) => point.x === -75 * index && point.z === index * 135)).toBe(true);
    const driftPages = fixture.pages.filter((page) => page.group === 'drift');
    expect(new Set(driftPages.map((page) => page.node.parentId)).size).toBe(8);
    const awesome = driftPages.map((page) => layout.get(page.node.id)!);
    expect(new Set(awesome.map((point) => point.stack)).size).toBe(8);
    for (let i = 0; i < awesome.length; i++) {
      for (let j = i + 1; j < awesome.length; j++) {
        expect(Math.abs(awesome[i]!.x - awesome[j]!.x) >= 540 ||
          Math.abs(awesome[i]!.z - awesome[j]!.z) >= 750).toBe(true);
      }
    }
    expect(JSON.stringify(fixture)).toBe(before);
    expect(layoutStacks(fixture)).toEqual(layout);
  });
});
