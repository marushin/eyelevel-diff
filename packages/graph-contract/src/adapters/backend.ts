import {
  type CanonicalEdge,
  type CanonicalNode,
  type CrawlEvent,
  type EdgeKind,
  type NodeState,
  type PersonaPreset,
  type TopologyPreset,
  type TransportPreset,
} from '../contract.ts';
import { type SimulatorOptions, streamSimulatedEvents } from '../simulator.ts';

export interface BackendConnectOptions extends SimulatorOptions {
  /** Optional REST JSON or NDJSON/SSE endpoint URL. If omitted, runs Seeded Simulator. */
  endpointUrl?: string;
  /** Automatically fall back to Seeded Simulator on network/HTTP failure (default: true). */
  fallbackToSimulator?: boolean;
  /** Custom fetch implementation (for testing or custom headers). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface LooseNodeRecord {
  id?: string;
  url?: string;
  href?: string;
  parentId?: string | null;
  depth?: number;
  reverseRank?: number;
  rank?: number;
  state?: NodeState;
  visited?: boolean;
  branchId?: string;
  httpStatus?: number;
  status?: number;
  latencyMs?: number;
  title?: string;
  snippet?: string;
  anchorText?: string;
  imageUrl?: string;
  content?: CanonicalNode['content'];
  judgement?: CanonicalNode['judgement'];
  children?: LooseNodeRecord[];
  links?: (string | LooseNodeRecord)[];
}

function parseUrlParts(rawUrl: string): { url: string; domain: string; path: string } {
  try {
    const parsed = new URL(rawUrl);
    return {
      url: parsed.href,
      domain: parsed.hostname || 'unknown.local',
      path: `${parsed.pathname}${parsed.search}${parsed.hash}` || '/',
    };
  } catch {
    const trimmed = rawUrl.trim() || 'https://unknown.local/';
    const withoutProto = trimmed.replace(/^[a-zA-Z]+:\/\//, '');
    const slashIdx = withoutProto.indexOf('/');
    if (slashIdx === -1) {
      return { url: `https://${withoutProto}/`, domain: withoutProto, path: '/' };
    }
    return {
      url: trimmed.includes('://') ? trimmed : `https://${trimmed}`,
      domain: withoutProto.slice(0, slashIdx) || 'unknown.local',
      path: withoutProto.slice(slashIdx) || '/',
    };
  }
}

function toCanonicalNode(
  raw: LooseNodeRecord | string,
  index: number,
  fallbackParentId: string | null = null,
  fallbackDepth = 1,
): CanonicalNode {
  if (typeof raw === 'string') {
    const parts = parseUrlParts(raw);
    return {
      id: `ext-node-${index}`,
      url: parts.url,
      domain: parts.domain,
      path: parts.path,
      parentId: fallbackParentId,
      depth: fallbackDepth,
      state: fallbackDepth === 1 ? 'tail-seed' : 'visited',
      branchId: 'trunk',
      discoveredAt: 1_762_000_000_000 + index * 50,
    };
  }

  const rawUrl = raw.url ?? raw.href ?? `https://ext.local/item-${index}`;
  const parts = parseUrlParts(rawUrl);
  const httpStatus = raw.httpStatus ?? raw.status ?? 200;
  const inferredState: NodeState =
    raw.state ??
    (httpStatus >= 400
      ? 'dead'
      : raw.visited === false
        ? 'frontier'
        : (raw.depth ?? fallbackDepth) === 0
          ? 'query-root'
          : (raw.depth ?? fallbackDepth) === 1
            ? 'tail-seed'
            : 'visited');

  const contentObj: CanonicalNode['content'] | undefined =
    raw.content ??
    (raw.title || raw.snippet || raw.anchorText || raw.imageUrl
      ? {
          ...(raw.title ? { title: raw.title } : {}),
          ...(raw.snippet ? { snippet: raw.snippet } : {}),
          ...(raw.anchorText ? { anchorText: raw.anchorText } : {}),
          ...(raw.imageUrl ? { imageUrl: raw.imageUrl } : {}),
        }
      : undefined);

  return {
    id: raw.id ?? `ext-node-${index}`,
    url: parts.url,
    domain: parts.domain,
    path: parts.path,
    parentId: raw.parentId !== undefined ? raw.parentId : fallbackParentId,
    depth: raw.depth ?? fallbackDepth,
    ...((raw.reverseRank ?? raw.rank) !== undefined
      ? { reverseRank: raw.reverseRank ?? raw.rank }
      : {}),
    state: inferredState,
    branchId: raw.branchId ?? 'trunk',
    discoveredAt: 1_762_000_000_000 + index * 50,
    ...(inferredState === 'visited' || inferredState === 'tail-seed'
      ? { visitedAt: 1_762_000_000_020 + index * 50 }
      : {}),
    httpStatus,
    ...(raw.latencyMs !== undefined ? { latencyMs: raw.latencyMs } : {}),
    ...(raw.judgement ? { judgement: raw.judgement } : {}),
    ...(contentObj ? { content: contentObj } : {}),
    raw,
  };
}

/**
 * Normalizes arbitrary external JSON payloads (`{ nodes, edges }`, nested `{ root / children }`
 * trees, `{ from, to }[]` link arrays, or bare `string[]` URL arrays) into `CrawlEvent[]`.
 */
export function normalizeExternalPayload(
  payload: unknown,
  meta?: {
    query?: string;
    seed?: number;
    topology?: TopologyPreset;
    persona?: PersonaPreset;
    transport?: TransportPreset;
  },
): CrawlEvent[] {
  const query = meta?.query ?? 'external-crawl';
  const seed = meta?.seed ?? 1;
  const topology = meta?.topology ?? 'rhizome-drift';
  const persona = meta?.persona ?? 'ko-periphery';
  const transport = meta?.transport ?? 'instant-dump';

  // Already a single CrawlEvent?
  if (
    payload &&
    typeof payload === 'object' &&
    'type' in payload &&
    typeof (payload as { type: unknown }).type === 'string'
  ) {
    const evType = (payload as { type: string }).type;
    if (
      evType === 'RUN_START' ||
      evType === 'INVERSION_PROGRESS' ||
      evType === 'NODE_UPSERT' ||
      evType === 'EDGE_UPSERT' ||
      evType === 'BRANCH_AWAKENED' ||
      evType === 'RUN_COMPLETE'
    ) {
      return [payload as CrawlEvent];
    }
  }

  const events: CrawlEvent[] = [
    {
      type: 'RUN_START',
      query,
      seed,
      totalSearchHits: 1000,
      tailWindowStart: 170,
      tailWindowEnd: 200,
      topology,
      persona,
      transport,
    },
  ];

  const nodes: CanonicalNode[] = [];
  const edges: CanonicalEdge[] = [];
  let nodeIdx = 0;
  let edgeIdx = 0;

  // Case 1: Array of URLs or { from, to } link pairs or node records
  if (Array.isArray(payload)) {
    const rootId = 'ext-root';
    const rootNode: CanonicalNode = {
      id: rootId,
      url: `query://${encodeURIComponent(query)}`,
      domain: 'reverse-index.local',
      path: '/',
      parentId: null,
      depth: 0,
      state: 'query-root',
      branchId: 'trunk',
      discoveredAt: 1_762_000_000_000,
    };
    nodes.push(rootNode);

    const urlToNodeId = new Map<string, string>();
    const ensureUrlNode = (urlStr: string, parentId: string, depth: number, state: NodeState): CanonicalNode => {
      const existingId = urlToNodeId.get(urlStr);
      if (existingId) {
        return nodes.find((n) => n.id === existingId)!;
      }
      nodeIdx += 1;
      const node = toCanonicalNode(urlStr, nodeIdx, parentId, depth);
      const patched: CanonicalNode = { ...node, state };
      urlToNodeId.set(urlStr, patched.id);
      nodes.push(patched);
      return patched;
    };

    for (const item of payload) {
      if (typeof item === 'string') {
        const created = ensureUrlNode(item, rootId, 1, 'tail-seed');
        edgeIdx += 1;
        edges.push({
          id: `ext-edge-${edgeIdx}`,
          source: rootId,
          target: created.id,
          kind: 'tail-inversion',
          traversed: true,
          branchId: 'trunk',
          order: edgeIdx,
        });
      } else if (item && typeof item === 'object' && ('from' in item || 'source' in item) && ('to' in item || 'target' in item)) {
        const rec = item as { from?: string; source?: string; to?: string; target?: string; traversed?: boolean; anchorText?: string };
        const fromUrl = rec.from ?? rec.source ?? 'https://ext.local/origin';
        const toUrl = rec.to ?? rec.target ?? 'https://ext.local/target';
        const srcNode = ensureUrlNode(fromUrl, rootId, 1, 'tail-seed');
        const traversed = rec.traversed !== false;
        const dstNode = ensureUrlNode(toUrl, srcNode.id, srcNode.depth + 1, traversed ? 'visited' : 'frontier');
        edgeIdx += 1;
        edges.push({
          id: `ext-edge-${edgeIdx}`,
          source: srcNode.id,
          target: dstNode.id,
          kind: traversed ? 'hyperlink' : 'counterfactual-link',
          traversed,
          ...(rec.anchorText ? { anchorText: rec.anchorText } : {}),
          branchId: 'trunk',
          order: edgeIdx,
        });
      } else if (item && typeof item === 'object') {
        nodeIdx += 1;
        const n = toCanonicalNode(item as LooseNodeRecord, nodeIdx, rootId, 1);
        nodes.push(n);
      }
    }
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;

    // Case 2: { nodes: [...], edges?: [...] }
    if (Array.isArray(obj.nodes)) {
      for (const rawNode of obj.nodes) {
        nodeIdx += 1;
        nodes.push(toCanonicalNode(rawNode as LooseNodeRecord | string, nodeIdx, null, 1));
      }
      if (Array.isArray(obj.edges)) {
        for (const rawEdge of obj.edges) {
          if (!rawEdge || typeof rawEdge !== 'object') continue;
          edgeIdx += 1;
          const e = rawEdge as Partial<CanonicalEdge> & { from?: string; to?: string };
          const source = e.source ?? e.from ?? '';
          const target = e.target ?? e.to ?? '';
          if (!source || !target) continue;
          const traversed = e.traversed ?? true;
          const kind: EdgeKind = e.kind ?? (traversed ? 'hyperlink' : 'counterfactual-link');
          edges.push({
            id: e.id ?? `ext-edge-${edgeIdx}`,
            source,
            target,
            kind,
            traversed,
            ...(e.anchorText ? { anchorText: e.anchorText } : {}),
            branchId: e.branchId ?? 'trunk',
            order: e.order ?? edgeIdx,
          });
        }
      } else {
        // Synthesize parentId edges if edges array omitted
        for (const n of nodes) {
          if (n.parentId) {
            edgeIdx += 1;
            const traversed = n.state !== 'frontier';
            edges.push({
              id: `ext-edge-${edgeIdx}`,
              source: n.parentId,
              target: n.id,
              kind: n.depth === 1 ? 'tail-inversion' : traversed ? 'hyperlink' : 'counterfactual-link',
              traversed,
              branchId: n.branchId,
              order: edgeIdx,
            });
          }
        }
      }
    } else {
      // Case 3: Nested tree object `{ url, title, children: [...], links: [...] }`
      const walkTree = (rec: LooseNodeRecord, parentId: string | null, depth: number): void => {
        nodeIdx += 1;
        const current = toCanonicalNode(rec, nodeIdx, parentId, depth);
        nodes.push(current);

        if (parentId) {
          edgeIdx += 1;
          const traversed = current.state !== 'frontier';
          edges.push({
            id: `ext-edge-${edgeIdx}`,
            source: parentId,
            target: current.id,
            kind: depth === 1 ? 'tail-inversion' : traversed ? 'hyperlink' : 'counterfactual-link',
            traversed,
            ...(current.content?.anchorText ? { anchorText: current.content.anchorText } : {}),
            branchId: current.branchId,
            order: edgeIdx,
          });
        }

        if (Array.isArray(rec.children)) {
          for (const child of rec.children) {
            walkTree(child, current.id, depth + 1);
          }
        }
        if (Array.isArray(rec.links)) {
          for (const link of rec.links) {
            const linkRecord: LooseNodeRecord =
              typeof link === 'string'
                ? { url: link, state: 'frontier' }
                : { state: 'frontier', ...link };
            walkTree(linkRecord, current.id, depth + 1);
          }
        }
      };

      const rootRecord = ('root' in obj && obj.root && typeof obj.root === 'object'
        ? obj.root
        : obj) as LooseNodeRecord;
      walkTree(rootRecord, null, rootRecord.depth ?? 0);
    }
  }

  for (const node of nodes) {
    events.push({ type: 'NODE_UPSERT', node });
  }
  for (const edge of edges) {
    events.push({ type: 'EDGE_UPSERT', edge });
  }

  let visitedCount = 0;
  let frontierCount = 0;
  let deadCount = 0;
  let redirectedCount = 0;
  let maxDepth = 0;
  for (const n of nodes) {
    if (n.depth > maxDepth) maxDepth = n.depth;
    if (n.state === 'visited' || n.state === 'tail-seed') visitedCount += 1;
    else if (n.state === 'frontier') frontierCount += 1;
    else if (n.state === 'dead') deadCount += 1;
    else if (n.state === 'redirected') redirectedCount += 1;
  }

  events.push({
    type: 'RUN_COMPLETE',
    stats: {
      totalNodes: nodes.length,
      visitedCount,
      frontierCount,
      deadCount,
      redirectedCount,
      branchCount: 1,
      maxDepth,
      elapsedMs: nodes.length * 40,
    },
  });

  return events;
}

/**
 * Streams NDJSON or `data: ...` SSE lines from a `ReadableStream<Uint8Array>`,
 * converting each line (either a `CrawlEvent` or loose node/graph object) into `CrawlEvent`s.
 */
export async function consumeStreamingBody(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: CrawlEvent) => void,
  meta?: SimulatorOptions,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let nodeCounter = 0;

