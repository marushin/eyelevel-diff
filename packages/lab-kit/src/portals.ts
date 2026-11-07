import {
  type CanonicalEdge,
  type CanonicalNode,
  type CrawlSnapshot,
  getNodeDisplayLabel,
  hashString,
} from '@akl/graph-contract';
import type { Point2D } from './layout-engine.ts';

export interface RectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StratumLayer {
  node: CanonicalNode;
  depth: number;
  outerContour: Point2D[];
  innerCutout: Point2D[];
  edgeLabel: string;
  rimAnchorPoint: Point2D;
  rimAngle: number;
}

export interface ActiveSheetGeometry {
  node: CanonicalNode;
  contour: Point2D[];
  bounds: RectBounds;
  colophonBounds: RectBounds;
}

export interface ApertureWindow {
  id: string;
  edge: CanonicalEdge;
  targetNode: CanonicalNode;
  anchorText: string;
  isFrontier: boolean;
  /** 0.18 hairline slit for frontier, 0.65+ open recessed portal for visited/hovered */
  openness: number;
  bounds: RectBounds;
  polygon: Point2D[];
  previewLines: string[];
}

export interface ApertureStrataOptions {
  focusNodeId?: string | null;
  hoveredTargetId?: string | null;
  opennessOverrides?: ReadonlyMap<string, number>;
  maxStrataRings?: number;
  maxApertures?: number;
}

export interface ApertureStrataResult {
  activeSheet: ActiveSheetGeometry;
  strata: StratumLayer[];
  apertures: ApertureWindow[];
}

/**
 * Deterministic multi-octave signed noise in [-1, 1] for deckled / torn paper contours.
 * Zero `Math.random()`.
 */
function deckleNoise(seedHash: number, t: number): number {
  const s1 = Math.sin(t * Math.PI * 6 + (seedHash % 97) * 0.13);
  const s2 = Math.sin(t * Math.PI * 14 + ((seedHash >> 4) % 89) * 0.29) * 0.52;
  const s3 = Math.cos(t * Math.PI * 31 + ((seedHash >> 9) % 71) * 0.41) * 0.26;
  return (s1 + s2 + s3) / 1.78;
}

/**
 * Builds a closed torn rectangular contour around `[left, top, right, bottom]`
 * with deterministic deckled edge teeth of amplitude `deckleAmp`.
 */
export function buildDeckledRectPolygon(
  left: number,
  top: number,
  right: number,
  bottom: number,
  seedKey: string,
  deckleAmp = 5.5,
  samplesPerSide = 14,
): Point2D[] {
  const h = hashString(seedKey);
  const pts: Point2D[] = [];

  // Top edge: left -> right
  for (let i = 0; i < samplesPerSide; i++) {
    const u = i / samplesPerSide;
    const x = left + (right - left) * u;
    const jitter = i === 0 ? 0 : deckleNoise(h, u) * deckleAmp;
    pts.push({ x, y: top + jitter });
  }
  // Right edge: top -> bottom
  for (let i = 0; i < samplesPerSide; i++) {
    const u = i / samplesPerSide;
    const y = top + (bottom - top) * u;
    const jitter = i === 0 ? 0 : deckleNoise(h ^ 0x9e37, u + 0.25) * deckleAmp;
    pts.push({ x: right + jitter, y });
  }
  // Bottom edge: right -> left
  for (let i = 0; i < samplesPerSide; i++) {
    const u = i / samplesPerSide;
    const x = right - (right - left) * u;
    const jitter = i === 0 ? 0 : deckleNoise(h ^ 0x517c, u + 0.5) * deckleAmp;
    pts.push({ x, y: bottom + jitter });
  }
  // Left edge: bottom -> top
  for (let i = 0; i < samplesPerSide; i++) {
    const u = i / samplesPerSide;
    const y = bottom - (bottom - top) * u;
    const jitter = i === 0 ? 0 : deckleNoise(h ^ 0x27d4, u + 0.75) * deckleAmp;
    pts.push({ x: left + jitter, y });
  }

  return pts;
}

