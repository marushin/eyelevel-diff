import {
  type CanonicalEdge,
  type CanonicalNode,
  type CrawlEvent,
  type CrawlRunStats,
  type CrawlSnapshot,
  getNodeDisplayLabel,
  type HistoryEntry,
  type PersonaPreset,
  type SessionStatus,
  type TopologyPreset,
  type TransportPreset,
} from './contract.ts';
import {
  generateCounterfactualBranchEvents,
  type SimulatorOptions,
  streamSimulatedEvents,
} from './simulator.ts';

/**
 * Fixed-allocation power-of-two growing Ring Queue for O(1) backpressure ingestion.
 */
export class EventRingQueue<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(initialCapacity = 128) {
    let cap = 16;
    while (cap < initialCapacity) cap <<= 1;
    this.buffer = new Array<T | undefined>(cap);
  }

  get size(): number {
    return this.count;
  }

  enqueue(item: T): void {
    if (this.count === this.buffer.length) {
      this.grow();
    }
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) & (this.buffer.length - 1);
    this.count += 1;
  }

  dequeue(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) & (this.buffer.length - 1);
    this.count -= 1;
    return item;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  private grow(): void {
    const oldLen = this.buffer.length;
    const next = new Array<T | undefined>(oldLen << 1);
    for (let i = 0; i < this.count; i++) {
      next[i] = this.buffer[(this.head + i) & (oldLen - 1)];
    }
    this.buffer = next;
    this.head = 0;
    this.tail = this.count;
  }
}

export interface CrawlSessionConfig {
  /** Maximum CrawlEvents applied per animation tick (default: 8). */
  maxEventsPerFrame?: number;
  /** Custom frame scheduler (useful for deterministic headless testing). */
  scheduleFrame?: (cb: () => void) => () => void;
}

export interface StartRunOptions extends SimulatorOptions {
  /** If true, bypasses async transport & frame drip to populate snapshot synchronously. */
  immediate?: boolean;
}

export interface AwakenBranchOptions {
  /** Custom label override for the history log. */
  label?: string;
  /** If true, drains all branch events synchronously before returning. */
  immediate?: boolean;
}

export type SnapshotListener = (
  snapshot: CrawlSnapshot,
  appliedEvents: readonly CrawlEvent[],
) => void;

export type RawEventListener = (event: CrawlEvent, snapshot: CrawlSnapshot) => void;

function defaultScheduleFrame(cb: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    const id = globalThis.requestAnimationFrame(() => cb());
    return () => {
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(id);
      }
    };
  }
  const timer = setTimeout(cb, 16);
  return () => clearTimeout(timer);
}

export class CrawlSession {
  private maxEventsPerFrame: number;
  private readonly scheduleFrame: (cb: () => void) => () => void;
  private readonly queue = new EventRingQueue<CrawlEvent>(256);
  private cancelScheduledFrame: (() => void) | null = null;
  private activeRunAbort: AbortController | null = null;

  private readonly listeners = new Set<SnapshotListener>();
  private readonly eventListeners = new Set<RawEventListener>();

  private runId = 0;
  private version = 0;
  private status: SessionStatus = 'idle';
  private query = '보이지 않는 웹';
  private seed = 4201;
  private topology: TopologyPreset = 'rhizome-drift';
  private persona: PersonaPreset = 'ko-periphery';
  private transport: TransportPreset = 'ritual-stream';
  private baseTimestamp = 1_762_000_000_000;
  private historyCounter = 0;
  private branchCounter = 0;

  private inversion = {
    active: false,
    currentRank: 0,
    totalRanks: 200,
    tailWindowStart: 170,
    tailWindowEnd: 200,
    sampleTitle: '',
    totalSearchHits: 0,
  };

  private nodeMap = new Map<string, CanonicalNode>();
  private edgeMap = new Map<string, CanonicalEdge>();
  private historyList: HistoryEntry[] = [];
  private branchSet = new Set<string>(['trunk']);
  private activeNodeId: string | null = null;
  private lastElapsedMs = 0;

  private cachedSnapshot: CrawlSnapshot;

  constructor(config: CrawlSessionConfig = {}) {
    this.maxEventsPerFrame = Math.max(1, config.maxEventsPerFrame ?? 8);
    this.scheduleFrame = config.scheduleFrame ?? defaultScheduleFrame;
    this.cachedSnapshot = this.buildSnapshot();
  }

  /**
   * Dual-Port Store Port 1: Instant O(1) immutable snapshot getter.
   */
  getSnapshot(): CrawlSnapshot {
    return this.cachedSnapshot;
  }

