import {
  type CanonicalNode,
  type CrawlSnapshot,
  getNodeDisplayLabel,
  hashString,
} from '@akl/graph-contract';
import type { RectBounds } from './portals.ts';
import { measureTextBlock } from './text-measure.ts';

export interface PalimpsestGlyphLine {
  text: string;
  x: number;
  y: number;
  width: number;
}

export interface PalimpsestBlock {
  nodeId: string;
  node: CanonicalNode;
  depth: number;
  branchId: string;
  bounds: RectBounds;
  lines: PalimpsestGlyphLine[];
}

export interface PalimpsestSplice {
  id: string;
  edgeId: string;
  parentBlockId: string;
  childBlockId: string;
  anchorText: string;
  overlapBounds: RectBounds;
  glyphLines: PalimpsestGlyphLine[];
  blendWeight: number;
}

export interface PalimpsestMarginalia {
  nodeId: string;
  parentNodeId: string | null;
  node: CanonicalNode;
  anchorText: string;
  bounds: RectBounds;
  lines: PalimpsestGlyphLine[];
  opacity: number;
}

export interface PalimpsestLayoutOptions {
  font?: string;
  lineHeight?: number;
  columnWidth?: number;
}

export interface PalimpsestLayoutResult {
  blocks: PalimpsestBlock[];
  splices: PalimpsestSplice[];
  marginalia: PalimpsestMarginalia[];
}

const DEFAULT_PALIMPSEST_FONT =
  '400 13.5px "Iowan Old Style", "AppleMyungjo", Georgia, "Noto Serif KR", serif';

function rectsOverlap(a: RectBounds, b: RectBounds, padX = 10, padY = 8): boolean {
  return !(
    a.x + a.width + padX < b.x ||
    b.x + b.width + padX < a.x ||
    a.y + a.height + padY < b.y ||
    b.y + b.height + padY < a.y
  );
}

/**
 * Zero-shape typographic layout solver (`Node = Pure Typographic Mass`, `Edge = Overprint Splice`):
 * - Visited & tail-seed nodes become borderless Mallarméan / Talmudic chorus blocks (`blocks`),
 *   with awakened counterfactual branches unfolding in parallel side-by-side chorus columns.
 * - Hyperlinks become rubricated overprint `splices` bridging parent tails directly onto child leads.
 * - Counterfactual `frontier` candidates hover in surrounding outer & interlinear margins as non-overlapping `marginalia`.
 */
