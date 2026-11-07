export type NodeState =
  | 'query-root'
  | 'tail-seed'
  | 'visited'
  | 'frontier'
  | 'redirected'
  | 'dead';

export type JudgementLens =
  | 'the-unseen'
  | 'counterfactual-self'
  | 'meaningful-disconnection';

export type ContentLang = 'ko' | 'en' | 'ja' | 'mixed' | 'mojibake';

export interface NodeJudgement {
  /** 0..1 semantic/structural bridge score */
  connection: number;
  /** 0..1 counterfactual distance / serendipity score */
  novelty: number;
  lens: JudgementLens;
}

export interface NodeContent {
  title?: string;
  snippet?: string;
  /** <a href> phrase on parent page that pointed here */
  anchorText?: string;
  lang?: ContentLang;
  tags?: string[];
  imageUrl?: string;
  outboundCount?: number;
}

export interface CanonicalNode {
  id: string;
  url: string;
  domain: string;
  path: string;
  parentId: string | null;
  /** 0 = query-root, 1 = tail-seed, 2+ = internal/external link hops */
  depth: number;
  /** e.g. #196, #183, #174 from inverted Google search tail */
  reverseRank?: number;
  state: NodeState;
  /** 'trunk' or 'branch-1', 'branch-2' when user awakens counterfactual branches */
  branchId: string;
  discoveredAt: number;
  visitedAt?: number;
  /** 200, 301, 403, 404, 504 */
  httpStatus?: number;
  latencyMs?: number;
  judgement?: NodeJudgement;
  content?: NodeContent;
  raw?: unknown;
}

export type EdgeKind =
  | 'tail-inversion'
  | 'hyperlink'
  | 'counterfactual-link'
  | 'branch-awaken'
  | 'redirect'
  | 'cycle-backlink';

export interface CanonicalEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  traversed: boolean;
  anchorText?: string;
  branchId: string;
  order: number;
}

export type HistoryAction =
  | 'query'
  | 'inversion-pick'
  | 'hop-visited'
  | 'frontier-offered'
  | 'branch-awakened'
  | 'dead-end';

export interface HistoryEntry {
  id: string;
  timestamp: number;
  action: HistoryAction;
  nodeId?: string;
  branchId: string;
  label: string;
  detail?: string;
  reverseRank?: number;
  depth?: number;
}

export type TopologyPreset =
  | 'rhizome-drift'
  | 'deep-abyss-chain'
  | 'nav-starburst'
  | 'ouroboros-loop'
  | 'dead-end-ruins'
  | 'archipelago-jump';

export type PersonaPreset =
  | 'ko-periphery'
  | 'polyglot-wild'
  | 'visual-archive'
  | 'bare-url-only';

export type TransportPreset =
  | 'ritual-stream'
  | 'instant-dump'
  | 'burst-and-stall';

export interface CrawlRunStats {
  totalNodes: number;
  visitedCount: number;
  frontierCount: number;
  deadCount: number;
  redirectedCount: number;
  branchCount: number;
  maxDepth: number;
  elapsedMs: number;
}

export type CrawlEvent =
  | {
      type: 'RUN_START';
      query: string;
      seed: number;
      totalSearchHits: number;
      tailWindowStart: number;
      tailWindowEnd: number;
      topology: TopologyPreset;
      persona: PersonaPreset;
      transport: TransportPreset;
    }
  | {
      type: 'INVERSION_PROGRESS';
      currentRank: number;
      totalRanks: number;
      sampleTitle: string;
    }
  | {
      type: 'NODE_UPSERT';
      node: CanonicalNode;
    }
  | {
      type: 'EDGE_UPSERT';
      edge: CanonicalEdge;
    }
  | {
      type: 'BRANCH_AWAKENED';
      fromNodeId: string;
      branchId: string;
      label: string;
    }
  | {
      type: 'RUN_COMPLETE';
      stats: CrawlRunStats;
    };

export interface InversionState {
  active: boolean;
  currentRank: number;
  totalRanks: number;
  tailWindowStart: number;
  tailWindowEnd: number;
  sampleTitle: string;
  totalSearchHits: number;
}

export type SessionStatus = 'idle' | 'inverting' | 'drifting' | 'complete';

export interface CrawlSnapshot {
  runId: number;
  version: number;
  status: SessionStatus;
  query: string;
  seed: number;
  topology: TopologyPreset;
  persona: PersonaPreset;
  transport: TransportPreset;
  inversion: InversionState;
  nodes: readonly CanonicalNode[];
  nodeMap: ReadonlyMap<string, CanonicalNode>;
  edges: readonly CanonicalEdge[];
  history: readonly HistoryEntry[];
  branches: readonly string[];
  activeNodeId: string | null;
  pendingQueueSize: number;
  stats: CrawlRunStats;
}

export const TOPOLOGY_PRESETS: readonly TopologyPreset[] = [
  'rhizome-drift',
  'deep-abyss-chain',
  'nav-starburst',
  'ouroboros-loop',
  'dead-end-ruins',
  'archipelago-jump',
] as const;

export const PERSONA_PRESETS: readonly PersonaPreset[] = [
  'ko-periphery',
  'polyglot-wild',
  'visual-archive',
  'bare-url-only',
] as const;

export const TRANSPORT_PRESETS: readonly TransportPreset[] = [
  'ritual-stream',
  'instant-dump',
  'burst-and-stall',
] as const;

/**
 * Helper to derive a readable display label for any CanonicalNode,
 * gracefully handling `bare-url-only` nodes where `content` is omitted.
 */
export function getNodeDisplayLabel(node: CanonicalNode): string {
  if (node.state === 'query-root') {
    return node.content?.title || `Query: ${node.url.replace(/^query:\/\//, '')}`;
  }
  const title = node.content?.title?.trim();
  if (title) {
    return title;
  }
  const cleanPath = node.path && node.path !== '/' ? node.path : '';
  return `${node.domain}${cleanPath}`;
}