  const processLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!jsonText || jsonText === '[DONE]') return;

    const parsed: unknown = JSON.parse(jsonText);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      typeof (parsed as { type: unknown }).type === 'string'
    ) {
      onEvent(parsed as CrawlEvent);
      return;
    }

    nodeCounter += 1;
    const node = toCanonicalNode(parsed as LooseNodeRecord | string, nodeCounter, null, 1);
    onEvent({ type: 'NODE_UPSERT', node });
    if (node.parentId) {
      onEvent({
        type: 'EDGE_UPSERT',
        edge: {
          id: `stream-edge-${nodeCounter}`,
          source: node.parentId,
          target: node.id,
          kind: node.state === 'frontier' ? 'counterfactual-link' : 'hyperlink',
          traversed: node.state !== 'frontier',
          branchId: node.branchId,
          order: nodeCounter,
        },
      });
    }
  };

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        processLine(line);
      }
    }
  } finally {
    reader.releaseLock();
  }

  void meta;
}

/**
 * Unified backend adapter: connects to an external REST JSON or NDJSON/SSE endpoint
 * when `endpointUrl` is provided, and seamlessly falls back to the Seeded Simulator
 * in standalone mode or when the remote endpoint is unreachable.
 */
export async function connectCrawlSource(
  options: BackendConnectOptions,
  onEvent: (event: CrawlEvent) => void,
): Promise<{ source: 'backend' | 'simulator' }> {
  const { endpointUrl, fallbackToSimulator = true, fetchImpl = globalThis.fetch, signal } = options;

  if (!endpointUrl) {
    await streamSimulatedEvents(options, onEvent, signal);
    return { source: 'simulator' };
  }

  try {
    const response = await fetchImpl(endpointUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/x-ndjson, text/event-stream, application/json',
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Backend HTTP ${response.status}`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isStreaming =
      contentType.includes('application/x-ndjson') ||
      contentType.includes('text/event-stream') ||
      contentType.includes('application/jsonl');

    if (isStreaming && response.body) {
      await consumeStreamingBody(response.body, onEvent, options, signal);
      return { source: 'backend' };
    }

    const json: unknown = await response.json();
    const normalized = normalizeExternalPayload(json, options);
    for (const ev of normalized) {
      if (signal?.aborted) break;
      onEvent(ev);
    }
    return { source: 'backend' };
  } catch (err) {
    if (signal?.aborted || !fallbackToSimulator) {
      throw err;
    }
    await streamSimulatedEvents(options, onEvent, signal);
    return { source: 'simulator' };
  }
}
