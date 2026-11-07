import { CrawlSession } from '@akl/graph-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  computeApertureStrata,
  computePalimpsestLayout,
  computePowerTessellation,
  isPointInPolygon,
  parseLabUrlState,
} from '../index.ts';

describe('@akl/lab-kit post-diagrammatic spatial solvers', () => {
  it('supports ?lab=1 alongside ?debug=1 in parseLabUrlState', () => {
    expect(parseLabUrlState('?q=test&lab=1').debug).toBe(true);
    expect(parseLabUrlState('?q=test&debug=1').debug).toBe(true);
    expect(parseLabUrlState('?q=test').debug).toBe(false);
  });

  it('computes exact, gapless Laguerre Power Tessellation polygons and shared hyperlink seams', async () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');

    const session = new CrawlSession();
    const snap = await session.startRun({
      query: '소백산 단파 관측',
      seed: 4201,
      topology: 'rhizome-drift',
      persona: 'ko-periphery',
      immediate: true,
    });

    const viewport = { width: 1200, height: 800 };
    const resA = computePowerTessellation(snap, viewport);
    const resB = computePowerTessellation(snap, viewport);

    // Strictly deterministic with zero Math.random()
    expect(mathRandomSpy).not.toHaveBeenCalled();
    expect(resA.cells).toEqual(resB.cells);
    expect(resA.seams).toEqual(resB.seams);

    // Every node receives a non-empty convex polygon with positive area and positive inradius
    expect(resA.cells).toHaveLength(snap.nodes.length);
    for (const cell of resA.cells) {
      expect(cell.polygon.length).toBeGreaterThanOrEqual(3);
      expect(cell.area).toBeGreaterThan(10);
      expect(cell.inradius).toBeGreaterThan(1);
    }

    // Total area across all Laguerre polygons equals 100% of viewport (1200 * 800 = 960,000)
    const totalArea = resA.cells.reduce((sum, c) => sum + c.area, 0);
    expect(Math.abs(totalArea - viewport.width * viewport.height)).toBeLessThan(1);

    // Linked graph nodes form shared geometric seams carrying hyperlink metadata
    const hyperlinkSeams = resA.seams.filter((s) => s.isHyperlink);
    expect(hyperlinkSeams.length).toBeGreaterThan(5);
    expect(hyperlinkSeams.some((s) => s.traversed)).toBe(true);
    expect(hyperlinkSeams.some((s) => !s.traversed)).toBe(true);

    // Boosting a cell's Laguerre weight swells its territorial area monotonically
    const targetId = snap.nodes[1]!.id;
    const baseCell = resA.cells.find((c) => c.nodeId === targetId)!;
    const swollen = computePowerTessellation(snap, viewport, {
      previousSites: resA.sites,
      relaxationIterations: 0,
      weightOverrides: new Map([[targetId, 12_000]]),
    });
    const swollenCell = swollen.cells.find((c) => c.nodeId === targetId)!;
    expect(swollenCell.area).toBeGreaterThan(baseCell.area);

    mathRandomSpy.mockRestore();
  });

  it('computes Gordon Matta-Clark torn strata rings and surgical cut-out apertures', async () => {
    const session = new CrawlSession();
    const snap = await session.startRun({
      query: '절개된 기록층',
      seed: 7711,
      topology: 'rhizome-drift',
      persona: 'ko-periphery',
      immediate: true,
    });

    // Focus a depth-2 visited node so it has 2 ancestor strata (query-root -> tail-seed) and outgoing links
    const depth2Visited = snap.nodes.find((n) => n.state === 'visited' && n.depth === 2)!;
    expect(depth2Visited).toBeDefined();

    const strataRes = computeApertureStrata(
      snap,
      { width: 1280, height: 820 },
      { focusNodeId: depth2Visited.id },
    );

    expect(strataRes.activeSheet.node.id).toBe(depth2Visited.id);
    expect(strataRes.strata).toHaveLength(2);
    expect(strataRes.strata[0]!.node.state).toBe('query-root');
    expect(strataRes.strata[1]!.node.state).toBe('tail-seed');

    // Center of viewport lies inside the innermost cutout (active sheet)
    expect(isPointInPolygon(640, 410, strataRes.strata[1]!.innerCutout)).toBe(true);

    // Apertures include both open visited portals (>= 0.65) and hairline frontier slits (~0.18)
    expect(strataRes.apertures.length).toBeGreaterThan(0);
    const frontierAp = strataRes.apertures.find((a) => a.isFrontier);
    const visitedAp = strataRes.apertures.find((a) => !a.isFrontier);
    expect(frontierAp).toBeDefined();
    expect(frontierAp!.openness).toBeCloseTo(0.18, 2);
    if (visitedAp) {
      expect(visitedAp.openness).toBeGreaterThanOrEqual(0.65);
    }

    // Hovering a frontier slit parts the paper lips wide open
    const hoveredRes = computeApertureStrata(
      snap,
      { width: 1280, height: 820 },
      { focusNodeId: depth2Visited.id, hoveredTargetId: frontierAp!.targetNode.id },
    );
    const hoveredFrontierAp = hoveredRes.apertures.find(
      (a) => a.targetNode.id === frontierAp!.targetNode.id,
    )!;
    expect(hoveredFrontierAp.openness).toBeGreaterThan(0.8);
  });

  it('computes zero-shape palimpsest typographic blocks, overprint splices, and frontier marginalia', async () => {
    const session = new CrawlSession();
    const snap = await session.startRun({
      query: '겹쳐 찍힌 활자',
      seed: 1999,
      topology: 'rhizome-drift',
      persona: 'ko-periphery',
      immediate: true,
    });

    const palimpsest = computePalimpsestLayout(snap, { width: 1200, height: 900 });
    expect(palimpsest.blocks.length).toBeGreaterThan(5);
    expect(palimpsest.splices.length).toBeGreaterThan(4);
    expect(palimpsest.marginalia.length).toBeGreaterThan(5);

    for (const block of palimpsest.blocks) {
      expect(block.lines.length).toBeGreaterThan(0);
    }
  });
});
