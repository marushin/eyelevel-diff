import { describe, expect, it, vi } from 'vitest';
import { fetchSearchFixture, parseSearchResponse, searchResponseToFixture } from '../search-api.ts';
import { layoutStacks } from '../stack-layout.ts';
import { fixtureEvents, visitedHistory } from '../data.ts';
import { CrawlSession } from '@akl/graph-contract';
const result = (url: string, rank = 1) => ({ url, rank, title: '', description: '본문', image: '' });
const options = { query: '참여 예술', seed: 42 };

describe('HTTP search specification adapter', () => {
  it('sorts query groups by explicit rank, preserves document rank and repeated URLs across groups', () => {
    const response = parseSearchResponse({ good: [result('https://a.test', 2)], awesome: {
      '두번째': { rank: 2, results: [result('https://a.test', 9)] },
      '첫번째': { rank: 1, results: [result('https://b.test', 3)] },
      '빈 결과': { rank: 3, results: [] },
    } });
    const fixture = searchResponseToFixture(response, options);
    expect(fixture.pages.map((page) => page.node.raw)).toEqual([
      expect.objectContaining({ searchQuery: options.query, documentRank: 2 }),
      expect.objectContaining({ searchQuery: '첫번째', queryRank: 1, documentRank: 3 }),
      expect.objectContaining({ searchQuery: '두번째', queryRank: 2, documentRank: 9 }),
    ]);
    expect(fixture.pages.map((page) => page.relevanceLevel)).toEqual([undefined, 1, 2]);
    expect(fixture.pages.filter((page) => page.href === 'https://a.test')).toHaveLength(2);
    expect(fixture.edges[0]!.source).toBe(fixture.root.id);
    expect(fixture.edges.slice(1).every((edge) => edge.source === fixture.pages[0]!.node.id)).toBe(true);
    expect(searchResponseToFixture(response, options)).toEqual(fixture);
    expect(new Set([...layoutStacks(fixture).values()].map((point) => point.stack)).size).toBe(3);
    const session = new CrawlSession();
    try {
      session.prepareExternalRun(options); session.enqueue(fixtureEvents(fixture, options)); session.flush();
      expect(visitedHistory(session.getSnapshot())).toHaveLength(3);
      expect(session.getSnapshot().stats.totalNodes).toBe(4);
    } finally { session.dispose(); }
  });
  it('accepts empty and partial responses without padding with mock documents', () => {
    const fixture = searchResponseToFixture(parseSearchResponse({ good: [], awesome: {} }), options);
    expect(fixture.pages).toEqual([]);
    expect(fixtureEvents(fixture, options).at(-1)).toMatchObject({ type: 'RUN_COMPLETE', stats: { totalNodes: 1 } });
  });
  it('rejects old awesome arrays and unsafe document URLs', () => {
    expect(() => parseSearchResponse({ good: [], awesome: [] })).toThrow();
    expect(() => parseSearchResponse({ good: [result('javascript:alert(1)')], awesome: {} })).toThrow();
  });
  it('requests the specified 10 + 8 × 1 counts and forwards cancellation', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ good: [], awesome: {} })));
    const controller = new AbortController();
    await fetchSearchFixture('http://localhost:8000', options, controller.signal, fetcher as typeof fetch);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const request = new URL(url);
    expect(request.pathname).toBe('/search');
    expect(Object.fromEntries(request.searchParams)).toEqual({ query: options.query, goodCount: '10', awesomeQueryCount: '4', awesomeCount: '2' });
    expect(init.signal).toBe(controller.signal);
  });
  it('reports HTTP errors without substituting mock results', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 502 }));
    await expect(fetchSearchFixture('http://localhost:8000/search', options, new AbortController().signal, fetcher as typeof fetch)).rejects.toThrow('502');
  });
});
