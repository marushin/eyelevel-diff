import { type CanonicalEdge, type CanonicalNode, hashString } from '@akl/graph-contract';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  type ForceLinkDatum,
  type ForceNodeDatum,
  type Simulation,
} from 'd3-force-3d';
import type { ELK, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';

export type LayoutMode = 'force-2d' | 'force-3d' | 'elk-layered' | 'elk-mrtree' | 'elk-radial';

export interface LayoutNodeInput {
  id: string;
  parentId: string | null;
  depth: number;
  state: CanonicalNode['state'];
  branchId: string;
  collisionRadius?: number;
  width?: number;
  height?: number;
}

export interface LayoutEdgeInput {
  id: string;
  source: string;
  target: string;
  kind: CanonicalEdge['kind'];
  traversed: boolean;
}

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface LayoutResultPayload {
  requestId: number;
  mode: LayoutMode;
  positions: PositionedNode[];
  /** Present in ELK modes: routed polyline points (start -> bends -> end) per edge ID */
  edgeRoutes: Record<string, Point2D[]>;
}

export interface LayoutComputeRequest {
  type: 'COMPUTE_LAYOUT';
  requestId: number;
  mode: LayoutMode;
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  ringSpacing?: number;
  reset?: boolean;
}

interface InternalSimNode extends ForceNodeDatum {
  id: string;
  parentId: string | null;
  depth: number;
  state: CanonicalNode['state'];
  branchId: string;
  collisionRadius: number;
  x: number;
  y: number;
  z: number;
}

interface InternalSimLink extends ForceLinkDatum<InternalSimNode> {
  id: string;
  traversed: boolean;
  kind: CanonicalEdge['kind'];
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Stateful layout engine usable both inside `layout-worker.ts` and directly in Node/Vitest.
 */
export class GraphLayoutEngine {
  private readonly simNodes = new Map<string, InternalSimNode>();
  private simulation: Simulation<InternalSimNode> | null = null;
  private currentDim: 2 | 3 = 2;
  private elkInstance: ELK | null = null;

  private async getElk(): Promise<ELK> {
    if (this.elkInstance) return this.elkInstance;
    const mod = await import('elkjs/lib/elk.bundled.js');
    const ElkCtor = mod.default;
    this.elkInstance = new ElkCtor();
    return this.elkInstance;
  }

  reset(): void {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    this.simNodes.clear();
  }

  async compute(req: LayoutComputeRequest): Promise<LayoutResultPayload> {
    if (req.reset) {
      this.reset();
    }

    if (req.mode === 'elk-layered' || req.mode === 'elk-mrtree' || req.mode === 'elk-radial') {
      return this.computeElk(req);
    }

    return this.computeForce(req);
  }

  private computeForce(req: LayoutComputeRequest): LayoutResultPayload {
    const dim: 2 | 3 = req.mode === 'force-3d' ? 3 : 2;
    const ringSpacing = req.ringSpacing ?? 145;

    if (this.simulation && this.currentDim !== dim) {
      this.simulation.stop();
      this.simulation = null;
    }
    this.currentDim = dim;

    const incomingIds = new Set(req.nodes.map((n) => n.id));
    for (const existingId of this.simNodes.keys()) {
      if (!incomingIds.has(existingId)) {
        this.simNodes.delete(existingId);
      }
    }

    let addedCount = 0;
    const orderedNodes: InternalSimNode[] = [];

    for (let idx = 0; idx < req.nodes.length; idx++) {
      const input = req.nodes[idx]!;
      const existing = this.simNodes.get(input.id);
      if (existing) {
        existing.depth = input.depth;
        existing.state = input.state;
        existing.branchId = input.branchId;
        existing.collisionRadius = input.collisionRadius ?? 28;
        if (input.depth === 0) {
          existing.fx = 0;
          existing.fy = 0;
          existing.fz = 0;
        }
        orderedNodes.push(existing);
        continue;
      }

      addedCount += 1;
      const hash = hashString(input.id);
      const angle = (hash % 3600) * (Math.PI / 1800) + idx * GOLDEN_ANGLE;
      const parent = input.parentId ? this.simNodes.get(input.parentId) : undefined;

      let x = 0;
      let y = 0;
      let z = 0;

      if (input.depth === 0) {
        x = 0;
        y = 0;
        z = 0;
      } else if (parent) {
        // Spawn at parent.(x,y,z) + deterministic micro-offset directed outward so hops never explode!
        const parentLen = Math.hypot(parent.x, parent.y) || 1;
        const outwardX = parent.depth === 0 ? Math.cos(angle) : parent.x / parentLen;
        const outwardY = parent.depth === 0 ? Math.sin(angle) : parent.y / parentLen;
        const jitterAngle = ((hash % 100) / 100 - 0.5) * 1.15;
        const cosJ = Math.cos(jitterAngle);
        const sinJ = Math.sin(jitterAngle);
        const dirX = outwardX * cosJ - outwardY * sinJ;
        const dirY = outwardX * sinJ + outwardY * cosJ;
        const microStep = 36 + (hash % 22);

        x = parent.x + dirX * microStep;
        y = parent.y + dirY * microStep;
        z = dim === 3 ? parent.z + (((hash >> 8) % 40) - 20) : 0;
      } else {
        const r = input.depth * ringSpacing * 0.85;
        x = Math.cos(angle) * r;
        y = Math.sin(angle) * r;
        z = dim === 3 ? (((hash >> 6) % 120) - 60) : 0;
      }

      const created: InternalSimNode = {
        id: input.id,
        parentId: input.parentId,
        depth: input.depth,
        state: input.state,
        branchId: input.branchId,
        collisionRadius: input.collisionRadius ?? 28,
        x,
        y,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        ...(input.depth === 0 ? { fx: 0, fy: 0, fz: 0 } : {}),
      };

      this.simNodes.set(input.id, created);
      orderedNodes.push(created);
    }

    const validIds = new Set(orderedNodes.map((n) => n.id));
    const links: InternalSimLink[] = req.edges
      .filter((e) => validIds.has(e.source) && validIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        traversed: e.traversed,
        kind: e.kind,
      }));

    if (!this.simulation) {
      this.simulation = forceSimulation<InternalSimNode>(orderedNodes, dim)
        .stop()
        .velocityDecay(0.58);
    } else {
      this.simulation.nodes(orderedNodes);
    }

    const linkForce = forceLink<InternalSimNode, InternalSimLink>(links)
      .id((d) => d.id)
      .distance((l) => {
        if (l.kind === 'tail-inversion') return ringSpacing * 0.95;
        if (!l.traversed) return ringSpacing * 0.62;
        return ringSpacing * 0.78;
      })
      .strength((l) => (l.kind === 'cycle-backlink' ? 0.08 : l.traversed ? 0.68 : 0.42));

    const chargeForce = forceManyBody<InternalSimNode>()
      .strength((d) => (d.depth === 0 ? -360 : d.state === 'frontier' ? -135 : -240))
      .distanceMax(ringSpacing * 4.5);

    const collideForce = forceCollide<InternalSimNode>((d) => d.collisionRadius)
      .strength(0.82)
      .iterations(2);

    const radialForce = forceRadial<InternalSimNode>(
      (d) => (d.depth === 0 ? 0 : d.depth * ringSpacing),
      0,
      0,
      0,
    ).strength((d) => (d.depth === 0 ? 1 : 0.34));

    this.simulation
      .force('link', linkForce)
      .force('charge', chargeForce)
      .force('collide', collideForce)
      .force('radial', radialForce);

    // Gentle incremental settle: warm with alphaTarget(0.18), then cool down smoothly to 0
    const isInitialBurst = addedCount === orderedNodes.length;
    const warmTicks = isInitialBurst ? 42 : Math.min(24, 8 + addedCount * 2);
    const coolTicks = isInitialBurst ? 38 : 18;

    this.simulation.alpha(isInitialBurst ? 0.55 : 0.24).alphaTarget(0.18);
    this.simulation.tick(warmTicks);
    this.simulation.alphaTarget(0);
    this.simulation.tick(coolTicks);

    const positions: PositionedNode[] = orderedNodes.map((n) => ({
      id: n.id,
      x: Math.round(n.x * 100) / 100,
      y: Math.round(n.y * 100) / 100,
      z: dim === 3 ? Math.round(n.z * 100) / 100 : 0,
    }));

    return {
      requestId: req.requestId,
      mode: req.mode,
      positions,
      edgeRoutes: {},
    };
  }

  private async computeElk(req: LayoutComputeRequest): Promise<LayoutResultPayload> {
    if (req.nodes.length === 0) {
      return { requestId: req.requestId, mode: req.mode, positions: [], edgeRoutes: {} };
    }

    const algorithm =
      req.mode === 'elk-mrtree'
        ? 'mrtree'
        : req.mode === 'elk-radial'
          ? 'radial'
          : 'layered';

    const nodeSet = new Set(req.nodes.map((n) => n.id));
    const nodeDims = new Map<string, { w: number; h: number }>();

    const elkChildren: ElkNode[] = req.nodes.map((n) => {
      const w = n.width ?? (n.state === 'frontier' ? 128 : 156);
      const h = n.height ?? (n.state === 'frontier' ? 40 : 50);
      nodeDims.set(n.id, { w, h });
      return {
        id: n.id,
        width: w,
        height: h,
      };
    });

    // Exclude pure cycle backlinks in radial/mrtree so tree algorithms stay acyclic; layered handles cycles natively
    const elkEdges: ElkExtendedEdge[] = req.edges
      .filter((e) => {
        if (!nodeSet.has(e.source) || !nodeSet.has(e.target) || e.source === e.target) {
          return false;
        }
        if (algorithm !== 'layered' && e.kind === 'cycle-backlink') {
          return false;
        }
        return true;
      })
      .map((e) => ({
        id: e.id,
        sources: [e.source],
        targets: [e.target],
      }));

    const rootGraph: ElkNode = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': algorithm,
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': algorithm === 'layered' ? 'ORTHOGONAL' : 'POLYLINE',
        'elk.spacing.nodeNode': '42',
        'elk.layered.spacing.nodeNodeBetweenLayers': '118',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      },
      children: elkChildren,
      edges: elkEdges,
    };

    const elk = await this.getElk();
    const laidOut = await elk.layout(rootGraph);
    const children = laidOut.children ?? [];

    // Anchor coordinate origin at query-root center so camera alignment stays coherent
    let originX = 0;
    let originY = 0;
    const rootChild = children.find((c) => c.id === 'node-root') ?? children[0];
    if (rootChild) {
      originX = (rootChild.x ?? 0) + (rootChild.width ?? 0) * 0.5;
      originY = (rootChild.y ?? 0) + (rootChild.height ?? 0) * 0.5;
    }

    const positions: PositionedNode[] = children.map((c) => {
      const cx = (c.x ?? 0) + (c.width ?? 0) * 0.5 - originX;
      const cy = (c.y ?? 0) + (c.height ?? 0) * 0.5 - originY;
      return {
        id: c.id,
        x: Math.round(cx * 100) / 100,
        y: Math.round(cy * 100) / 100,
        z: 0,
      };
    });

    const edgeRoutes: Record<string, Point2D[]> = {};
    for (const edge of laidOut.edges ?? []) {
      const section = edge.sections?.[0];
      if (!section) continue;
      const pts: Point2D[] = [
        {
          x: Math.round((section.startPoint.x - originX) * 100) / 100,
          y: Math.round((section.startPoint.y - originY) * 100) / 100,
        },
      ];
      for (const bp of section.bendPoints ?? []) {
        pts.push({
          x: Math.round((bp.x - originX) * 100) / 100,
          y: Math.round((bp.y - originY) * 100) / 100,
        });
      }
      pts.push({
        x: Math.round((section.endPoint.x - originX) * 100) / 100,
        y: Math.round((section.endPoint.y - originY) * 100) / 100,
      });
      edgeRoutes[edge.id] = pts;
    }

    return {
      requestId: req.requestId,
      mode: req.mode,
      positions,
      edgeRoutes,
    };
  }
}
