/**
 * 브라우저 안의 "가짜 서버". 프론트엔드가 원래 서버로 보내던 같은 출처 요청
 * (/search, /deconstruct, /deconstruct/phrases, /preview)을 window.fetch에서 가로채 이 탭 안에서 처리하고,
 * 원본 API와 같은 모양의 JSON Response를 돌려준다. 그래서 프론트엔드의 파서와 화면 코드는 고치지 않는다.
 */
import { LocalApiError, errors } from './errors.ts';
import { inspectPreview } from './preview.ts';
import { search } from './web-search.ts';
import { deconstruct, refinePhrases } from './deconstruct/pipeline.ts';
import { PROGRESS_EVENT } from './events.ts';

const COUNT_PARAMETERS = {
  goodCount: { defaultValue: 30, max: 100 },
  awesomeCount: { defaultValue: 3, max: 100 },
  awesomeQueryCount: { defaultValue: 10, max: 20 },
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function progress(message: string) {
  window.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail: message }));
}

async function handleSearch(url: URL, signal?: AbortSignal): Promise<Response> {
  const query = url.searchParams.get('query')?.trim();
  if (!query) return json(400, { error: 'query is required' });
  const counts: Record<string, number> = {};
  for (const [name, { defaultValue, max }] of Object.entries(COUNT_PARAMETERS)) {
    const raw = url.searchParams.get(name);
    if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) > max)) return json(400, { error: `${name} must be an integer from 0 to ${max}` });
    counts[name] = raw === null ? defaultValue : Number(raw);
  }
  const result = await search(query, {
    goodCount: counts.goodCount!,
    awesomeCount: counts.awesomeCount!,
    awesomeQueryCount: counts.awesomeQueryCount!,
    awesomeDirection: url.searchParams.get('awesomeDirection') ?? '',
    signal,
    onProgress: progress,
  });
  return json(200, result);
}

async function handleDeconstruct(url: URL, signal?: AbortSignal): Promise<Response> {
  const target = url.searchParams.get('url');
  if (!target) throw errors.invalidUrl();
  const query = Array.from(url.searchParams.get('query') ?? '').slice(0, 200).join('');
  return json(200, await deconstruct(target, { query, signal, onProgress: progress }));
}

async function handlePhrases(url: URL, signal?: AbortSignal): Promise<Response> {
  const text = url.searchParams.get('text') ?? '';
  if (!text.trim() || text.length > 1000) throw errors.invalidText();
  return json(200, await refinePhrases(text, url.searchParams.get('query') ?? '', signal));
}

async function handlePreview(url: URL, signal?: AbortSignal): Promise<Response> {
  const target = url.searchParams.get('url')?.trim();
  if (!target) return json(400, { error: 'url is required' });
  return json(200, await inspectPreview(target, signal));
}

const ROUTES: Record<string, (url: URL, signal?: AbortSignal) => Promise<Response>> = {
  '/search': handleSearch,
  '/deconstruct': handleDeconstruct,
  '/deconstruct/phrases': handlePhrases,
  '/preview': handlePreview,
};

/** 가로챌 요청이면 처리 함수를, 아니면 null을 돌려준다. */
export function matchLocalRoute(input: RequestInfo | URL, origin = location.origin) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const path = url.pathname.replace(/\/$/, '') || '/';
  return Object.hasOwn(ROUTES, path) ? { url, handler: ROUTES[path]! } : null;
}

export async function handleLocalRequest(route: NonNullable<ReturnType<typeof matchLocalRoute>>, signal?: AbortSignal | null): Promise<Response> {
  try {
    return await route.handler(route.url, signal ?? undefined);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof LocalApiError) return json(error.status, { error: { code: error.code, message: error.message } });
    console.error('[local] 처리 실패', route.url.pathname, error);
    return json(502, { error: route.url.pathname === '/search' ? 'Local search failed' : { code: 'INTERNAL', message: String(error) } });
  }
}

let installed = false;

export function installLocalBackend(): void {
  if (installed) return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const route = matchLocalRoute(input);
    if (!route) return nativeFetch(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return handleLocalRequest(route, signal);
  };
}
