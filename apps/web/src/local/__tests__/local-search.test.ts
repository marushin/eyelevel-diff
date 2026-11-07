// @vitest-environment happy-dom
/**
 * 지운 tests/search-integration.test.ts(HTTP 서버 경유)를 대신한다. 프론트엔드의 fetchSearchFixture가
 * 브라우저 안 백엔드를 거쳐 카드 데이터를 만들 때 개수와 순위가 유지되는지 확인한다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSearchFixture } from '../../search-api.ts';
import { handleLocalRequest, matchLocalRoute } from '../install.ts';
import { nano } from '../nano.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const b64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function bingPage(query: string, first: number): string {
  const items = Array.from({ length: 10 }, (_, index) => {
    const url = `https://example.com/${encodeURIComponent(query)}/${first + index}`;
    return `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&u=a1${b64url(url)}">${query} 문서 ${first + index}</a></h2><div class="b_caption"><p>설명</p></div></li>`;
  }).join('');
  return `<html><body><ol id="b_results">${items}</ol></body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('브라우저 안 백엔드를 거친 카드 스택', () => {
  it('프로토타입 개수로 검색하고 순위를 잃지 않는다', async () => {
    const searched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname !== 'www.bing.com') throw new TypeError('unexpected request');
      const query = url.searchParams.get('q')!;
      searched.push(query);
      return new Response(bingPage(query, Number(url.searchParams.get('first') ?? 1)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }));
    const prompt = vi.spyOn(nano, 'promptJson').mockImplementation(async (_system, input) => {
      expect(JSON.parse(String(input))).toMatchObject({ query: '고구마', count: 4 });
      return { queries: ['군밤', '전투식량', '봉수대', '종자 저장고'] };
    });
    vi.spyOn(nano, 'status').mockResolvedValue('ready');

    const localFetch = ((input: RequestInfo | URL) => handleLocalRequest(matchLocalRoute(input, ORIGIN)!)) as typeof fetch;
    const fixture = await fetchSearchFixture(`${ORIGIN}/search`, { query: '고구마', seed: 1 } as never, new AbortController().signal, localFetch);

    expect(prompt).toHaveBeenCalledOnce();
    type Raw = { searchQuery: string; documentRank: number; queryRank: number };
    const raw = (page: (typeof fixture.pages)[number]) => page.node.raw as Raw;
    const original = fixture.pages.filter((page) => page.group === 'original');
    const drift = fixture.pages.filter((page) => page.group === 'drift');
    expect(original.length).toBeGreaterThan(0);
    expect(drift.map((page) => raw(page).searchQuery)).toEqual(expect.arrayContaining(['군밤', '전투식량', '봉수대', '종자 저장고']));
    // 원본 검색은 순위대로, 재해석 검색어는 생성 순위(1~4)를 유지한다.
    expect(original.map((page) => raw(page).documentRank)).toEqual(original.map((_, index) => index + 1));
    expect([...new Set(drift.map((page) => raw(page).queryRank))].sort()).toEqual([1, 2, 3, 4]);
    expect(searched).toContain('고구마');
  });

  it('Nano를 쓸 수 없으면 방향별 대체 검색어로 이어 간다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams.get('q')!;
      return new Response(bingPage(query, 1), { headers: { 'content-type': 'text/html' } });
    }));
    const response = await handleLocalRequest(matchLocalRoute('/search?query=고구마&goodCount=3&awesomeQueryCount=4&awesomeCount=2&awesomeDirection=' +
      encodeURIComponent('원문을 미생물·세포·분자 수준으로 축소해 바라보고, 작은 규모에서만 드러나는 원리로 도약하라.'), ORIGIN)!);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.good).toHaveLength(3);
    expect(Object.keys(body.awesome)).toEqual(['브라운 운동', '모세관 현상', '미세유체 칩', '결정 격자 전위']);
    expect(Object.values(body.awesome).map((group) => (group as { results: unknown[] }).results.length)).toEqual([2, 2, 2, 2]);
  });
});
