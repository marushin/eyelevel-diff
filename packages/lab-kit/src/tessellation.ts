import {
  type CanonicalEdge,
  type CanonicalNode,
  type CrawlSnapshot,
  hashString,
} from '@akl/graph-contract';
import type { Point2D } from './layout-engine.ts';

export interface TessellationViewport {
  width: number;
  height: number;
}

export interface TessellationOptions {
  /** Optional previous site positions for smooth temporal continuity across frames. */
  previousSites?: ReadonlyMap<string, Point2D>;
  /** Optional interactive weight boosts (e.g. hovered tectonic plate swells). */
  weightOverrides?: ReadonlyMap<string, number>;
  /** Number of graph-aware spring/repulsion relaxation iterations (default: 36). */
  relaxationIterations?: number;
  /** Viewport margin for site centers (default: 36). */
  margin?: number;
}

export interface TectonicCell {
  nodeId: string;
  node: CanonicalNode;
  site: Point2D;
  polygon: Point2D[];
  centroid: Point2D;
  interiorPoint: Point2D;
  area: number;
  inradius: number;
  weight: number;
  labelAngle: number;
}

export interface SharedSeam {
  id: string;
  cellA: string;
  cellB: string;
  p0: Point2D;
  p1: Point2D;
  midpoint: Point2D;
  length: number;
  /** Readable orientation angle in [-PI/2, PI/2] parallel to the shared border. */
  angle: number;
  edge?: CanonicalEdge;
  anchorText?: string;
  isHyperlink: boolean;
  traversed: boolean;
}

export interface PowerTessellationResult {
  cells: TectonicCell[];
  seams: SharedSeam[];
  sites: Map<string, Point2D>;
}

interface TaggedVertex {
  x: number;
  y: number;
  /** Neighbor nodeId on the edge starting at this vertex -> next vertex, or null if viewport boundary. */
  edgeNeighborId: string | null;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function normalizeReadableAngle(rad: number): number {
  let a = rad;
  while (a > Math.PI * 0.5) a -= Math.PI;
  while (a < -Math.PI * 0.5) a += Math.PI;
  return a;
}

function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function computePolygonInradiusAndCenter(poly: readonly Point2D[], centroid: Point2D): {
  inradius: number;
  interiorPoint: Point2D;
} {
  if (poly.length < 3) {
    return { inradius: 0, interiorPoint: centroid };
  }

  const clearanceAt = (x: number, y: number): number => {
    let minD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const d = pointToSegmentDist(x, y, a.x, a.y, b.x, b.y);
      if (d < minD) minD = d;
    }
    return minD;
  };

  // Since every Laguerre cell is strictly convex, the centroid is guaranteed interior;
  // refine with a deterministic 9-point local probe toward the thickest interior pocket.
  let bestX = centroid.x;
  let bestY = centroid.y;
  let bestR = clearanceAt(bestX, bestY);

  let step = Math.max(4, bestR * 0.35);
  for (let pass = 0; pass < 3; pass++) {
    for (let dir = 0; dir < 8; dir++) {
      const ang = (dir * Math.PI) / 4;
      const cx = bestX + Math.cos(ang) * step;
      const cy = bestY + Math.sin(ang) * step;
      // Convex inside check: signed cross products all have same sign as centroid
      if (isPointInsideConvexPolygon(cx, cy, poly)) {
        const r = clearanceAt(cx, cy);
        if (r > bestR) {
          bestR = r;
          bestX = cx;
          bestY = cy;
        }
      }
    }
    step *= 0.5;
  }

  return {
    inradius: bestR,
    interiorPoint: { x: bestX, y: bestY },
  };
}

