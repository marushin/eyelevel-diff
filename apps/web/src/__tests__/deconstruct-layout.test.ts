import { describe, expect, it } from 'vitest';
import type { DeconstructContent, DeconstructWeight } from '../deconstruct-api.ts';
import {
  OPACITY_EPSILON, emphasisWithin, emphasize, fragmentBox, layoutCloud, layoutHelix, layoutMeaning, layoutOrbit, layoutQueryShell, layoutReading, layoutSplit, nearestNeighbors,
  phraseSource, rankPairs, researchQuery, selectThreads, toSearchQuery, type FragmentBox, type Point,
} from '../deconstruct-layout.ts';

function page(count: number): DeconstructContent[] {
  return Array.from({ length: count }, (_, i): DeconstructContent => i % 7 === 0
    ? { type: 'img', content: `https://example.com/${i}.png` }
    : { type: 'text', content: '조각'.repeat(1 + (i * 13) % 60) });
}
/** Two clearly separated topics: even with even and odd with odd. */
function twoTopics(count: number): DeconstructWeight[] {
  const weights: DeconstructWeight[] = [];
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) weights.push([i, j, (i + j) % 2 === 0 ? .9 : .6]);
  return weights;
}
function overlapping(points: Point[], boxes: FragmentBox[]): number {
  let found = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (Math.abs(points[i]!.x - points[j]!.x) < (boxes[i]!.width + boxes[j]!.width) / 2 &&
        Math.abs(points[i]!.y - points[j]!.y) < (boxes[i]!.height + boxes[j]!.height) / 2) found++;
    }
  }
  return found;
}

describe('deconstruct threads', () => {
  const ranked = rankPairs([[0, 1, .6], [0, 2, .9], [1, 2, .7], [1, 3, .55], [2, 3, .8]]);

  it('orders pairs from strongest to weakest', () => {
    expect(ranked.map((pair) => pair[2])).toEqual([.9, .8, .7, .6, .55]);
  });
  it('keeps the requested top share and stretches the crowded range', () => {
    const threads = selectThreads(ranked, 40);
    expect(threads).toHaveLength(2);
    expect(threads[0]!.strength).toBe(1);
    expect(threads[1]!.strength).toBe(0);
  });
  it('always shows at least one pair and honours the drawing cap', () => {
    expect(selectThreads(ranked, .001)).toHaveLength(1);
    expect(selectThreads(ranked, 100, 3)).toHaveLength(3);
    expect(selectThreads([], 10)).toEqual([]);
  });
  it('shows no threads at zero percent', () => {
    expect(selectThreads(ranked, 0)).toEqual([]);
  });
  it('does not divide by zero when all pairs are equal', () => {
    expect(selectThreads([[0, 1, .7], [0, 2, .7]], 100).every((thread) => thread.strength === 1)).toBe(true);
  });
  it('lists each fragment with its nearest partners', () => {
    const lists = nearestNeighbors(ranked, 4, 2);
    expect(lists[2]!.map((item) => item.index)).toEqual([0, 3]);
    expect(lists[3]!.map((item) => item.index)).toEqual([2, 1]);
  });
});

