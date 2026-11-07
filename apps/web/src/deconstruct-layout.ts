import type { DeconstructContent, DeconstructWeight } from './deconstruct-api.ts';

export interface FragmentBox { width: number; height: number; fontSize: number; lines: number }
export interface Point { x: number; y: number; z?: number }
export interface Thread { a: number; b: number; weight: number; strength: number }
export interface Neighbor { index: number; weight: number }
export interface Emphasis { level: number; opacity: number; scale: number }

const LINE_HEIGHT = 1.45;
const MAX_LINES = 6;
const PACKED_FILL = .5;
const PADDING = 3;
const GAP = 14;
const DEFAULT_MAX_THREADS = 4000;
const SEARCH_QUERY_LIMIT = 100;
const MIN_PHRASE_SOURCE = 6;

/** The floor that keeps the least related fragment from disappearing entirely. */
export const OPACITY_EPSILON = .14;
const MIN_SCALE = .72;
const SCALE_RANGE = 1;

/** Sizes come from content rather than from DOM reads, so layout is pure and causes no reflow. */
export function fragmentBox(fragment: DeconstructContent, scale = 1): FragmentBox {
  if (fragment.type === 'img') {
    return { width: Math.round(200 * scale), height: Math.round(150 * scale), fontSize: 12, lines: 0 };
  }
  const chars = Array.from(fragment.content).length;
  const [width, baseFont] = chars <= 14 ? [200, 22] : chars <= 48 ? [260, 17] : [340, 14];
  const perLine = Math.max(1, Math.floor((width - PADDING * 2) / (baseFont * .92)));
  const lines = Math.min(MAX_LINES, Math.max(1, Math.ceil(chars / perLine)));
  const fontSize = baseFont * scale;
  return {
    width: Math.round(width * scale), height: Math.ceil(lines * fontSize * LINE_HEIGHT) + PADDING * 2,
    fontSize, lines,
  };
}

/**
 * Query similarities crowd into a narrow band, so raw values would look nearly identical.
 * Each page is stretched to its own range, and the epsilon keeps the weakest fragment visible.
 * The range ignores the outer 5% on each side: one exact match would otherwise wash out the rest.
 */
export function emphasize(similarities: readonly number[] | undefined, count: number): Emphasis[] {
  if (!similarities?.length) return Array.from({ length: count }, () => ({ level: 1, opacity: 1, scale: 1 }));
  return similarities.map((value) => emphasisWithin(value, similarities));
}

/** One value on the page's own scale, so pieces split off later match the fragments around them. */
export function emphasisWithin(value: number, similarities: readonly number[]): Emphasis {
  const sorted = [...similarities].sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) * .05)] ?? 0;
  const high = sorted[Math.ceil((sorted.length - 1) * .95)] ?? 1;
  const span = high - low;
  const level = span > 0 ? Math.min(1, Math.max(0, (value - low) / span)) : .5;
  return { level, opacity: OPACITY_EPSILON + (1 - OPACITY_EPSILON) * level, scale: MIN_SCALE + SCALE_RANGE * level };
}

/** Where the pieces of a split fragment sit around its old position, in reading order. */
export function layoutSplit(boxes: readonly FragmentBox[]): Required<Point>[] {
  const maxRow = Math.max(560, ...boxes.map((box) => box.width));
  const rows: { items: number[]; width: number; height: number }[] = [];
  boxes.forEach((box, i) => {
    const row = rows[rows.length - 1];
    if (row && row.width + GAP + box.width <= maxRow) {
      row.items.push(i); row.width += GAP + box.width; row.height = Math.max(row.height, box.height);
    } else rows.push({ items: [i], width: box.width, height: box.height });
  });
  const total = rows.reduce((sum, row) => sum + row.height, 0) + GAP * Math.max(0, rows.length - 1);
  const points: Required<Point>[] = boxes.map(() => ({ x: 0, y: 0, z: 0 }));
  let top = total / 2;
  for (const row of rows) {
    let left = -row.width / 2;
    for (const i of row.items) {
      // The stagger only shows in depth views, where a flat row would turn edge-on as the view rotates.
      points[i] = { x: left + boxes[i]!.width / 2, y: top - row.height / 2, z: (i % 2 ? -1 : 1) * 60 };
      left += boxes[i]!.width + GAP;
    }
    top -= row.height + GAP;
  }
  return points;
}

/** Pairs ordered from strongest to weakest; ties keep document order so results are repeatable. */
export function rankPairs(weights: readonly DeconstructWeight[]): DeconstructWeight[] {
  return [...weights].sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
}

