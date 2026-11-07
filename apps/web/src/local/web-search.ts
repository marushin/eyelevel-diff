/**
 * 원본 apps/api/server.js의 search()를 브라우저로 옮겼다. SerpApi 대신 Bing 검색 결과 HTML을 읽고,
 * Bing이 결과를 주지 않으면 DuckDuckGo HTML 판으로 넘어간다. 응답 형태(good / awesome)는 원본 API와 같다.
 */
import { fetchRemote } from './remote-fetch.ts';
import { generateQueries } from './queries.ts';

export interface SearchResult { url: string; title: string; description: string; image: string; rank: number }
export interface SearchResponse { good: SearchResult[]; awesome: Record<string, { rank: number; results: SearchResult[] }> }
type Engine = 'bing' | 'duckduckgo';
interface Row { url: string; title: string; description: string; image: string }

const PAGE_SIZE = 10;
const MAX_PAGES = 3;

function webUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Bing 결과 링크(/ck/a?...&u=a1<base64url>)에서 실제 주소를 꺼낸다. */
export function unwrapBingUrl(raw: string): string | null {
  try {
    const url = new URL(raw, 'https://www.bing.com');
    if (url.hostname.endsWith('bing.com') && url.pathname.startsWith('/ck/')) {
      const encoded = url.searchParams.get('u');
      if (!encoded?.startsWith('a1')) return null;
      const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
      return webUrl(new TextDecoder().decode(bytes));
    }
    return webUrl(url.href);
  } catch {
    return null;
  }
}

/** DuckDuckGo 결과 링크(//duckduckgo.com/l/?uddg=...)에서 실제 주소를 꺼낸다. */
export function unwrapDuckDuckGoUrl(raw: string): string | null {
  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname.startsWith('/l/')) return webUrl(url.searchParams.get('uddg'));
    if (url.hostname.endsWith('duckduckgo.com')) return null; // 광고와 내부 링크
    return webUrl(url.href);
  } catch {
    return null;
  }
}

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** "2일 전 · ", "2024년 6월 10일 · " 같은 날짜 머리를 뗀다. */
export function stripDatePrefix(snippet: string): string {
  return snippet.replace(/^[^·]{1,24}\s·\s+/, '');
}

export function parseBing(doc: Document): Row[] {
  const rows: Row[] = [];
  for (const item of Array.from(doc.querySelectorAll('#b_results > li.b_algo'))) {
    const anchor = item.querySelector('h2 a');
    const url = unwrapBingUrl(anchor?.getAttribute('href') ?? '');
    if (!url) continue;
    const snippet = item.querySelector('.b_caption p, p[class*="b_lineclamp"], .b_algoSlug, .b_snippet');
    const thumbnail = Array.from(item.querySelectorAll('img')).find((img) => {
      const width = Number(img.getAttribute('width') ?? 0);
      return width >= 60 || /[?&]w=(?:[6-9]\d|\d{3,})/.test(img.getAttribute('src') ?? '');
    });
    const image = thumbnail ? webUrl(new URL(thumbnail.getAttribute('src') ?? '', 'https://www.bing.com').href) ?? '' : '';
    rows.push({ url, title: text(anchor), description: stripDatePrefix(text(snippet)), image });
  }
  return rows;
}

export function parseDuckDuckGo(doc: Document): Row[] {
  const rows: Row[] = [];
  for (const item of Array.from(doc.querySelectorAll('.result'))) {
    if (item.classList.contains('result--ad')) continue;
    const anchor = item.querySelector('a.result__a');
    const url = unwrapDuckDuckGoUrl(anchor?.getAttribute('href') ?? '');
    if (!url) continue;
    rows.push({ url, title: text(anchor), description: text(item.querySelector('.result__snippet')), image: '' });
  }
  return rows;
}

function engineUrl(engine: Engine, query: string, page: number): string {
  if (engine === 'bing') {
    const params = new URLSearchParams({ q: query, setlang: 'ko', cc: 'KR', mkt: 'ko-KR' });
    if (page > 1) params.set('first', String((page - 1) * PAGE_SIZE + 1));
    return `https://www.bing.com/search?${params}`;
  }
  const params = new URLSearchParams({ q: query, kl: 'kr-kr' });
  if (page > 1) params.set('s', String((page - 1) * PAGE_SIZE));
  return `https://html.duckduckgo.com/html/?${params}`;
}

async function fetchEnginePage(engine: Engine, query: string, page: number, signal: AbortSignal): Promise<Row[]> {
  const doc = await fetchRemote(engineUrl(engine, query, page), { signal, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
  if (!doc.ok) throw new Error(`${engine} HTTP ${doc.status}`);
  const parsed = new DOMParser().parseFromString(doc.html, 'text/html');
  return engine === 'bing' ? parseBing(parsed) : parseDuckDuckGo(parsed);
}

function limitConcurrency(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** 한 검색어의 결과를 count개까지 모은다. 엔진 하나가 비거나 실패하면 다음 엔진을 쓴다. */
async function collect(query: string, count: number, run: ReturnType<typeof limitConcurrency>, signal: AbortSignal): Promise<SearchResult[]> {
  for (const engine of ['bing', 'duckduckgo'] as const) {
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    try {
      for (let page = 1; page <= MAX_PAGES && results.length < count; page += 1) {
        const rows = await run(() => fetchEnginePage(engine, query, page, signal));
        signal.throwIfAborted();
        if (!rows.length) break;
        rows.forEach((row, index) => {
          if (results.length >= count || seen.has(row.url)) return;
          seen.add(row.url);
          results.push({ ...row, rank: (page - 1) * PAGE_SIZE + index + 1 });
        });
      }
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(`[local] ${engine} 검색 실패: ${query}`, error);
    }
    if (results.length) return results;
  }
  return [];
}

export interface SearchOptions {
  goodCount: number;
  awesomeCount: number;
  awesomeQueryCount: number;
  awesomeDirection?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

/** 원본처럼 제한 시간이 지나면 그때까지 모은 결과로 끝낸다. */
export async function search(query: string, options: SearchOptions): Promise<SearchResponse> {
  const { goodCount, awesomeCount, awesomeQueryCount, awesomeDirection = '', timeoutMs = 110_000, onProgress } = options;
  const result: SearchResponse = { good: [], awesome: {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const run = limitConcurrency(5);

  const good = goodCount > 0 ? collect(query, goodCount, run, signal).then((rows) => { result.good = rows; }) : Promise.resolve();
  const awesome = (async () => {
    if (awesomeCount <= 0 || awesomeQueryCount <= 0) return;
    onProgress?.('Gemini Nano가 검색어를 비트는 중');
    const generated = await generateQueries(query, awesomeQueryCount, awesomeDirection, signal);
    console.info(`[local] 재해석 검색어(${generated.source}) ${generated.direction}`, generated.queries);
    result.awesome = Object.fromEntries(generated.queries.map((value, index) => [value, { rank: index + 1, results: [] as SearchResult[] }]));
    onProgress?.('검색 결과를 모으는 중');
    await Promise.all(generated.queries.map(async (value) => {
      result.awesome[value]!.results = await collect(value, awesomeCount, run, signal);
    }));
  })();

  try {
    await Promise.all([good, awesome]);
  } catch (error) {
    if (options.signal?.aborted || !controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  return result;
}