describe('deconstruct layout', () => {
  it('gives short text larger type and caps very long text', () => {
    const short = fragmentBox({ type: 'text', content: '짧은 글' });
    const long = fragmentBox({ type: 'text', content: '긴 글'.repeat(500) });
    expect(short.fontSize).toBeGreaterThan(long.fontSize);
    expect(long.lines).toBe(6);
  });
  it('flows the reading layout in document order without overlap', () => {
    const boxes = page(120).map(fragmentBox);
    const points = layoutReading(boxes);
    expect(overlapping(points, boxes)).toBe(0);
    expect(points[0]!.x).toBeLessThan(points[119]!.x);
    expect(points[0]!.y).toBeGreaterThan(points[1]!.y);
  });
  it('is deterministic, overlap free and places related fragments together', () => {
    const boxes = page(60).map(fragmentBox);
    const ranked = rankPairs(twoTopics(60));
    const points = layoutMeaning(boxes, ranked);
    expect(layoutMeaning(boxes, ranked)).toEqual(points);
    expect(overlapping(points, boxes)).toBe(0);
    let same = 0; let sameCount = 0; let other = 0; let otherCount = 0;
    for (let i = 0; i < 60; i++) {
      for (let j = i + 1; j < 60; j++) {
        const gap = Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y);
        if ((i + j) % 2 === 0) { same += gap; sameCount++; } else { other += gap; otherCount++; }
      }
    }
    expect(same / sameCount).toBeLessThan(other / otherCount);
  });
  it('handles the API maximum of 500 fragments without overlap', () => {
    const boxes = page(500).map(fragmentBox);
    const ranked = rankPairs(twoTopics(500));
    expect(overlapping(layoutMeaning(boxes, ranked), boxes)).toBe(0);
  });
  it('handles a page with a single fragment or identical positions', () => {
    const one = [fragmentBox({ type: 'text', content: '하나' })];
    expect(layoutMeaning(one, [])).toEqual([{ x: 0, y: 0 }]);
    expect(layoutReading([])).toEqual([]);
  });
});

describe('query emphasis', () => {
  it('keeps the least related fragment visible through the epsilon', () => {
    const [low, , high] = emphasize([.6, .7, .8], 3);
    expect(low!.opacity).toBeCloseTo(OPACITY_EPSILON);
    expect(low!.opacity).toBeGreaterThan(0);
    expect(high!.opacity).toBeCloseTo(1);
    expect(high!.scale).toBeGreaterThan(low!.scale);
  });
  it('does not divide by zero when every value is equal', () => {
    const items = emphasize([.7, .7], 2);
    expect(items[0]!.opacity).toBeGreaterThan(OPACITY_EPSILON);
    expect(Number.isFinite(items[0]!.scale)).toBe(true);
  });
  it('leaves fragments untouched when there is no search term', () => {
    expect(emphasize(undefined, 2)).toEqual([{ level: 1, opacity: 1, scale: 1 }, { level: 1, opacity: 1, scale: 1 }]);
  });
  it('places a later piece on the same scale as the page around it', () => {
    const page = [.6, .7, .8];
    expect(emphasisWithin(.7, page)).toEqual(emphasize(page, 3)[1]);
    expect(emphasisWithin(.2, page).opacity).toBeCloseTo(OPACITY_EPSILON);
  });
  it('grows text and images with their emphasis', () => {
    const text: DeconstructContent = { type: 'text', content: '조각 글' };
    expect(fragmentBox(text, 1.5).fontSize).toBeGreaterThan(fragmentBox(text, 1).fontSize);
    const image: DeconstructContent = { type: 'img', content: 'https://example.com/a.png' };
    expect(fragmentBox(image, 1.5).width).toBeGreaterThan(fragmentBox(image, 1).width);
  });
});

describe('search again', () => {
  const contents: DeconstructContent[] = [
    { type: 'text', content: '  미디어   아트 ' },
    { type: 'img', content: 'https://example.com/a.png', label: '붉은 말 사진' },
    { type: 'img', content: 'https://example.com/b.png' },
    { type: 'img', content: 'https://example.com/c.png' },
  ];
  it('uses text as written, without stray whitespace', () => {
    expect(researchQuery(contents, 0)).toBe('미디어 아트');
  });
  it('uses an image label, then the nearest text fragment', () => {
    expect(researchQuery(contents, 1)).toBe('붉은 말 사진');
    expect(researchQuery(contents, 2, [{ index: 3, weight: .9 }, { index: 0, weight: .8 }])).toBe('미디어 아트');
  });
  it('offers nothing when an image has no words to search by', () => {
    expect(researchQuery(contents, 3, [{ index: 2, weight: .9 }])).toBe('');
  });
  it('breaks further only fragments with enough words', () => {
    expect(phraseSource({ type: 'text', content: '  가상현실   예술 작품 ' })).toBe('가상현실 예술 작품');
    expect(phraseSource({ type: 'text', content: '소개' })).toBe('');
    expect(phraseSource({ type: 'img', content: 'https://example.com/a.png', label: '붉은 말의 사진' })).toBe('붉은 말의 사진');
    expect(phraseSource({ type: 'img', content: 'https://example.com/a.png' })).toBe('');
  });
  it('cuts long text at a word boundary', () => {
    const query = toSearchQuery('낱말 '.repeat(60));
    expect(Array.from(query).length).toBeLessThanOrEqual(100);
    expect(query.endsWith('낱말')).toBe(true);
  });
});