/**
 * Weights crowd into roughly 0.53 to 1, so the shown range is stretched to 0 to 1.
 * A percentile rather than a fixed cut-off is used because the distribution differs per site.
 */
export function selectThreads(ranked: readonly DeconstructWeight[], topPercent: number, maxThreads = DEFAULT_MAX_THREADS): Thread[] {
  if (!ranked.length || topPercent <= 0) return [];
  const count = Math.max(1, Math.min(maxThreads, ranked.length, Math.ceil(ranked.length * topPercent / 100)));
  const top = ranked[0]![2]; const floor = ranked[count - 1]![2];
  const span = top - floor;
  return ranked.slice(0, count).map(([a, b, weight]) => ({ a, b, weight, strength: span > 0 ? (weight - floor) / span : 1 }));
}

/** Each fragment's strongest partners, used for the layout springs and the focus panel. */
export function nearestNeighbors(ranked: readonly DeconstructWeight[], count: number, limit: number): Neighbor[][] {
  const lists: Neighbor[][] = Array.from({ length: count }, () => []);
  for (const [a, b, weight] of ranked) {
    if (lists[a]!.length < limit) lists[a]!.push({ index: b, weight });
    if (lists[b]!.length < limit) lists[b]!.push({ index: a, weight });
  }
  return lists;
}

/** A search box wants a phrase: collapse whitespace and cut long text at a word boundary. */
export function toSearchQuery(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const letters = Array.from(compact);
  if (letters.length <= SEARCH_QUERY_LIMIT) return compact;
  const cut = letters.slice(0, SEARCH_QUERY_LIMIT).join('');
  const boundary = cut.lastIndexOf(' ');
  return boundary > SEARCH_QUERY_LIMIT / 2 ? cut.slice(0, boundary) : cut;
}

/** An image has no text of its own, so it searches by its label or else its nearest text fragment. */
export function researchQuery(contents: readonly DeconstructContent[], index: number, partners: readonly Neighbor[] = []): string {
  const fragment = contents[index];
  if (!fragment) return '';
  if (fragment.type === 'text') return toSearchQuery(fragment.content);
  if (fragment.label?.trim()) return toSearchQuery(fragment.label);
  const nearestText = partners.map((item) => contents[item.index]).find((item) => item?.type === 'text');
  return nearestText ? toSearchQuery(nearestText.content) : '';
}

/** The words a fragment can be broken further from; too short a fragment has nothing to break. */
export function phraseSource(fragment: DeconstructContent | undefined): string {
  const text = (fragment?.type === 'text' ? fragment.content : fragment?.label ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(text).length >= MIN_PHRASE_SOURCE ? text : '';
}

/** The page as it is read: document order flowing down columns of a roughly page-shaped sheet. */
export function layoutReading(boxes: readonly FragmentBox[]): Point[] {
  if (!boxes.length) return [];
  const columnWidth = Math.max(...boxes.map((box) => box.width)) + GAP * 2;
  const area = boxes.reduce((sum, box) => sum + columnWidth * (box.height + GAP), 0);
  const targetHeight = Math.max(320, Math.sqrt(area * .7));
  const points: Point[] = [];
  const columnBottoms: number[] = [];
  let column = 0; let y = 0;
  for (const box of boxes) {
    if (y > 0 && y + box.height > targetHeight) { columnBottoms[column] = y; column++; y = 0; }
    points.push({ x: column * columnWidth + box.width / 2, y: y + box.height / 2 });
    y += box.height + GAP;
  }
  columnBottoms[column] = y;
  const width = (column + 1) * columnWidth;
  const height = Math.max(...columnBottoms);
  // World y grows upward, so the first fragment sits at the top-left of the sheet.
  return points.map((point) => ({ x: point.x - width / 2, y: height / 2 - point.y }));
}

function separate(points: Point[], boxes: readonly FragmentBox[]): void {
  // Dense pages can jam while pushing pairs apart, so each failed round also opens up the whole sheet.
  for (let round = 0; round < 40; round++) {
    if (separationPasses(points, boxes, 120)) return;
    for (const point of points) { point.x *= 1.06; point.y *= 1.06; }
  }
}

function separationPasses(points: Point[], boxes: readonly FragmentBox[], maxPasses: number): boolean {
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const p = points[i]!; const q = points[j]!;
        const dx = q.x - p.x; const dy = q.y - p.y;
        const overlapX = (boxes[i]!.width + boxes[j]!.width) / 2 + GAP - Math.abs(dx);
        const overlapY = (boxes[i]!.height + boxes[j]!.height) / 2 + GAP - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        // Identical positions still need a direction; document order keeps it deterministic.
        if (overlapX * .6 < overlapY) {
          const push = overlapX / 2 * (dx === 0 ? (i % 2 ? 1 : -1) : Math.sign(dx));
          p.x -= push; q.x += push;
        } else {
          const push = overlapY / 2 * (dy === 0 ? (j % 2 ? 1 : -1) : Math.sign(dy));
          p.y -= push; q.y += push;
        }
      }
    }
    if (!moved) return true;
  }
  return false;
}

