import { describe, expect, it, vi } from 'vitest';
import {
  connectCrawlSource,
  type CrawlEvent,
  CrawlSession,
  generateSimulatedEvents,
  getNodeDisplayLabel,
  normalizeExternalPayload,
  TOPOLOGY_PRESETS,
} from '../index.ts';

describe('@akl/graph-contract', () => {
  it('guarantees deterministic PRNG parity (same query + seed = identical snapshot)', async () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');

    const sessionA = new CrawlSession();
    const sessionB = new CrawlSession();

    const snapA = await sessionA.startRun({
      query: '심야 단파수신소',
      seed: 908172,
      topology: 'rhizome-drift',
      persona: 'ko-periphery',
      immediate: true,
    });

    const snapB = await sessionB.startRun({
      query: '심야 단파수신소',
      seed: 908172,
      topology: 'rhizome-drift',
      persona: 'ko-periphery',
      immediate: true,
    });

    expect(mathRandomSpy).not.toHaveBeenCalled();
    expect(snapA.nodes).toEqual(snapB.nodes);
    expect(snapA.edges).toEqual(snapB.edges);
    expect(snapA.history).toEqual(snapB.history);
    expect(snapA.stats).toEqual(snapB.stats);

    mathRandomSpy.mockRestore();
  });

  it('produces distinct topological invariants across all 6 topologies', async () => {
    for (const topology of TOPOLOGY_PRESETS) {
      const session = new CrawlSession();
      const snap = await session.startRun({
        query: '섬과 등대',
        seed: 77,
        topology,
        persona: 'ko-periphery',
        immediate: true,
      });
      expect(snap.nodes.length).toBeGreaterThan(5);
      expect(snap.status).toBe('complete');

      if (topology === 'deep-abyss-chain') {
        expect(snap.stats.maxDepth).toBeGreaterThanOrEqual(20);
      }
      if (topology === 'nav-starburst') {
        expect(snap.stats.frontierCount).toBeGreaterThanOrEqual(80);
      }
      if (topology === 'ouroboros-loop') {
        expect(snap.edges.some((e) => e.kind === 'cycle-backlink')).toBe(true);
      }
      if (topology === 'dead-end-ruins') {
        expect(snap.stats.deadCount).toBeGreaterThan(10);
      }
      if (topology === 'archipelago-jump') {
        const distinctDomains = new Set(snap.nodes.map((n) => n.domain));
        expect(distinctDomains.size).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('handles bare-url-only persona with omitted content and clean URL fallback labels', async () => {
    const session = new CrawlSession();
    const snap = await session.startRun({
      query: 'raw-crawl',
      seed: 31415,
      topology: 'rhizome-drift',
      persona: 'bare-url-only',
      immediate: true,
    });

    const crawledNodes = snap.nodes.filter((n) => n.state !== 'query-root');
    expect(crawledNodes.length).toBeGreaterThan(10);

    for (const node of crawledNodes) {
      expect(node.content).toBeUndefined();
      expect(node.url.startsWith('https://')).toBe(true);
      const label = getNodeDisplayLabel(node);
      expect(label).toContain(node.domain);
    }
  });

  it('drips large bursts through the backpressure ring queue at maxEventsPerFrame', () => {
    const scheduledCallbacks: (() => void)[] = [];
    const session = new CrawlSession({
      maxEventsPerFrame: 5,
      scheduleFrame: (cb) => {
        scheduledCallbacks.push(cb);
        return () => {};
      },
    });

    const batchSizes: number[] = [];
    session.subscribe((_snap, applied) => {
      batchSizes.push(applied.length);
    });

    const allEvents = generateSimulatedEvents({
      query: '버스트 백프레셔 테스트',
      seed: 1234,
      topology: 'nav-starburst',
      persona: 'ko-periphery',
      transport: 'instant-dump',
    });

    expect(allEvents.length).toBeGreaterThan(120);
    session.enqueue(allEvents);

    // Before the first frame tick runs, no nodes have been committed yet
    expect(session.getSnapshot().pendingQueueSize).toBe(allEvents.length);
    expect(session.getSnapshot().nodes.length).toBe(0);

    // Drain tick-by-tick
    let ticks = 0;
    while (session.getSnapshot().pendingQueueSize > 0 && ticks < 500) {
      const nextCb = scheduledCallbacks.shift();
      expect(nextCb).toBeDefined();
      nextCb!();
      ticks += 1;
    }

    expect(session.getSnapshot().pendingQueueSize).toBe(0);
    expect(batchSizes.every((n) => n <= 5)).toBe(true);
    expect(batchSizes.reduce((acc, n) => acc + n, 0)).toBe(allEvents.length);
    expect(session.getSnapshot().status).toBe('complete');
  });

  it('awakens counterfactual branches non-destructively from both frontier and visited nodes', async () => {
    const session = new CrawlSession();
    const initialSnap = await session.startRun({
      query: '가지 않은 길',
      seed: 2026,
      topology: 'rhizome-drift',
      persona: 'ko-periphery',
      immediate: true,
    });

    const initialNodeIds = new Set(initialSnap.nodes.map((n) => n.id));
    const initialEdgeIds = new Set(initialSnap.edges.map((e) => e.id));

    const targetFrontier = initialSnap.nodes.find((n) => n.state === 'frontier');
    expect(targetFrontier).toBeDefined();

    const branch1 = session.awakenBranch(targetFrontier!.id, { immediate: true });
    expect(branch1).toBe('branch-1');

    const afterBranch1 = session.getSnapshot();
    // 100% of prior nodes & edges preserved
    for (const id of initialNodeIds) {
      expect(afterBranch1.nodeMap.has(id)).toBe(true);
    }
    for (const edgeId of initialEdgeIds) {
      expect(afterBranch1.edges.some((e) => e.id === edgeId)).toBe(true);
    }

    // Target frontier flipped to 'visited' and its incoming edge flipped to traversed + 'branch-awaken'
    const promoted = afterBranch1.nodeMap.get(targetFrontier!.id)!;
    expect(promoted.state).toBe('visited');
    expect(promoted.visitedAt).toBeDefined();

    const incomingEdge = afterBranch1.edges.find((e) => e.target === targetFrontier!.id)!;
    expect(incomingEdge.traversed).toBe(true);
    expect(incomingEdge.kind).toBe('branch-awaken');

    // New branch-1 nodes include both visited hops and fresh counterfactual frontiers
    const branch1Nodes = afterBranch1.nodes.filter((n) => n.branchId === 'branch-1');
    expect(branch1Nodes.some((n) => n.state === 'visited')).toBe(true);
    expect(branch1Nodes.some((n) => n.state === 'frontier')).toBe(true);
    expect(afterBranch1.history.some((h) => h.action === 'branch-awakened')).toBe(true);

    // Also awaken from an already-visited node -> branch-2
    const existingVisited = initialSnap.nodes.find((n) => n.state === 'visited')!;
    const branch2 = session.awakenBranch(existingVisited.id, { immediate: true });
    expect(branch2).toBe('branch-2');
    const afterBranch2 = session.getSnapshot();
    expect(afterBranch2.branches).toContain('branch-2');
    expect(afterBranch2.nodes.length).toBeGreaterThan(afterBranch1.nodes.length);
  });

  it('normalizes REST JSON, nested trees, bare link arrays, and streaming NDJSON via backend.ts', async () => {
    // 1. Nested tree normalization
    const treeEvents = normalizeExternalPayload({
      id: 'root',
      url: 'query://archive',
      depth: 0,
      state: 'query-root',
      children: [
        {
          id: 'seed-1',
          url: 'https://old-bbs.kr/index.htm',
          reverseRank: 192,
          title: '구버전 게시판',
          links: ['https://neighbor.pe.kr/guestbook.html'],
        },
      ],
    });
    expect(treeEvents.some((e) => e.type === 'NODE_UPSERT' && e.node.id === 'seed-1')).toBe(true);
    expect(
      treeEvents.some(
        (e) => e.type === 'NODE_UPSERT' && e.node.domain === 'neighbor.pe.kr' && e.node.state === 'frontier',
      ),
    ).toBe(true);

    // 2. Streaming NDJSON via connectCrawlSource
    const ndjsonLines = [
      JSON.stringify({
        type: 'RUN_START',
        query: 'stream-test',
        seed: 1,
        totalSearchHits: 500,
        tailWindowStart: 180,
        tailWindowEnd: 200,
        topology: 'rhizome-drift',
        persona: 'bare-url-only',
        transport: 'ritual-stream',
      } satisfies CrawlEvent),
      JSON.stringify({ id: 'n1', url: 'https://stream.example.org/a.html', depth: 1, state: 'tail-seed' }),
      JSON.stringify({ id: 'n2', url: 'https://stream.example.org/b.html', parentId: 'n1', depth: 2, visited: false }),
    ].join('\n');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(ndjsonLines));
        controller.close();
      },
    });

    const received: CrawlEvent[] = [];
    const res = await connectCrawlSource(
      {
        query: 'stream-test',
        seed: 1,
        endpointUrl: 'https://mock.backend/crawl.ndjson',
        fetchImpl: async () =>
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'application/x-ndjson' },
          }),
      },
      (ev) => received.push(ev),
    );

    expect(res.source).toBe('backend');
    expect(received.filter((e) => e.type === 'NODE_UPSERT')).toHaveLength(2);
    expect(received.some((e) => e.type === 'EDGE_UPSERT' && !e.edge.traversed)).toBe(true);

    // 3. Automatic fallback to simulator when backend fails
    const fallbackEvents: CrawlEvent[] = [];
    const fallbackRes = await connectCrawlSource(
      {
        query: '오프라인 폴백',
        seed: 55,
        transport: 'instant-dump',
        endpointUrl: 'https://unreachable.backend/api',
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
      (ev) => fallbackEvents.push(ev),
    );
    expect(fallbackRes.source).toBe('simulator');
    expect(fallbackEvents.some((e) => e.type === 'RUN_COMPLETE')).toBe(true);
  });
});