/**
 * Builds an organic surgical / torn cut-out aperture polygon inside `slotBounds`
 * whose vertical lip separation scales smoothly with `openness` in `[0.08, 1.0]`.
 */
export function buildSurgicalAperturePolygon(
  slotBounds: RectBounds,
  openness: number,
  seedKey: string,
): Point2D[] {
  const h = hashString(seedKey);
  const clampedOpen = Math.max(0.08, Math.min(1, openness));
  const cy = slotBounds.y + slotBounds.height * 0.56;
  const maxHalfH = slotBounds.height * 0.42;
  const halfGap = Math.max(2.6, maxHalfH * clampedOpen);

  const x0 = slotBounds.x + 4;
  const x1 = slotBounds.x + slotBounds.width - 4;
  const spanW = Math.max(24, x1 - x0);
  const steps = 16;

  const upperLip: Point2D[] = [];
  const lowerLip: Point2D[] = [];

  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const x = x0 + spanW * u;
    // Taper smoothly to pinched surgical corners at u = 0 and u = 1
    const envelope = Math.sin(u * Math.PI) ** 0.58;
    const tearUpper = deckleNoise(h, u) * (2.2 + clampedOpen * 4.2) * envelope;
    const tearLower = deckleNoise(h ^ 0x7f4a, u + 0.37) * (2.2 + clampedOpen * 4.2) * envelope;

    upperLip.push({
      x,
      y: cy - halfGap * envelope + tearUpper,
    });
    lowerLip.push({
      x,
      y: cy + halfGap * envelope + tearLower,
    });
  }

  const poly: Point2D[] = [...upperLip];
  for (let i = lowerLip.length - 1; i >= 0; i--) {
    poly.push(lowerLip[i]!);
  }
  return poly;
}

