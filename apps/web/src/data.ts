import {
  generateSimulatedEvents, createRng,
  type CanonicalEdge, type CanonicalNode, type CrawlSnapshot, type CrawlEvent, type SimulatorOptions,
} from '@akl/graph-contract';

// Fallback only for records without a usable web URL.
export const LINK_DESTINATION = 'https://www.google.com/search?q=reni+erdos&sca_esv=b3f9128d827c892f&rlz=1C5CHFA_enSG1022SG1022&udm=2&biw=1639&bih=938&sxsrf=AKL5yDiScQjKwDVxs7kpCj-68E3DxNJm2Q%3A1793948881421&ei=0Xztau2fGc6m2roPrem2mQc&ved=2ahUKEwitzMmu5PKXAxVOk1YBHa20LXMQ4dUDegQIBhAN&uact=5&oq=reni+erdos&gs_lp=Egtnd3Mtd2l6LWltZyIKcmVuaSBlcmRvczIEEAAYHkjZI1CRBljoInAEeACQAQCYAZQBoAGHC6oBBDAuMTK4AQPIAQD4AQGYAg-gAt0LqAIAwgIFEAAYgATCAgoQABiABBiKBRhDwgIHEAAYgAQYCsICCRAAGIAEGAoYC8ICBhAAGB4YCsICBhAAGAgYHpgDAZIHBDMuMTKgB_0tsgcEMC4xMrgHzgvCBwYwLjIuMTPIBzmACAE&sclient=gws-wiz-img';
export const SEARCH_COUNTS = { good: 10, awesome: 8 } as const;
export type ResultGroup = 'original' | 'drift';
export interface PageRecord { node: CanonicalNode; group: ResultGroup; href: string; relevanceLevel?: number }
export interface SiteFixture {
  source?: 'mock' | 'api';
  query: string;
  root: CanonicalNode;
  pages: PageRecord[];
  edges: readonly CanonicalEdge[];
}

/** A display category, not a semantic judgement: search origins versus subsequent link drift. */
export function groupOf(node: CanonicalNode): ResultGroup {
  if (node.content?.tags?.includes('search-drift')) return 'drift';
  if (node.content?.tags?.includes('search-original')) return 'original';
  return node.reverseRank !== undefined || node.state === 'tail-seed' ? 'original' : 'drift';
}
export function pageHref(node: CanonicalNode): string {
  try {
    const url = new URL(node.url);
    if (url.protocol === 'https:' || url.protocol === 'http:') return node.url;
  } catch { /* Incomplete mock records use the fallback destination. */ }
  return LINK_DESTINATION;
}
export function shortenLink(value: string, limit = 42): string {
  const letters = Array.from(value);
  return letters.length > limit ? `${letters.slice(0, limit - 1).join('')}…` : value;
}
export function pageRecord(node: CanonicalNode): PageRecord {
  const group = groupOf(node);
  const raw = node.raw && typeof node.raw === 'object' ? node.raw as Record<string, unknown> : {};
  const rank = Number(raw.queryRank);
  return { node, group, href: pageHref(node),
    ...(group === 'drift' ? { relevanceLevel: Math.max(1, Math.min(4, rank || 1)) } : {}) };
}

