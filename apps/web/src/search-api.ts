import { createRng, generateSimulatedEvents, type CanonicalNode, type SimulatorOptions } from '@akl/graph-contract';
import { SEARCH_COUNTS, pageRecord, type SiteFixture } from './data.ts';

export interface SearchResult { url: string; title: string; description: string; image: string; rank: number }
export interface AwesomeGroup { rank: number; results: SearchResult[] }
export interface SearchResponse { good: SearchResult[]; awesome: Record<string, AwesomeGroup> }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function rank(value: unknown): value is number { return Number.isInteger(value) && Number(value) > 0; }
function webUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}
export function parseSearchResponse(value: unknown): SearchResponse {
  const results = (items: unknown): SearchResult[] => {
    if (!Array.isArray(items)) throw new Error('검색 결과 형식이 API 명세와 다릅니다');
    return items.map((item) => {
      if (!record(item) || !webUrl(item.url) || !rank(item.rank) ||
        !['title', 'description', 'image'].every((key) => typeof item[key] === 'string')) {
        throw new Error('검색 결과의 필드가 API 명세와 다릅니다');
      }
      return item as unknown as SearchResult;
    });
  };
  if (!record(value) || !record(value.awesome)) throw new Error('good / awesome 응답 형식을 확인해주세요');
  const good = results(value.good);
  const awesome: Record<string, AwesomeGroup> = Object.create(null);
  const ranks = new Set<number>();
  for (const [query, group] of Object.entries(value.awesome)) {
    if (!query.trim() || !record(group) || !rank(group.rank) || ranks.has(group.rank)) {
      throw new Error('재해석 검색어 순위가 유효하지 않습니다');
    }
    ranks.add(group.rank);
    awesome[query] = { rank: group.rank, results: results(group.results) };
  }
  if ([...ranks].some((value) => value > ranks.size)) throw new Error('재해석 검색어 순위가 연속적이지 않습니다');
  return { good, awesome };
}

export function searchResponseToFixture(response: SearchResponse, options: SimulatorOptions): SiteFixture {
  const rootEvent = generateSimulatedEvents(options).find((event) => event.type === 'NODE_UPSERT' && event.node.state === 'query-root');
  if (!rootEvent || rootEvent.type !== 'NODE_UPSERT') throw new Error('Missing query root');
  const fixture: SiteFixture = { source: 'api', query: options.query, root: rootEvent.node, pages: [], edges: [] };
  const edges = [...fixture.edges];
  const arrowRng = createRng(options.seed, `drift-arrows:${options.query}`);
  const append = (result: SearchResult, searchQuery: string, queryRank: number, index: number, original: boolean, parentId = fixture.root.id) => {
    const url = new URL(result.url);
    const group = original ? 'original' : 'drift';
    const id = `api-${group}-${queryRank}-${index}`;
    const node: CanonicalNode = {
      id, url: result.url, domain: url.hostname, path: `${url.pathname}${url.search}${url.hash}`,
      parentId, depth: parentId === fixture.root.id ? 1 : 2, state: 'visited', branchId: original ? 'api-original-0' : `api-drift-${queryRank}-${index}`,
      discoveredAt: fixture.root.discoveredAt + fixture.pages.length * 350,
      content: { title: result.title || url.hostname, snippet: result.description,
        ...(webUrl(result.image) ? { imageUrl: result.image } : {}), tags: [`search-${group}`] },
      // The API describes search membership, not a hyperlink between two result documents.
      raw: { source: 'search-api', searchQuery, queryRank, documentRank: result.rank, relation: original ? 'search-result' : 'simulated-branch' },
    };
    fixture.pages.push(pageRecord(node));
    edges.push({ id: `edge-${id}`, source: parentId, target: id,
      kind: original ? 'hyperlink' : 'counterfactual-link', traversed: true,
      branchId: node.branchId, order: edges.length, anchorText: searchQuery });
  };
  response.good.forEach((result, index) => append(result, options.query, 0, index, true));
  const originals = fixture.pages.filter((page) => page.group === 'original');
  const first = originals.length ? arrowRng.pick(originals.slice(0, 5)) : null;
  const anchors = first ? [first, ...arrowRng.shuffle(originals.filter((page) => page !== first))] : [];
  let branchIndex = 0;
  Object.entries(response.awesome).sort((a, b) => a[1].rank - b[1].rank).forEach(([query, group]) => {
    group.results.forEach((result, index) => {
      const sourceId = anchors.length ? anchors[branchIndex++ % anchors.length]!.node.id : fixture.root.id;
      append(result, query, group.rank, index, false, sourceId);
    });
  });
  return { ...fixture, edges };
}

export async function fetchSearchFixture(endpoint: string, options: SimulatorOptions, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<SiteFixture> {
  const url = new URL(endpoint, typeof location === 'undefined' ? 'http://localhost' : location.origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP API 주소를 확인해주세요');
  if (!url.pathname.endsWith('/search')) url.pathname = `${url.pathname.replace(/\/$/, '')}/search`;
  url.search = new URLSearchParams({ query: options.query.trim(), goodCount: String(SEARCH_COUNTS.good), awesomeQueryCount: '4', awesomeCount: String(SEARCH_COUNTS.awesome / 4) }).toString();
  const response = await fetchImpl(url.href, { method: 'GET', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`검색 API 오류 (${response.status})`);
  return searchResponseToFixture(parseSearchResponse(await response.json()), options);
}