function spacingOf(boxes: readonly FragmentBox[]): number {
  return Math.sqrt(boxes.reduce((sum, box) => sum + box.width * box.height, 0) / boxes.length) * 1.25;
}

function buildSprings(count: number, ranked: readonly DeconstructWeight[]) {
  const median = ranked.length ? ranked[Math.floor(ranked.length / 2)]![2] : 0;
  const seen = new Set<number>();
  const springs: { a: number; b: number; pull: number }[] = [];
  nearestNeighbors(ranked, count, 4).forEach((list, a) => {
    for (const { index: b, weight } of list) {
      const key = Math.min(a, b) * count + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      springs.push({ a, b, pull: Math.max(0, (weight - median) / Math.max(1e-6, 1 - median)) });
    }
  });
  return springs;
}

/** A deterministic spring layout over each fragment's strongest partners, in the plane or in space. */
function relax(boxes: readonly FragmentBox[], ranked: readonly DeconstructWeight[], depth: boolean): Required<Point>[] {
  const count = boxes.length;
  const spacing = spacingOf(boxes);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = boxes.map((_, i): Required<Point> => {
    const angle = i * golden;
    if (!depth) {
      const radius = Math.sqrt(i + .5) * spacing;
      return { x: Math.cos(angle) * radius * 1.4, y: Math.sin(angle) * radius, z: 0 };
    }
    const y = 1 - (2 * (i + .5)) / count;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const radius = Math.cbrt((i + .5) / count) * Math.cbrt(count) * spacing;
    return { x: Math.cos(angle) * ring * radius, y: y * radius, z: Math.sin(angle) * ring * radius };
  });
  const springs = buildSprings(count, ranked);
  const iterations = count > 300 ? 110 : 200;
  const repulsion = spacing * spacing * 1.2;
  const fx = new Float64Array(count); const fy = new Float64Array(count); const fz = new Float64Array(count);
  for (let step = 0; step < iterations; step++) {
    const heat = 1 - step / iterations;
    fx.fill(0); fy.fill(0); fz.fill(0);
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const x = points[i]!.x - points[j]!.x; const y = points[i]!.y - points[j]!.y; const z = points[i]!.z - points[j]!.z;
        const force = repulsion / Math.max(1, x * x + y * y + z * z);
        fx[i]! += x * force; fy[i]! += y * force; fz[i]! += z * force;
        fx[j]! -= x * force; fy[j]! -= y * force; fz[j]! -= z * force;
      }
    }
    for (const { a, b, pull } of springs) {
      const x = points[b]!.x - points[a]!.x; const y = points[b]!.y - points[a]!.y; const z = points[b]!.z - points[a]!.z;
      const distance = Math.max(1, Math.hypot(x, y, z));
      const force = (distance - spacing * (1.7 - pull)) * (.04 + pull * .12) / distance;
      fx[a]! += x * force; fy[a]! += y * force; fz[a]! += z * force;
      fx[b]! -= x * force; fy[b]! -= y * force; fz[b]! -= z * force;
    }
    const limit = spacing * .8 * heat + 1;
    for (let i = 0; i < count; i++) {
      const point = points[i]!;
      // Widescreen gravity keeps the plane from forming a circle the screen cannot show.
      const moveX = fx[i]! - point.x * .012;
      const moveY = fy[i]! - point.y * (depth ? .012 : .022);
      const moveZ = depth ? fz[i]! - point.z * .012 : 0;
      const length = Math.max(1, Math.hypot(moveX, moveY, moveZ));
      const scale = Math.min(limit, length) / length;
      point.x += moveX * scale; point.y += moveY * scale; point.z += moveZ * scale;
    }
  }
  return points;
}

function centered<T extends Point>(points: T[]): T[] {
  const count = Math.max(1, points.length);
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / count;
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / count;
  const centerZ = points.reduce((sum, point) => sum + (point.z ?? 0), 0) / count;
  return points.map((point) => ({ ...point, x: point.x - centerX, y: point.y - centerY, ...(point.z === undefined ? {} : { z: point.z - centerZ }) }));
}