/** Reuse shared simulator content and parent relations to compose the requested good + awesome run. */
export function createSiteFixture(options: SimulatorOptions): SiteFixture {
  const base = generateSimulatedEvents(options);
  const root = base.find((event) => event.type === 'NODE_UPSERT' && event.node.state === 'query-root')!;
  if (root.type !== 'NODE_UPSERT') throw new Error('Missing query root');
  const pages: PageRecord[] = [];
  const edges: CanonicalEdge[] = [];
  const arrowRng = createRng(options.seed, `drift-arrows:${options.query}`);
  let branchSources: PageRecord[] = [];
  for (const group of ['original', 'drift'] as const) {
    if (group === 'drift') {
      const originals = pages.filter((page) => page.group === 'original');
      const first = arrowRng.pick(originals.slice(0, 5));
      branchSources = [first, ...arrowRng.shuffle(originals.filter((page) => page !== first))];
    }
    const limit = group === 'original' ? SEARCH_COUNTS.good : SEARCH_COUNTS.awesome;
    let count = 0;
    for (let pool = 0; count < limit; pool++) {
      const query = group === 'original' ? options.query
        : ['잊힌 웹링과 개인 아카이브', '단파 수신과 이끼 관찰', '낯선 항구의 구술 기록', '먼 시대의 별자리 지도'][pool % 4]!;
      const source = generateSimulatedEvents({ ...options, query, seed: (options.seed + pool * 101 + (group === 'drift' ? 10001 : 0)) >>> 0 });
      const candidates = source.flatMap((event) => event.type === 'NODE_UPSERT' &&
        ['visited', 'tail-seed', 'redirected'].includes(event.node.state) ? [event.node] : []).slice(0, Math.min(group === 'drift' ? 1 : 10, limit - count));
      if (!candidates.length) throw new Error('Simulator produced no pages');
      const ids = new Map(candidates.map((node) => [node.id, `${group}-${pool}-${node.id}`]));
      const sourceEdges = source.flatMap((event) => event.type === 'EDGE_UPSERT' ? [event.edge] : []);
      const entryId = root.node.id;
      for (const candidate of candidates) {
        const parentId = group === 'drift' ? branchSources[count]!.node.id : ids.get(candidate.parentId ?? '') ?? entryId;
        const parent = pages.find((page) => page.node.id === parentId)?.node ?? root.node;
        const id = ids.get(candidate.id)!;
        const node: CanonicalNode = { ...candidate, id, parentId, depth: parent.depth + 1,
          state: group === 'drift' ? 'visited' : candidate.state,
          raw: { ...(candidate.raw && typeof candidate.raw === 'object' ? candidate.raw : {}), searchQuery: query, queryRank: group === 'drift' ? pool % 4 + 1 : 0 },
          branchId: group === 'drift' ? `awesome-branch-${count}` : `${group}-${pool}`, content: { ...candidate.content,
            tags: [...(candidate.content?.tags ?? []), `search-${group}`] } };
        pages.push(pageRecord(node));
        const incoming = sourceEdges.find((edge) => edge.target === candidate.id && edge.source === candidate.parentId);
        edges.push({ ...(incoming ?? { kind: 'hyperlink', traversed: true }),
          id: `link-${id}`, source: parentId, target: id, branchId: node.branchId, order: edges.length });
        count++;
      }
    }
  }
  return { query: options.query, root: root.node, pages, edges };
}

export function fixtureEvents(fixture: SiteFixture, options: SimulatorOptions): CrawlEvent[] {
  const original = generateSimulatedEvents(options);
  const prefix = original.filter((event) => event.type === 'RUN_START' || (fixture.source !== 'api' && event.type === 'INVERSION_PROGRESS'));
  const events: CrawlEvent[] = [...prefix, { type: 'NODE_UPSERT', node: fixture.root }];
  const good = fixture.pages.filter((page) => page.group === 'original');
  const awesome = fixture.pages.filter((page) => page.group === 'drift');
  const shown = new Set([fixture.root.id]);
  const rng = createRng(options.seed, `parallel-growth:${options.query}`);
  let driftCount = 0;
  while (good.length || awesome.length) {
    const eligible = awesome.filter((page) => shown.has(page.node.parentId ?? fixture.root.id));
    const useAwesome = eligible.length > 0 && (!good.length || driftCount === 0 || rng.chance(.55));
    const page = useAwesome ? rng.pick(eligible) : good.shift();
    if (!page) throw new Error('A branch has no reachable parent');
    if (useAwesome) { awesome.splice(awesome.indexOf(page), 1); driftCount++; }
    shown.add(page.node.id);
    events.push({ type: 'NODE_UPSERT', node: page.node });
    for (const edge of fixture.edges.filter((item) => item.target === page.node.id)) events.push({ type: 'EDGE_UPSERT', edge });
  }
  events.push({ type: 'RUN_COMPLETE', stats: { totalNodes: fixture.pages.length + 1, visitedCount: fixture.pages.filter((page) => page.node.state === 'visited' || page.node.state === 'tail-seed').length, frontierCount: 0,
    deadCount: 0, redirectedCount: fixture.pages.filter((page) => page.node.state === 'redirected').length,
    branchCount: new Set(fixture.pages.map((page) => page.node.branchId)).size,
    maxDepth: Math.max(0, ...fixture.pages.map((page) => page.node.depth)), elapsedMs: fixture.pages.length * 850 } });
  return events;
}

/** Frontier discovery is not a visit; order follows event ingestion, not seeded timestamps. */
export function visitedHistory(snapshot: CrawlSnapshot) {
  return snapshot.history.filter((entry) => entry.nodeId &&
    ['inversion-pick', 'hop-visited', 'dead-end', 'branch-awakened'].includes(entry.action)).slice().reverse();
}
