import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createSearchServer } from '../apps/api/server.js';
import { fetchSearchFixture } from '../apps/web/src/search-api.ts';

describe('card stack through the HTTP API', () => {
  it('uses the prototype counts and maps live HTTP results without losing ranks', async () => {
    const serpQueries: string[] = [];
    const server = createSearchServer({
      apiKey: 'test', anthropicApiKey: 'test',
      fetchImpl: async (input: URL, init: RequestInit) => {
        const url = new URL(input);
        if (url.hostname === 'api.anthropic.com') {
          const body = JSON.parse(init.body as string);
          expect(JSON.parse(body.messages[0].content).count).toBe(4);
          return Response.json({ type: 'message', stop_reason: 'end_turn', content: [
            { type: 'text', text: JSON.stringify({ queries: ['도약1', '도약2', '도약3', '도약4'] }) },
          ] });
        }
        const query = url.searchParams.get('q')!;
        serpQueries.push(query);
        return Response.json({ organic_results: Array.from({ length: 12 }, (_, index) => ({
          title: `${query} 문서 ${index + 1}`, snippet: '설명',
          link: `https://example.com/${encodeURIComponent(query)}/${index}`, position: index + 2,
        })) });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number };
      const fixture = await fetchSearchFixture(`http://127.0.0.1:${address.port}/search`,
        { query: '예술', seed: 42 }, new AbortController().signal);
      expect(fixture.source).toBe('api');
      expect(fixture.pages.filter(page => page.group === 'original')).toHaveLength(10);
      expect(fixture.pages.filter(page => page.group === 'drift')).toHaveLength(8);
      expect(fixture.pages.slice(10).map(page => page.relevanceLevel)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
      expect(fixture.pages[0].node.raw).toMatchObject({ documentRank: 2, searchQuery: '예술' });
      expect(fixture.pages[10].node.raw).toMatchObject({ documentRank: 2, queryRank: 1, relation: 'simulated-branch' });
      expect(serpQueries.sort()).toEqual(['예술', '도약1', '도약2', '도약3', '도약4'].sort());
    } finally {
      server.close(); server.closeAllConnections();
    }
  });
});