/** The page by meaning: related fragments gather, packed so that each one stays readable. */
export function layoutMeaning(boxes: readonly FragmentBox[], ranked: readonly DeconstructWeight[]): Point[] {
  if (!boxes.length) return [];
  const relaxed = relax(boxes, ranked, false).map(({ x, y }): Point => ({ x, y }));
  // Forces alone scatter fragments until they read as dots.
  const bounds = boundsOf(relaxed, boxes);
  const usedArea = Math.max(1, (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY));
  const paperArea = boxes.reduce((sum, box) => sum + (box.width + GAP) * (box.height + GAP), 0);
  const pack = Math.min(1, Math.sqrt(paperArea / PACKED_FILL / usedArea));
  for (const point of relaxed) { point.x *= pack; point.y *= pack; }
  separate(relaxed, boxes);
  return centered(relaxed);
}

/** The page around the search term: the closer to the centre, the more related to the query. */
export function layoutOrbit(boxes: readonly FragmentBox[], emphasis: readonly Emphasis[]): Point[] {
  if (!boxes.length) return [];
  const paperArea = boxes.reduce((sum, box) => sum + (box.width + GAP) * (box.height + GAP), 0);
  const outer = Math.sqrt(paperArea / PACKED_FILL / Math.PI);
  const inner = Math.max(240, outer * .16);
  const order = boxes.map((_, i) => i).sort((p, q) => emphasis[q]!.level - emphasis[p]!.level || p - q);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: Point[] = boxes.map(() => ({ x: 0, y: 0 }));
  order.forEach((index, rank) => {
    const radius = inner + (1 - emphasis[index]!.level) * (outer - inner);
    const angle = rank * golden;
    points[index] = { x: Math.cos(angle) * radius * 1.25, y: Math.sin(angle) * radius };
  });
  separate(points, boxes);
  return points;
}

/** The page around the search term in space: nearer the centre means more related, in every direction. */
export function layoutQueryShell(boxes: readonly FragmentBox[], emphasis: readonly Emphasis[]): Point[] {
  if (!boxes.length) return [];
  const outer = spacingOf(boxes) * Math.cbrt(boxes.length) * 1.35;
  const inner = Math.max(300, outer * .18);
  const order = boxes.map((_, i) => i).sort((p, q) => emphasis[q]!.level - emphasis[p]!.level || p - q);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: Point[] = boxes.map(() => ({ x: 0, y: 0, z: 0 }));
  order.forEach((index, rank) => {
    const radius = inner + (1 - emphasis[index]!.level) * (outer - inner);
    const y = 1 - (2 * (rank + .5)) / boxes.length;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = rank * golden;
    points[index] = { x: Math.cos(angle) * ring * radius, y: y * radius, z: Math.sin(angle) * ring * radius };
  });
  return points;
}

/** The page by meaning in space: related fragments form clusters to look around. */
export function layoutCloud(boxes: readonly FragmentBox[], ranked: readonly DeconstructWeight[]): Point[] {
  if (!boxes.length) return [];
  const points = centered(relax(boxes, ranked, true));
  const reach = Math.max(1, ...points.map((point) => Math.hypot(point.x, point.y, point.z)));
  const target = spacingOf(boxes) * Math.cbrt(boxes.length) * 1.05;
  return points.map((point) => ({ x: point.x / reach * target, y: point.y / reach * target, z: point.z / reach * target }));
}

/** The page as read, wound into a spiral: document order runs from top to bottom. */
export function layoutHelix(boxes: readonly FragmentBox[]): Point[] {
  if (!boxes.length) return [];
  const widest = Math.max(...boxes.map((box) => box.width));
  const perTurn = Math.max(8, Math.round(Math.sqrt(boxes.length) * 1.6));
  const radius = perTurn * (widest * .7) / (2 * Math.PI);
  const pitch = Math.max(...boxes.map((box) => box.height)) * 1.5;
  const height = (boxes.length / perTurn) * pitch;
  return boxes.map((_, i) => {
    const angle = (i / perTurn) * Math.PI * 2;
    return { x: Math.cos(angle) * radius, y: height / 2 - (i / perTurn) * pitch, z: Math.sin(angle) * radius };
  });
}

export function boundsOf(points: readonly Point[], boxes: readonly FragmentBox[]) {
  let minX = 0; let maxX = 0; let minY = 0; let maxY = 0;
  points.forEach((point, i) => {
    const box = boxes[i]!;
    const left = point.x - box.width / 2; const right = point.x + box.width / 2;
    const bottom = point.y - box.height / 2; const top = point.y + box.height / 2;
    if (i === 0) { minX = left; maxX = right; minY = bottom; maxY = top; return; }
    minX = Math.min(minX, left); maxX = Math.max(maxX, right);
    minY = Math.min(minY, bottom); maxY = Math.max(maxY, top);
  });
  return { minX, maxX, minY, maxY };
}