function isPointInsideConvexPolygon(x: number, y: number, poly: readonly Point2D[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

function computePolygonAreaAndCentroid(poly: readonly Point2D[]): {
  area: number;
  centroid: Point2D;
  labelAngle: number;
} {
  const n = poly.length;
  if (n < 3) {
    const fallback = poly[0] ?? { x: 0, y: 0 };
    return { area: 0, centroid: fallback, labelAngle: 0 };
  }

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < n; i++) {
    const p0 = poly[i]!;
    const p1 = poly[(i + 1) % n]!;
    const cross = p0.x * p1.y - p1.x * p0.y;
    twiceArea += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }

  const area = Math.abs(twiceArea) * 0.5;
  if (area < 1e-5) {
    let mx = 0;
    let my = 0;
    for (const p of poly) {
      mx += p.x;
      my += p.y;
    }
    return { area: 0, centroid: { x: mx / n, y: my / n }, labelAngle: 0 };
  }

  const inv = 1 / (3 * twiceArea);
  const centroid = { x: cx * inv, y: cy * inv };

  // Principal axis orientation via vertex covariance around centroid (gently clamped for legibility)
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of poly) {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const rawAngle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const readable = normalizeReadableAngle(rawAngle);
  // Subtle geological tilt clamped to [-18 deg, +18 deg] so interior colophons read effortlessly
  const clampedAngle = Math.max(-0.32, Math.min(0.32, readable * 0.35));

  return { area, centroid, labelAngle: clampedAngle };
}

/**
 * Exact Sutherland-Hodgman half-plane clipper for Laguerre Power Diagram:
 * Keeps points `p` satisfying `(p - s_i) · (s_j - s_i) <= rhs`, where
 * `rhs = 0.5 * (||s_j - s_i||^2 + w_i - w_j)`, tagging the newly cut chord with `neighborId`.
 */
function clipAgainstRadicalAxis(
  poly: readonly TaggedVertex[],
  si: Point2D,
  sj: Point2D,
  wi: number,
  wj: number,
  neighborId: string,
): TaggedVertex[] {
  const n = poly.length;
  if (n < 3) return [];

  const dx = sj.x - si.x;
  const dy = sj.y - si.y;
  const distSq = dx * dx + dy * dy;
  if (distSq < 1e-9) return [...poly];

  // Equivalent to: (p - s_i) · (s_j - s_i) <= 0.5 * (||s_j||^2 - ||s_i||^2 - w_j + w_i) - s_i · (s_j - s_i)
  const rhs = 0.5 * (distSq + wi - wj);
  const evalSigned = (p: Point2D): number => (p.x - si.x) * dx + (p.y - si.y) * dy - rhs;

  const out: TaggedVertex[] = [];
  const eps = 1e-7;

  for (let k = 0; k < n; k++) {
    const curr = poly[k]!;
    const next = poly[(k + 1) % n]!;
    const dc = evalSigned(curr);
    const dn = evalSigned(next);
    const currIn = dc <= eps;
    const nextIn = dn <= eps;

    if (currIn && nextIn) {
      out.push(curr);
    } else if (currIn && !nextIn) {
      out.push(curr);
      const denom = dc - dn;
      const t = Math.abs(denom) < 1e-12 ? 0.5 : Math.max(0, Math.min(1, dc / denom));
      // Exiting half-plane: the edge from this intersection to the re-entry intersection belongs to `neighborId`
      out.push({
        x: curr.x + (next.x - curr.x) * t,
        y: curr.y + (next.y - curr.y) * t,
        edgeNeighborId: neighborId,
      });
    } else if (!currIn && nextIn) {
      const denom = dc - dn;
      const t = Math.abs(denom) < 1e-12 ? 0.5 : Math.max(0, Math.min(1, dc / denom));
      // Entering half-plane: the resumed edge keeps `curr.edgeNeighborId`
      out.push({
        x: curr.x + (next.x - curr.x) * t,
        y: curr.y + (next.y - curr.y) * t,
        edgeNeighborId: curr.edgeNeighborId,
      });
    }
  }

  if (out.length < 3) return [];

  // Deduplicate degenerate zero-length vertices while preserving outgoing edge tags
  const cleaned: TaggedVertex[] = [];
  for (let i = 0; i < out.length; i++) {
    const v = out[i]!;
    const next = out[(i + 1) % out.length]!;
    if (Math.hypot(next.x - v.x, next.y - v.y) > 1e-4) {
      cleaned.push(v);
    }
  }

  return cleaned.length >= 3 ? cleaned : [];
}

/**
 * Deterministic graph-aware site layout & spring/repulsion relaxation so nodes linked
 * by `CanonicalEdge` pull into direct contact and share real geometric borders.
 */
export function layoutGraphSites(
  nodes: readonly CanonicalNode[],
  edges: readonly CanonicalEdge[],
  viewport: TessellationViewport,
  options: TessellationOptions = {},
): Map<string, Point2D> {
  const width = Math.max(120, viewport.width);
  const height = Math.max(120, viewport.height);
  const margin = Math.min(width * 0.12, height * 0.12, options.margin ?? 38);
  const count = nodes.length;
  const result = new Map<string, Point2D>();

  if (count === 0) return result;
  if (count === 1) {
    result.set(nodes[0]!.id, { x: width * 0.5, y: height * 0.5 });
    return result;
  }

  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const idealSpacing = Math.sqrt((width * height) / count) * 0.72;

  const pos = nodes.map((n, idx) => {
    const prev = options.previousSites?.get(n.id);
    if (prev) {
      return {
        x: Math.max(margin, Math.min(width - margin, prev.x)),
        y: Math.max(margin, Math.min(height - margin, prev.y)),
      };
    }

    if (n.depth === 0) {
      return { x: centerX, y: centerY };
    }

    const h = hashString(n.id);
    const angle = idx * GOLDEN_ANGLE + ((h % 360) * Math.PI) / 180;
    const radialBand =
      n.state === 'frontier'
        ? 0.36 + (h % 14) * 0.008
        : Math.min(0.38, 0.12 + n.depth * 0.065);

    return {
      x: Math.max(margin, Math.min(width - margin, centerX + Math.cos(angle) * width * radialBand)),
      y: Math.max(margin, Math.min(height - margin, centerY + Math.sin(angle) * height * radialBand)),
    };
  });

  const idToIndex = new Map<string, number>();
  nodes.forEach((n, idx) => idToIndex.set(n.id, idx));

  // Ensure newborn nodes with an already-placed parent spawn near their parent
  for (let i = 0; i < count; i++) {
    const n = nodes[i]!;
    if (!options.previousSites?.has(n.id) && n.parentId) {
      const pIdx = idToIndex.get(n.parentId);
      if (pIdx !== undefined) {
        const h = hashString(n.id);
        const ang = ((h % 360) * Math.PI) / 180;
        const offset = idealSpacing * 0.55;
        pos[i]!.x = Math.max(margin, Math.min(width - margin, pos[pIdx]!.x + Math.cos(ang) * offset));
        pos[i]!.y = Math.max(margin, Math.min(height - margin, pos[pIdx]!.y + Math.sin(ang) * offset));
      }
    }
  }

  const edgePairs: { a: number; b: number; strength: number; targetDist: number }[] = [];
  for (const e of edges) {
    const a = idToIndex.get(e.source);
    const b = idToIndex.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    edgePairs.push({
      a,
      b,
      strength: e.traversed ? 0.26 : 0.18,
      targetDist: idealSpacing * (e.traversed ? 0.68 : 0.82),
    });
  }

  const iterations = options.relaxationIterations ?? (options.previousSites ? 8 : 38);
  const dispX = new Float64Array(count);
  const dispY = new Float64Array(count);

  for (let iter = 0; iter < iterations; iter++) {
    dispX.fill(0);
    dispY.fill(0);
    const cooling = 1 - iter / (iterations + 4);

    // Pairwise area-spreading repulsion
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1) {
          const ang = ((i * 73 + j * 31) % 360) * (Math.PI / 180);
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          dist = 1;
        }
        if (dist < idealSpacing * 1.45) {
          const push = ((idealSpacing * 1.45 - dist) / (idealSpacing * 1.45)) * idealSpacing * 0.22;
          const fx = (dx / dist) * push;
          const fy = (dy / dist) * push;
          dispX[i]! += fx;
          dispY[i]! += fy;
          dispX[j]! -= fx;
          dispY[j]! -= fy;
        }
      }
    }

    // Graph-edge spring attraction so linked nodes share contiguous polygon seams
    for (const link of edgePairs) {
      const dx = pos[link.b]!.x - pos[link.a]!.x;
      const dy = pos[link.b]!.y - pos[link.a]!.y;
      const dist = Math.hypot(dx, dy) || 1;
      const delta = (dist - link.targetDist) * link.strength;
      const fx = (dx / dist) * delta;
      const fy = (dy / dist) * delta;
      dispX[link.a]! += fx;
      dispY[link.a]! += fy;
      dispX[link.b]! -= fx;
      dispY[link.b]! -= fy;
    }

    // Gentle continental centering for query-root; push frontier slightly toward shelf rim
    for (let i = 0; i < count; i++) {
      const node = nodes[i]!;
      if (node.depth === 0) {
        dispX[i]! += (centerX - pos[i]!.x) * 0.35;
        dispY[i]! += (centerY - pos[i]!.y) * 0.35;
      } else if (node.state === 'frontier') {
        const rx = pos[i]!.x - centerX;
        const ry = pos[i]!.y - centerY;
        const rLen = Math.hypot(rx, ry) || 1;
        dispX[i]! += (rx / rLen) * idealSpacing * 0.04;
        dispY[i]! += (ry / rLen) * idealSpacing * 0.04;
      }

      const maxStep = idealSpacing * 0.32 * cooling;
      const stepLen = Math.hypot(dispX[i]!, dispY[i]!);
      const scale = stepLen > maxStep ? maxStep / stepLen : 1;

      pos[i]!.x = Math.max(margin, Math.min(width - margin, pos[i]!.x + dispX[i]! * scale));
      pos[i]!.y = Math.max(margin, Math.min(height - margin, pos[i]!.y + dispY[i]! * scale));
    }
  }

  nodes.forEach((n, idx) => {
    result.set(n.id, pos[idx]!);
  });

  return result;
}

