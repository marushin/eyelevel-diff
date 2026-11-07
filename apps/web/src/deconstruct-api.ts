export interface DeconstructContent { type: 'text' | 'img'; content: string; label?: string }
export type DeconstructWeight = [number, number, number];
export interface DeconstructResponse { contents: DeconstructContent[]; weights: DeconstructWeight[]; querySimilarities?: number[] }

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_URL: '분해할 수 없는 주소입니다.',
  BLOCKED_URL: '보안 정책상 열 수 없는 주소입니다.',
  PAGE_TOO_LARGE: '페이지가 너무 커서 분해하지 못했습니다.',
  UNSUPPORTED_CONTENT: 'PDF처럼 웹페이지가 아닌 문서는 분해할 수 없습니다.',
  EMPTY_CONTENT: '이 페이지에서 꺼낼 텍스트나 이미지가 없습니다.',
  DNS_FAILED: '사이트 주소를 찾지 못했습니다.',
  FETCH_FAILED: '사이트에 접속하지 못했습니다.',
  UPSTREAM_STATUS: '사이트가 페이지를 내주지 않았습니다.',
  BUSY: '분해 요청이 밀려 있습니다. 잠시 후 다시 시도해주세요.',
  EMBEDDING_FAILED: '의미 계산에 실패했습니다. 잠시 후 다시 시도해주세요.',
  PAGE_TIMEOUT: '페이지를 여는 데 시간이 너무 오래 걸렸습니다.',
  DECONSTRUCT_UNAVAILABLE: '분해 서버에 연결하지 못했습니다.',
  INVALID_TEXT: '나눌 글을 확인해주세요.',
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rejects malformed bodies instead of drawing an invented structure from them. */
export function parseDeconstructResponse(value: unknown): DeconstructResponse {
  if (!record(value) || !Array.isArray(value.contents) || !Array.isArray(value.weights)) {
    throw new Error('분해 응답 형식이 API 명세와 다릅니다');
  }
  const contents = value.contents.map((item): DeconstructContent => {
    if (!record(item) || (item.type !== 'text' && item.type !== 'img') || typeof item.content !== 'string') {
      throw new Error('분해 조각의 필드가 API 명세와 다릅니다');
    }
    if (item.label !== undefined && typeof item.label !== 'string') throw new Error('분해 조각의 필드가 API 명세와 다릅니다');
    return { type: item.type, content: item.content, ...(item.label ? { label: item.label } : {}) };
  });
  const weights = value.weights.map((item): DeconstructWeight => {
    if (!Array.isArray(item) || item.length !== 3) throw new Error('분해 가중치 형식이 API 명세와 다릅니다');
    const [i, j, weight] = item as unknown[];
    if (!Number.isInteger(i) || !Number.isInteger(j) || typeof weight !== 'number' ||
      (i as number) < 0 || (j as number) >= contents.length || (i as number) >= (j as number) || weight < 0 || weight > 1) {
      throw new Error('분해 가중치 값이 API 명세와 다릅니다');
    }
    return [i as number, j as number, weight];
  });
  if (value.querySimilarities === undefined) return { contents, weights };
  const similarities = value.querySimilarities;
  if (!Array.isArray(similarities) || similarities.length !== contents.length ||
    similarities.some((item) => typeof item !== 'number' || item < 0 || item > 1)) {
    throw new Error('검색어 유사도 값이 API 명세와 다릅니다');
  }
  return { contents, weights, querySimilarities: similarities as number[] };
}

export function isWebImage(value: string): boolean {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}

const QUERY_LIMIT = 200;

export async function fetchDeconstruct(endpoint: string, pageUrl: string, searchQuery: string, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<DeconstructResponse> {
  const url = new URL(endpoint, typeof location === 'undefined' ? 'http://localhost' : location.origin);
  const term = Array.from(searchQuery.trim()).slice(0, QUERY_LIMIT).join('');
  url.search = new URLSearchParams({ url: pageUrl, ...(term ? { query: term } : {}) }).toString();
  const response = await fetchImpl(url.href, { method: 'GET', signal, headers: { Accept: 'application/json' } });
  // A stopped service reaches us as a proxy error page, not as the API's JSON error shape.
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = record(body) && record(body.error) && typeof body.error.code === 'string' ? body.error.code : '';
    throw new Error(ERROR_MESSAGES[code] ?? (code ? `분해에 실패했습니다 (${code})` : ERROR_MESSAGES.DECONSTRUCT_UNAVAILABLE));
  }
  return parseDeconstructResponse(body);
}

export interface PhraseResult { phrases: string[]; source: 'llm' | 'rule'; querySimilarities?: number[] }

const PHRASE_TEXT_LIMIT = 1000;

export function parsePhraseResult(value: unknown): PhraseResult {
  if (!record(value) || !Array.isArray(value.phrases) || !value.phrases.every((item) => typeof item === 'string') ||
    (value.source !== 'llm' && value.source !== 'rule')) {
    throw new Error('구절 응답 형식이 API 명세와 다릅니다');
  }
  const similarities = value.querySimilarities;
  if (similarities === undefined) return { phrases: value.phrases as string[], source: value.source };
  if (!Array.isArray(similarities) || similarities.length !== value.phrases.length ||
    similarities.some((item) => typeof item !== 'number' || item < 0 || item > 1)) {
    throw new Error('구절 유사도 값이 API 명세와 다릅니다');
  }
  return { phrases: value.phrases as string[], source: value.source, querySimilarities: similarities as number[] };
}

export async function fetchPhrases(endpoint: string, text: string, searchQuery: string, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<PhraseResult> {
  const url = new URL(`${endpoint.replace(/\/$/, '')}/phrases`, typeof location === 'undefined' ? 'http://localhost' : location.origin);
  const term = Array.from(searchQuery.trim()).slice(0, QUERY_LIMIT).join('');
  url.search = new URLSearchParams({ text: Array.from(text).slice(0, PHRASE_TEXT_LIMIT).join(''), ...(term ? { query: term } : {}) }).toString();
  const response = await fetchImpl(url.href, { method: 'GET', signal, headers: { Accept: 'application/json' } });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = record(body) && record(body.error) && typeof body.error.code === 'string' ? body.error.code : '';
    throw new Error(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.DECONSTRUCT_UNAVAILABLE);
  }
  return parsePhraseResult(body);
}