export function isPointInPolygon(px: number, py: number, poly: readonly Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function selectActiveNode(
  snapshot: Pick<CrawlSnapshot, 'nodes' | 'nodeMap' | 'activeNodeId'>,
  focusNodeId?: string | null,
): CanonicalNode | null {
  if (focusNodeId && snapshot.nodeMap.has(focusNodeId)) {
    return snapshot.nodeMap.get(focusNodeId)!;
  }
  if (snapshot.activeNodeId && snapshot.nodeMap.has(snapshot.activeNodeId)) {
    return snapshot.nodeMap.get(snapshot.activeNodeId)!;
  }
  // Latest visited or tail-seed node, else query-root
  for (let i = snapshot.nodes.length - 1; i >= 0; i--) {
    const n = snapshot.nodes[i]!;
    if (n.state === 'visited' || n.state === 'tail-seed') return n;
  }
  return snapshot.nodes[0] ?? null;
}

/**
 * Gordon Matta-Clark Torn Strata & Cut-Out Portal Spatial Solver:
 * - Ancestors of the active sheet frame the viewport perimeter as deckled `StratumLayer[]`.
 * - Outgoing & counterfactual hyperlinks pierce the central sheet as `ApertureWindow[]` portals.
 */
export function computeApertureStrata(
  snapshot: Pick<CrawlSnapshot, 'nodes' | 'nodeMap' | 'edges' | 'activeNodeId'>,
  viewport: { width: number; height: number },
  options: ApertureStrataOptions = {},
): ApertureStrataResult {
  const width = Math.max(240, viewport.width);
  const height = Math.max(200, viewport.height);

  const fallbackNode: CanonicalNode = {
    id: 'empty-sheet',
    url: 'query://unseen',
    domain: 'reverse-index.local',
    path: '/',
    parentId: null,
    depth: 0,
    state: 'query-root',
    branchId: 'trunk',
    discoveredAt: 0,
  };

  const activeNode = selectActiveNode(snapshot, options.focusNodeId) ?? fallbackNode;

  // 1. Trace ancestor chain from query-root down to activeNode.parentId
  const ancestors: CanonicalNode[] = [];
  const visitedGuard = new Set<string>([activeNode.id]);
  let cursorParentId = activeNode.parentId;
  while (cursorParentId && !visitedGuard.has(cursorParentId)) {
    visitedGuard.add(cursorParentId);
    const parent = snapshot.nodeMap.get(cursorParentId);
    if (!parent) break;
    ancestors.unshift(parent);
    cursorParentId = parent.parentId;
  }

  const maxRings = options.maxStrataRings ?? 6;
  const visibleAncestors =
    ancestors.length > maxRings ? ancestors.slice(ancestors.length - maxRings) : ancestors;

  // 2. Build concentric torn paper strata framing the viewport perimeter
  const viewportRect: Point2D[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];

  const ringCount = visibleAncestors.length;
  const maxTotalMarginX = Math.min(width * 0.22, 190);
  const maxTotalMarginY = Math.min(height * 0.22, 150);
  const stepX = ringCount > 0 ? Math.min(34, maxTotalMarginX / ringCount) : 0;
  const stepY = ringCount > 0 ? Math.min(28, maxTotalMarginY / ringCount) : 0;

  const strata: StratumLayer[] = [];
  let currentOuter = viewportRect;
  let insetLeft = 14;
  let insetTop = 14;
  let insetRight = width - 14;
  let insetBottom = height - 14;

  for (let i = 0; i < ringCount; i++) {
    const anc = visibleAncestors[i]!;
    const h = hashString(anc.id);
    // Asymmetric archival tear offsets so strata look hand-excavated rather than machine concentric boxes
    const asymL = stepX * (0.85 + ((h % 30) / 100));
    const asymR = stepX * (0.85 + (((h >> 4) % 30) / 100));
    const asymT = stepY * (0.88 + (((h >> 8) % 26) / 100));
    const asymB = stepY * (0.85 + (((h >> 12) % 26) / 100));

    insetLeft += asymL;
    insetRight -= asymR;
    insetTop += asymT;
    insetBottom -= asymB;

    const innerCutout = buildDeckledRectPolygon(
      insetLeft,
      insetTop,
      insetRight,
      insetBottom,
      `stratum::${anc.id}::${i}`,
      4.8,
      16,
    );

    const rankTag = anc.reverseRank ? `#${anc.reverseRank} · ` : '';
    const titleShort = getNodeDisplayLabel(anc).slice(0, 44);
    const edgeLabel = `${rankTag}${titleShort}  [d${anc.depth} · ${anc.domain}]`;

    // Alternate rim label placement along top/bottom/left torn margins so consecutive strata labels never collide
    const side = i % 2 === 0 ? 'top' : 'bottom';
    const rimAnchorPoint =
      side === 'top'
        ? { x: insetLeft + 14, y: insetTop - asymT * 0.52 }
        : { x: insetLeft + 18, y: insetBottom + asymB * 0.56 };

    strata.push({
      node: anc,
      depth: anc.depth,
      outerContour: currentOuter,
      innerCutout,
      edgeLabel,
      rimAnchorPoint,
      rimAngle: 0,
    });

    currentOuter = innerCutout;
  }

  // 3. Central Active Sheet Geometry
  const activeContour =
    ringCount > 0
      ? currentOuter
      : buildDeckledRectPolygon(18, 18, width - 18, height - 18, `sheet::${activeNode.id}`, 4.2, 18);

  const sheetPadX = Math.min(44, (insetRight - insetLeft) * 0.07);
  const sheetPadTop = 22;
  const colophonH = 42;

  const colophonBounds: RectBounds = {
    x: insetLeft + sheetPadX,
    y: insetTop + sheetPadTop,
    width: Math.max(120, insetRight - insetLeft - sheetPadX * 2),
    height: colophonH,
  };

  const contentBounds: RectBounds = {
    x: insetLeft + sheetPadX,
    y: colophonBounds.y + colophonH + 14,
    width: colophonBounds.width,
    height: Math.max(90, insetBottom - (colophonBounds.y + colophonH + 30)),
  };

  // 4. Outgoing & Counterfactual Hyperlink Apertures inside Active Sheet
  let candidateEdges = snapshot.edges.filter((e) => e.source === activeNode.id);

  // If the active sheet is a terminal leaf or dead ruin, surface sibling counterfactual frontiers
  // from its parent so the viewer can always tear open unvisited counterfactual paths diegetically.
  if (candidateEdges.length === 0 && activeNode.parentId) {
    candidateEdges = snapshot.edges.filter(
      (e) => e.source === activeNode.parentId && e.target !== activeNode.id,
    );
  }

  // Sort: traversed portals first, then counterfactual frontier slits in deterministic order
  const sortedEdges = [...candidateEdges].sort((a, b) => {
    if (a.traversed !== b.traversed) return a.traversed ? -1 : 1;
    return a.order - b.order;
  });

  const maxApertures = options.maxApertures ?? 8;
  const chosenEdges = sortedEdges.slice(0, maxApertures);

  // Reserve top ~34% of contentBounds for the sheet's own lead typography & prose,
  // and lay out non-overlapping surgical apertures across the lower ~66% in 1 or 2 editorial columns!
  const proseHeaderRatio = chosenEdges.length > 4 ? 0.28 : 0.34;
  const apertureRegionY = contentBounds.y + contentBounds.height * proseHeaderRatio;
  const apertureRegionH = Math.max(72, contentBounds.height * (1 - proseHeaderRatio));

  const cols = contentBounds.width >= 560 && chosenEdges.length >= 3 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(chosenEdges.length / cols));
  const gapX = 22;
  const gapY = 12;
  const cellW = (contentBounds.width - gapX * (cols - 1)) / cols;
  const cellH = Math.min(118, Math.max(46, (apertureRegionH - gapY * (rows - 1)) / rows));

  const apertures: ApertureWindow[] = [];

  for (let idx = 0; idx < chosenEdges.length; idx++) {
    const edge = chosenEdges[idx]!;
    const targetNode = snapshot.nodeMap.get(edge.target);
    if (!targetNode) continue;

    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const slotBounds: RectBounds = {
      x: contentBounds.x + col * (cellW + gapX),
      y: apertureRegionY + row * (cellH + gapY),
      width: cellW,
      height: cellH,
    };

    const isFrontier = targetNode.state === 'frontier';
    const isHovered = options.hoveredTargetId === targetNode.id;
    const customOpen = options.opennessOverrides?.get(targetNode.id);

    const baseOpenness = isFrontier ? 0.18 : 0.68;
    const openness =
      customOpen !== undefined
        ? customOpen
        : isHovered
          ? Math.max(baseOpenness, 0.88)
          : baseOpenness;

    const polygon = buildSurgicalAperturePolygon(
      slotBounds,
      openness,
      `aperture::${edge.id}::${targetNode.id}`,
    );

    const anchorText =
      edge.anchorText ??
      targetNode.content?.anchorText ??
      (isFrontier ? `미답사 고리 → ${targetNode.domain}` : getNodeDisplayLabel(targetNode));

    const rankPrefix = targetNode.reverseRank ? `#${targetNode.reverseRank} · ` : '';
    const previewLines = [
      `${rankPrefix}${targetNode.domain}${targetNode.path.slice(0, 28)}`,
      getNodeDisplayLabel(targetNode),
      targetNode.content?.snippet ??
        (isFrontier
          ? '절개 틈새 너머 보존된 반사실적 페이지 — 클릭하여 분기 확장'
          : `HTTP ${targetNode.httpStatus ?? 200} · 심층 페이지로 진입`),
    ];

    apertures.push({
      id: `ap-${edge.id}`,
      edge,
      targetNode,
      anchorText,
      isFrontier,
      openness,
      bounds: slotBounds,
      polygon,
      previewLines,
    });
  }

  return {
    activeSheet: {
      node: activeNode,
      contour: activeContour,
      bounds: contentBounds,
      colophonBounds,
    },
    strata,
    apertures,
  };
}