function defaultStateWeight(node: CanonicalNode, avgCellArea: number): number {
  const unit = avgCellArea * 0.16;
  switch (node.state) {
    case 'query-root':
      return unit * 1.45;
    case 'tail-seed':
      return unit * 1.25;
    case 'visited':
    case 'redirected':
      return unit * 0.95;
    case 'dead':
      return unit * 0.35;
    case 'frontier':
      return -unit * 0.35;
  }
}

/**
 * Computes a full-viewport 2D Weighted Voronoi / Laguerre Power Diagram tessellation
 * (`Node = Polygonal Territory`, `Edge = Shared Tectonic Seam`) with zero empty background void.
 */
export function computePowerTessellation(
  snapshot: Pick<CrawlSnapshot, 'nodes' | 'edges'>,
  viewport: TessellationViewport,
  options: TessellationOptions = {},
): PowerTessellationResult {
  const width = Math.max(10, viewport.width);
  const height = Math.max(10, viewport.height);
  const nodes = snapshot.nodes;

  if (nodes.length === 0) {
    return { cells: [], seams: [], sites: new Map() };
  }

  const sites = layoutGraphSites(nodes, snapshot.edges, { width, height }, options);
  const avgCellArea = (width * height) / nodes.length;

  // Raw scalar weights per site
  const rawWeights = nodes.map((n) => {
    const base = defaultStateWeight(n, avgCellArea);
    const override = options.weightOverrides?.get(n.id);
    return override !== undefined ? base + override : base;
  });

  // Uniformly scale scalar weights if needed so no site swallows a neighbor completely
  // while preserving exact Laguerre radical-center concurrency (zero gaps / zero overlaps!).
  let weightScale = 1;
  for (let i = 0; i < nodes.length; i++) {
    const si = sites.get(nodes[i]!.id)!;
    for (let j = i + 1; j < nodes.length; j++) {
      const sj = sites.get(nodes[j]!.id)!;
      const distSq = (sj.x - si.x) ** 2 + (sj.y - si.y) ** 2;
      const diff = Math.abs(rawWeights[i]! - rawWeights[j]!);
      if (diff > 1e-6 && distSq > 1e-6) {
        const maxAllowed = distSq * 0.72;
        if (diff * weightScale > maxAllowed) {
          weightScale = maxAllowed / diff;
        }
      }
    }
  }

  const weights = rawWeights.map((w) => w * weightScale);

  // Build unordered edge lookup for instant seam matching
  const edgeLookup = new Map<string, CanonicalEdge>();
  for (const edge of snapshot.edges) {
    const key = edge.source < edge.target ? `${edge.source}::${edge.target}` : `${edge.target}::${edge.source}`;
    const existing = edgeLookup.get(key);
    // Prefer traversed edge if parallel edges exist
    if (!existing || (!existing.traversed && edge.traversed)) {
      edgeLookup.set(key, edge);
    }
  }

  const cells: TectonicCell[] = [];
  const seamMap = new Map<string, SharedSeam>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const si = sites.get(node.id)!;
    const wi = weights[i]!;

    // Start with the full viewport rectangle (CW in screen coordinates)
    let taggedPoly: TaggedVertex[] = [
      { x: 0, y: 0, edgeNeighborId: null },
      { x: width, y: 0, edgeNeighborId: null },
      { x: width, y: height, edgeNeighborId: null },
      { x: 0, y: height, edgeNeighborId: null },
    ];

    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const other = nodes[j]!;
      const sj = sites.get(other.id)!;
      const wj = weights[j]!;
      taggedPoly = clipAgainstRadicalAxis(taggedPoly, si, sj, wi, wj, other.id);
      if (taggedPoly.length < 3) break;
    }

    const polygon: Point2D[] = taggedPoly.map((v) => ({ x: v.x, y: v.y }));
    const { area, centroid, labelAngle } = computePolygonAreaAndCentroid(polygon);
    const { inradius, interiorPoint } = computePolygonInradiusAndCenter(polygon, centroid);

    cells.push({
      nodeId: node.id,
      node,
      site: si,
      polygon,
      centroid,
      interiorPoint,
      area,
      inradius,
      weight: wi,
      labelAngle,
    });

    // Extract shared seams from tagged interior polygon edges
    for (let k = 0; k < taggedPoly.length; k++) {
      const v0 = taggedPoly[k]!;
      const neighborId = v0.edgeNeighborId;
      if (!neighborId) continue;

      const v1 = taggedPoly[(k + 1) % taggedPoly.length]!;
      const length = Math.hypot(v1.x - v0.x, v1.y - v0.y);
      if (length < 0.75) continue;

      const cellA = node.id < neighborId ? node.id : neighborId;
      const cellB = node.id < neighborId ? neighborId : node.id;
      const pairKey = `${cellA}::${cellB}`;
      if (seamMap.has(pairKey)) continue;

      const matchedEdge = edgeLookup.get(pairKey);
      const targetNode = matchedEdge
        ? nodes.find((n) => n.id === matchedEdge.target)
        : undefined;
      const anchorText =
        matchedEdge?.anchorText ?? targetNode?.content?.anchorText ?? undefined;

      const p0 = { x: v0.x, y: v0.y };
      const p1 = { x: v1.x, y: v1.y };
      const midpoint = { x: (v0.x + v1.x) * 0.5, y: (v0.y + v1.y) * 0.5 };
      const angle = normalizeReadableAngle(Math.atan2(v1.y - v0.y, v1.x - v0.x));

      seamMap.set(pairKey, {
        id: `seam-${pairKey}`,
        cellA,
        cellB,
        p0,
        p1,
        midpoint,
        length,
        angle,
        ...(matchedEdge ? { edge: matchedEdge } : {}),
        ...(anchorText ? { anchorText } : {}),
        isHyperlink: Boolean(matchedEdge),
        traversed: Boolean(matchedEdge?.traversed),
      });
    }
  }

  return {
    cells,
    seams: Array.from(seamMap.values()),
    sites,
  };
}