describe('split pieces', () => {
  const boxes = ['가상현실', '디지털 미디어와 예술', '작품', '전시 공간과 관객의 움직임', '기술'].map((content) => fragmentBox({ type: 'text', content }));

  it('sit around the old position in reading order without overlap', () => {
    const points = layoutSplit(boxes);
    expect(overlapping(points, boxes)).toBe(0);
    expect(points[0]!.x).toBeLessThan(points[1]!.x);
    expect(points[0]!.y).toBeGreaterThan(points[4]!.y);
    // The block of pieces stays centred on the old position.
    const top = Math.max(...points.map((point, i) => point.y + boxes[i]!.height / 2));
    const bottom = Math.min(...points.map((point, i) => point.y - boxes[i]!.height / 2));
    expect(Math.abs(top + bottom)).toBeLessThan(1);
  });
  it('handle no pieces', () => {
    expect(layoutSplit([])).toEqual([]);
  });
});

describe('alternative views', () => {
  const contents = page(120);
  const similarities = contents.map((_, i) => (i % 10) / 10);
  const emphasis = emphasize(similarities, contents.length);
  const boxes = contents.map((item, i) => fragmentBox(item, emphasis[i]!.scale));
  const ranked = rankPairs(twoTopics(120));

  it('places related fragments nearer the search term at the centre', () => {
    const points = layoutOrbit(boxes, emphasis);
    expect(overlapping(points, boxes)).toBe(0);
    const reach = (level: number) => {
      const items = points.filter((_, i) => emphasis[i]!.level === level);
      return items.reduce((sum, point) => sum + Math.hypot(point.x, point.y), 0) / items.length;
    };
    expect(reach(1)).toBeLessThan(reach(0));
  });
  it('keeps related fragments nearer the centre in the 3D query view', () => {
    const points = layoutQueryShell(boxes, emphasis);
    const reach = (level: number) => {
      const items = points.filter((_, i) => emphasis[i]!.level === level);
      return items.reduce((sum, point) => sum + Math.hypot(point.x, point.y, point.z!), 0) / items.length;
    };
    expect(reach(1)).toBeLessThan(reach(0));
    expect(new Set(points.map((point) => Math.round(point.z!))).size).toBeGreaterThan(50);
    expect(layoutQueryShell([], [])).toEqual([]);
  });
  it('spreads the cloud through real depth, repeatably', () => {
    const points = layoutCloud(boxes, ranked);
    expect(new Set(points.map((point) => Math.round(point.z!))).size).toBeGreaterThan(50);
    expect(layoutCloud(boxes, ranked)).toEqual(points);
    expect(points.every((point) => Number.isFinite(point.x + point.y + point.z!))).toBe(true);
  });
  it('winds the helix downward in document order', () => {
    const points = layoutHelix(boxes);
    expect(points).toHaveLength(120);
    expect(points[0]!.y).toBeGreaterThan(points[119]!.y);
    const radius = (i: number) => Math.hypot(points[i]!.x, points[i]!.z!);
    expect(radius(0)).toBeCloseTo(radius(60));
  });
  it('handles empty input', () => {
    expect(layoutOrbit([], [])).toEqual([]);
    expect(layoutCloud([], [])).toEqual([]);
    expect(layoutHelix([])).toEqual([]);
  });
});