  /**
   * Dual-Port Store Port 2: Subscribe to batched frame updates.
   */
  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Optional fine-grained per-event listener (fires as events exit the drip queue).
   */
  onEvent(listener: RawEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  setMaxEventsPerFrame(maxEventsPerFrame: number): void {
    this.maxEventsPerFrame = Math.max(1, Math.floor(maxEventsPerFrame));
  }

  /**
   * Enqueues one or more CrawlEvents into the backpressure ring queue.
   */
  enqueue(events: CrawlEvent | readonly CrawlEvent[]): void {
    if (Array.isArray(events)) {
      for (const ev of events) {
        this.queue.enqueue(ev);
      }
    } else {
      this.queue.enqueue(events as CrawlEvent);
    }
    this.cachedSnapshot = this.buildSnapshot();
    this.ensurePumpScheduled();
  }

  /**
   * Starts a fresh deterministic crawl run (cancelling any in-flight stream).
   */
  async startRun(options: StartRunOptions): Promise<CrawlSnapshot> {
    this.cancelInFlightStream();
    this.resetStateForNewRun(options);

    if (options.immediate) {
      await streamSimulatedEvents(
        { ...options, transport: 'instant-dump' },
        (ev) => this.queue.enqueue(ev),
      );
      this.flush();
      return this.cachedSnapshot;
    }

    const abortController = new AbortController();
    this.activeRunAbort = abortController;

    await streamSimulatedEvents(
      options,
      (ev) => {
        if (!abortController.signal.aborted) {
          this.enqueue(ev);
        }
      },
      abortController.signal,
    );

    return this.cachedSnapshot;
  }

  /**
   * Resets internal graph state and prepares to ingest an external event stream
   * (e.g. from `backend.ts` adapter).
   */
  prepareExternalRun(meta?: Partial<SimulatorOptions>): void {
    this.cancelInFlightStream();
    this.resetStateForNewRun({
      query: meta?.query ?? this.query,
      seed: meta?.seed ?? this.seed,
      topology: meta?.topology ?? this.topology,
      persona: meta?.persona ?? this.persona,
      transport: meta?.transport ?? this.transport,
    });
  }

  /**
   * Non-Destructive Counterfactual Branching:
   * Can be invoked on ANY `frontier` (unchosen possibility) OR already `visited` / `tail-seed` node.
   * Preserves 100% of existing nodes, edges, and branches; flips `frontier -> visited`
   * (and its incoming edge to `traversed: true`, `kind: 'branch-awaken'`), logs `BRANCH_AWAKENED`,
   * and streams a new multi-hop sub-tree (`branch-N`).
   */
  awakenBranch(nodeId: string, opts: AwakenBranchOptions = {}): string | null {
    // Ensure any pending node creations that include nodeId are applied if nodeId isn't materialized yet
    if (!this.nodeMap.has(nodeId) && this.queue.size > 0) {
      this.flush();
    }

    const existing = this.nodeMap.get(nodeId);
    if (!existing || existing.state === 'query-root') {
      return null;
    }

    this.branchCounter += 1;
    const branchId = `branch-${this.branchCounter}`;
    this.branchSet.add(branchId);

    const preEvents: CrawlEvent[] = [];
    let anchorNode = existing;

    // If awakening an unvisited candidate (`frontier` or `redirected`), promote it to `visited`
    // and mark its incoming edge as `traversed: true`, `kind: 'branch-awaken'`.
    if (existing.state === 'frontier' || existing.state === 'redirected') {
      const promotedTs =
        this.baseTimestamp + 3_500 + (this.nodeMap.size + this.branchCounter) * 75;
      anchorNode = {
        ...existing,
        state: 'visited',
        visitedAt: existing.visitedAt ?? promotedTs,
      };
      preEvents.push({ type: 'NODE_UPSERT', node: anchorNode });

      for (const edge of this.edgeMap.values()) {
        if (edge.target === nodeId) {
          preEvents.push({
            type: 'EDGE_UPSERT',
            edge: {
              ...edge,
              traversed: true,
              kind: 'branch-awaken',
            },
          });
        }
      }
    }

    const branchEvents = generateCounterfactualBranchEvents({
      parentNode: anchorNode,
      branchId,
      query: this.query,
      seed: this.seed,
      persona: this.persona,
      topology: this.topology,
      existingNodeCount: this.nodeMap.size + preEvents.length,
      existingEdgeCount: this.edgeMap.size + preEvents.length,
      baseTimestamp: this.baseTimestamp,
    });

    if (opts.label) {
      const first = branchEvents[0];
      if (first && first.type === 'BRANCH_AWAKENED') {
        branchEvents[0] = { ...first, label: opts.label };
      }
    }

    this.enqueue([...preEvents, ...branchEvents]);

    if (opts.immediate) {
      this.flush();
    }

    return branchId;
  }

  /**
   * Drains up to `limit` events from the ring queue and notifies subscribers once.
   */
  stepFrame(limit = this.maxEventsPerFrame): number {
    if (this.queue.size === 0) return 0;

    const applied: CrawlEvent[] = [];
    const max = Math.max(1, limit);

    while (applied.length < max && this.queue.size > 0) {
      const ev = this.queue.dequeue();
      if (!ev) break;
      this.applySingleEvent(ev);
      applied.push(ev);
    }

    this.version += 1;
    this.cachedSnapshot = this.buildSnapshot();

    for (const ev of applied) {
      for (const evListener of this.eventListeners) {
        evListener(ev, this.cachedSnapshot);
      }
    }
    for (const listener of this.listeners) {
      listener(this.cachedSnapshot, applied);
    }

    if (this.queue.size > 0) {
      this.ensurePumpScheduled();
    }

    return applied.length;
  }

  /**
   * Synchronously drains all remaining events in the backpressure queue.
   */
  flush(): CrawlSnapshot {
    if (this.cancelScheduledFrame) {
      this.cancelScheduledFrame();
      this.cancelScheduledFrame = null;
    }
    if (this.queue.size > 0) {
      this.stepFrame(Number.MAX_SAFE_INTEGER);
    }
    return this.cachedSnapshot;
  }

  dispose(): void {
    this.cancelInFlightStream();
    if (this.cancelScheduledFrame) {
      this.cancelScheduledFrame();
      this.cancelScheduledFrame = null;
    }
    this.queue.clear();
    this.listeners.clear();
    this.eventListeners.clear();
  }

  private cancelInFlightStream(): void {
    if (this.activeRunAbort) {
      this.activeRunAbort.abort();
      this.activeRunAbort = null;
    }
    if (this.cancelScheduledFrame) {
      this.cancelScheduledFrame();
      this.cancelScheduledFrame = null;
    }
    this.queue.clear();
  }

  private resetStateForNewRun(options: SimulatorOptions): void {
    this.runId += 1;
    this.version += 1;
    this.status = 'inverting';
    this.query = options.query.trim() || '보이지 않는 웹';
    this.seed = options.seed >>> 0;
    this.topology = options.topology ?? 'rhizome-drift';
    this.persona = options.persona ?? 'ko-periphery';
    this.transport = options.transport ?? 'ritual-stream';
    this.baseTimestamp =
      options.baseTimestamp ?? 1_762_000_000_000 + (this.seed % 500_000) * 1000;
    this.historyCounter = 0;
    this.branchCounter = 0;

    this.inversion = {
      active: true,
      currentRank: 1,
      totalRanks: 200,
      tailWindowStart: 170,
      tailWindowEnd: 200,
      sampleTitle: '',
      totalSearchHits: 0,
    };

    this.nodeMap = new Map();
    this.edgeMap = new Map();
    this.historyList = [];
    this.branchSet = new Set(['trunk']);
    this.activeNodeId = null;
    this.lastElapsedMs = 0;
    this.cachedSnapshot = this.buildSnapshot();
  }

  private ensurePumpScheduled(): void {
    if (this.cancelScheduledFrame || this.queue.size === 0) return;
    this.cancelScheduledFrame = this.scheduleFrame(() => {
      this.cancelScheduledFrame = null;
      this.stepFrame(this.maxEventsPerFrame);
    });
  }

  private pushHistory(entry: Omit<HistoryEntry, 'id'>): void {
    this.historyCounter += 1;
    this.historyList.push({
      id: `hist-${String(this.historyCounter).padStart(4, '0')}`,
      ...entry,
    });
  }

  private applySingleEvent(event: CrawlEvent): void {
    switch (event.type) {
      case 'RUN_START': {
        this.query = event.query;
        this.seed = event.seed;
        this.topology = event.topology;
        this.persona = event.persona;
        this.transport = event.transport;
        this.status = 'inverting';
        this.inversion = {
          active: true,
          currentRank: 1,
          totalRanks: event.tailWindowEnd,
          tailWindowStart: event.tailWindowStart,
          tailWindowEnd: event.tailWindowEnd,
          sampleTitle: '',
          totalSearchHits: event.totalSearchHits,
        };
        this.pushHistory({
          timestamp: this.baseTimestamp,
          action: 'query',
          branchId: 'trunk',
          label: `질의 역전 시작: "${event.query}"`,
          detail: `약 ${event.totalSearchHits.toLocaleString('en-US')}건 중 #${event.tailWindowStart}–#${event.tailWindowEnd} 심해 구간 다이브`,
          depth: 0,
        });
        break;
      }

      case 'INVERSION_PROGRESS': {
        this.status = 'inverting';
        this.inversion = {
          ...this.inversion,
          active: event.currentRank < event.totalRanks - 2,
          currentRank: event.currentRank,
          totalRanks: event.totalRanks,
          sampleTitle: event.sampleTitle,
        };
        break;
      }

      case 'NODE_UPSERT': {
        const node = event.node;
        const prev = this.nodeMap.get(node.id);
        this.nodeMap.set(node.id, node);
        this.branchSet.add(node.branchId);

        if (node.depth >= 1 && this.status === 'inverting') {
          this.status = 'drifting';
          this.inversion = { ...this.inversion, active: false };
        }

        const label = getNodeDisplayLabel(node);

        if (!prev) {
          if (node.state === 'tail-seed') {
            this.activeNodeId = node.id;
            this.pushHistory({
              timestamp: node.discoveredAt,
              action: 'inversion-pick',
              nodeId: node.id,
              branchId: node.branchId,
              label,
              detail: `검색 역순 #${node.reverseRank ?? '?'} 변방 기점 포착 (${node.domain})`,
              ...(node.reverseRank !== undefined ? { reverseRank: node.reverseRank } : {}),
              depth: node.depth,
            });
          } else if (node.state === 'visited' || node.state === 'redirected') {
            this.activeNodeId = node.id;
            this.pushHistory({
              timestamp: node.visitedAt ?? node.discoveredAt,
              action: 'hop-visited',
              nodeId: node.id,
              branchId: node.branchId,
              label,
              detail:
                node.state === 'redirected'
                  ? `301 리다이렉트 경유 → ${node.domain}`
                  : node.content?.anchorText ?? node.url,
              depth: node.depth,
            });
          } else if (node.state === 'frontier') {
            this.pushHistory({
              timestamp: node.discoveredAt,
              action: 'frontier-offered',
              nodeId: node.id,
              branchId: node.branchId,
              label,
              detail: `미답사 가능성 보존 (${node.domain})`,
              depth: node.depth,
            });
          } else if (node.state === 'dead') {
            this.pushHistory({
              timestamp: node.discoveredAt,
              action: 'dead-end',
              nodeId: node.id,
              branchId: node.branchId,
              label,
              detail: `HTTP ${node.httpStatus ?? 404} 유실된 웹 흔적 (${node.domain})`,
              depth: node.depth,
            });
          }
        } else if (prev.state !== node.state && node.state === 'visited') {
          this.activeNodeId = node.id;
        }
        break;
      }

      case 'EDGE_UPSERT': {
        this.edgeMap.set(event.edge.id, event.edge);
        break;
      }

      case 'BRANCH_AWAKENED': {
        this.status = 'drifting';
        this.branchSet.add(event.branchId);
        this.activeNodeId = event.fromNodeId;
        this.pushHistory({
          timestamp: this.baseTimestamp + 4_000 + this.historyCounter * 50,
          action: 'branch-awakened',
          nodeId: event.fromNodeId,
          branchId: event.branchId,
          label: `갈림길 각성 [${event.branchId}]: ${event.label}`,
          detail: '가지 않았던 반사실적 링크에서 새로운 표류 가지를 전개합니다.',
        });
        break;
      }

      case 'RUN_COMPLETE': {
        this.status = 'complete';
        this.inversion = { ...this.inversion, active: false };
        this.lastElapsedMs = event.stats.elapsedMs;
        break;
      }
    }
  }

  private computeLiveStats(): CrawlRunStats {
    let visitedCount = 0;
    let frontierCount = 0;
    let deadCount = 0;
    let redirectedCount = 0;
    let maxDepth = 0;

    for (const node of this.nodeMap.values()) {
      if (node.depth > maxDepth) maxDepth = node.depth;
      if (node.state === 'visited' || node.state === 'tail-seed') visitedCount += 1;
      else if (node.state === 'frontier') frontierCount += 1;
      else if (node.state === 'dead') deadCount += 1;
      else if (node.state === 'redirected') redirectedCount += 1;
    }

    return {
      totalNodes: this.nodeMap.size,
      visitedCount,
      frontierCount,
      deadCount,
      redirectedCount,
      branchCount: this.branchSet.size,
      maxDepth,
      elapsedMs: this.lastElapsedMs || this.nodeMap.size * 65,
    };
  }

  private buildSnapshot(): CrawlSnapshot {
    const nodes = Array.from(this.nodeMap.values());
    const edges = Array.from(this.edgeMap.values());
    const history = this.historyList.slice();
    const branches = Array.from(this.branchSet);

    return {
      runId: this.runId,
      version: this.version,
      status: this.status,
      query: this.query,
      seed: this.seed,
      topology: this.topology,
      persona: this.persona,
      transport: this.transport,
      inversion: { ...this.inversion },
      nodes,
      nodeMap: new Map(this.nodeMap),
      edges,
      history,
      branches,
      activeNodeId: this.activeNodeId,
      pendingQueueSize: this.queue.size,
      stats: this.computeLiveStats(),
    };
  }
}