export function computePalimpsestLayout(
  snapshot: Pick<CrawlSnapshot, 'nodes' | 'edges'>,
  viewport: { width: number; height: number },
  options: PalimpsestLayoutOptions = {},
): PalimpsestLayoutResult {
  const width = Math.max(420, viewport.width);
  const height = Math.max(300, viewport.height);
  const font = options.font ?? DEFAULT_PALIMPSEST_FONT;
  const lineHeight = options.lineHeight ?? 19;
  const colWidth = options.columnWidth ?? Math.min(300, Math.max(200, width * 0.25));

  const primaryNodes = snapshot.nodes.filter((n) => n.state !== 'frontier');
  const frontierNodes = snapshot.nodes.filter((n) => n.state === 'frontier');

  // Discover ordered branch voices ('trunk', 'branch-1', 'branch-2', ...)
  const branchOrder: string[] = [];
  for (const n of primaryNodes) {
    if (!branchOrder.includes(n.branchId)) {
      branchOrder.push(n.branchId);
    }
  }

  const blocks: PalimpsestBlock[] = [];
  const blockMap = new Map<string, PalimpsestBlock>();
  const occupiedRects: RectBounds[] = [];

  const baseLeft = Math.max(96, width * 0.14);
  const initialTopY = Math.min(112, Math.max(84, Math.round(height * 0.12)));
  const columnStride = colWidth + 116;
  const branchCursorY = new Map<string, number>();

  for (let idx = 0; idx < primaryNodes.length; idx++) {
    const node = primaryNodes[idx]!;
    const h = hashString(node.id);
    const title = getNodeDisplayLabel(node);
    const body = node.content?.snippet
      ? `${title} — ${node.content.snippet}`
      : `${title} · ${node.domain}${node.path}`;

    const measured = measureTextBlock(body, {
      font,
      maxWidth: colWidth,
      lineHeight,
      maxLines: 5,
      padding: 0,
    });

    const bIndex = Math.max(0, branchOrder.indexOf(node.branchId));
    const parentBlock = node.parentId ? blockMap.get(node.parentId) : undefined;

    // Mallarméan horizontal cadence: trunk drifts gently rightward with depth;
    // awakened counterfactual branches unfold as parallel chorus columns beside their anchor parent!
    let x: number;
    if (bIndex === 0) {
      const depthCadence = Math.min(4, node.depth) * 46;
      const verseShift = ((h % 54) - 27) * 0.9;
      x = baseLeft + depthCadence + verseShift;
    } else {
      const sideSign = bIndex % 2 === 1 ? 1 : -1;
      const tier = Math.ceil(bIndex / 2);
      const anchorX = parentBlock ? parentBlock.bounds.x : baseLeft + columnStride;
      const depthDrift = Math.max(0, node.depth - (parentBlock?.depth ?? 0)) * 28;
      x = anchorX + sideSign * tier * columnStride + sideSign * depthDrift;
    }

    let y = branchCursorY.get(node.branchId) ?? (parentBlock ? parentBlock.bounds.y + 24 : initialTopY);
    const blockW = Math.max(110, measured.width);
    const blockH = Math.max(lineHeight * 2, measured.height + 36);

    // Ensure chorus blocks never obliterate sibling blocks while preserving airy negative space
    let candidateBounds: RectBounds = { x, y, width: blockW, height: blockH };
    let guard = 0;
    while (occupiedRects.some((r) => rectsOverlap(candidateBounds, r, 18, 22)) && guard < 18) {
      y += lineHeight * 1.65;
      candidateBounds = { x, y, width: blockW, height: blockH };
      guard += 1;
    }

    const lines: PalimpsestGlyphLine[] = measured.lines.map((l, lineIdx) => ({
      text: l.text,
      x,
      y: y + 36 + lineIdx * lineHeight,
      width: l.width,
    }));

    const block: PalimpsestBlock = {
      nodeId: node.id,
      node,
      depth: node.depth,
      branchId: node.branchId,
      bounds: candidateBounds,
      lines,
    };

    blocks.push(block);
    blockMap.set(node.id, block);
    occupiedRects.push(candidateBounds);
    branchCursorY.set(node.branchId, y + blockH + 42);
  }

  // Rubricated Overprint Splices (zero lines: parent anchor phrase bridges directly onto child opening words)
  const splices: PalimpsestSplice[] = [];
  for (const edge of snapshot.edges) {
    if (!edge.traversed) continue;
    const parentBlock = blockMap.get(edge.source);
    const childBlock = blockMap.get(edge.target);
    if (!parentBlock || !childBlock) continue;

    const anchorText =
      edge.anchorText ??
      childBlock.node.content?.anchorText ??
      getNodeDisplayLabel(childBlock.node).slice(0, 28);

    const measuredSplice = measureTextBlock(anchorText, {
      font,
      maxWidth: colWidth * 0.85,
      lineHeight,
      maxLines: 2,
      padding: 0,
    });

    const parentTailY = parentBlock.bounds.y + Math.max(lineHeight, parentBlock.bounds.height - lineHeight * 0.75);
    const childLeadY = childBlock.bounds.y + 16;
    const spliceX = (parentBlock.bounds.x + childBlock.bounds.x) * 0.5;
    const spliceY = (parentTailY + childLeadY) * 0.5;

    const glyphLines: PalimpsestGlyphLine[] = measuredSplice.lines.map((l, i) => ({
      text: l.text,
      x: spliceX,
      y: spliceY + i * lineHeight,
      width: l.width,
    }));

    splices.push({
      id: `splice-${edge.id}`,
      edgeId: edge.id,
      parentBlockId: parentBlock.nodeId,
      childBlockId: childBlock.nodeId,
      anchorText,
      overlapBounds: {
        x: Math.min(parentBlock.bounds.x, childBlock.bounds.x),
        y: Math.min(parentTailY, childLeadY),
        width: Math.max(
          64,
          Math.abs(childBlock.bounds.x - parentBlock.bounds.x) + measuredSplice.width,
        ),
        height: Math.max(lineHeight, Math.abs(childLeadY - parentTailY) + measuredSplice.height),
      },
      glyphLines,
      blendWeight: edge.kind === 'branch-awaken' ? 0.95 : 0.78,
    });
  }

  // Talmudic / Palimpsest Marginalia for unvisited counterfactual `frontier` nodes
  const marginalia: PalimpsestMarginalia[] = [];
  const marginWidth = Math.min(205, Math.max(145, width * 0.19));

  for (let i = 0; i < frontierNodes.length; i++) {
    const fNode = frontierNodes[i]!;
    const h = hashString(fNode.id);
    const parentBlock = fNode.parentId ? blockMap.get(fNode.parentId) : undefined;
    const anchorText = fNode.content?.anchorText ?? getNodeDisplayLabel(fNode);
    const glossText = `${anchorText} — ${getNodeDisplayLabel(fNode)}`;

    const measured = measureTextBlock(glossText, {
      font,
      maxWidth: marginWidth,
      lineHeight: lineHeight - 2,
      maxLines: 2,
      padding: 0,
    });

    // Place marginalia in left outer gloss, right outer gloss, or interlinear spaces around parent block
    const placeRight = (i + (h % 2)) % 2 === 0;
    const baseMx = parentBlock
      ? placeRight
        ? parentBlock.bounds.x + parentBlock.bounds.width + 38 + (h % 26)
        : parentBlock.bounds.x - marginWidth - 34 - (h % 24)
      : placeRight
        ? baseLeft + colWidth + 90
        : Math.max(18, baseLeft - marginWidth - 36);

    let mx = baseMx;
    let my = (parentBlock?.bounds.y ?? 108) + ((i % 4) - 0.5) * (lineHeight * 1.75);
    const mw = Math.max(64, measured.width);
    const mh = Math.max(lineHeight, measured.height + 14);

    let mBounds: RectBounds = { x: mx, y: my, width: mw, height: mh };
    let tries = 0;
    while (occupiedRects.some((r) => rectsOverlap(mBounds, r, 12, 10)) && tries < 16) {
      my += lineHeight * 1.45;
      if (tries === 8) {
        mx += placeRight ? 36 : -36;
      }
      mBounds = { x: mx, y: my, width: mw, height: mh };
      tries += 1;
    }

    const lines: PalimpsestGlyphLine[] = measured.lines.map((l, idx) => ({
      text: l.text,
      x: mx,
      y: my + 14 + idx * (lineHeight - 2),
      width: l.width,
    }));

    occupiedRects.push(mBounds);
    marginalia.push({
      nodeId: fNode.id,
      parentNodeId: fNode.parentId,
      node: fNode,
      anchorText,
      bounds: mBounds,
      lines,
      opacity: 0.36,
    });
  }

  return {
    blocks,
    splices,
    marginalia,
  };
}
