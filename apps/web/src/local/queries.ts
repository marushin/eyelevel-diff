/**
 * 원본 apps/api/llm.js의 검색어 생성을 Gemini Nano로 옮겼다. 지시문과 검증 규칙은 원본을 따른다.
 * 원본은 잘못된 응답에 502를 돌려줬지만, Nano는 훨씬 작은 모델이라 한 번 다시 묻고
 * 그래도 안 되면 방향별 대체 검색어로 이어 간다.
 */
import { AWESOME_DIRECTIONS, FALLBACK_QUERIES } from './directions.ts';
import { nano } from './nano.ts';
import { hasHangul, toKorean } from './translate.ts';

export const QUERY_INSTRUCTIONS = [
  'Generate exactly count distinct Google search queries using the supplied original query and reinterpretation direction.',
  'Each query must be a single word or a compact noun phrase, typically 1-4 words. Use only the minimum keywords needed to identify the concept.',
  'Do not write full sentences, questions, descriptions, relative clauses, or a rationale inside a query.',
  'Your priority is bold, surprising discovery: find ideas the user would be unlikely to encounter by searching the original query directly.',
  'Use the direction as a launch point for exploration, not a boundary that keeps every query in the original topic.',
  'Design the entire sequence to progressively increase conceptual distance from the original query.',
  'The first query should be relatively close to the original, but already introduce an unexpected angle rather than a paraphrase.',
  'Each subsequent query should make a noticeable further leap, not merely replace words or repeat the same theme.',
  'For the middle queries, cross disciplines, mechanisms, materials, scales, eras, or assumptions through unexpected analogies and inversions.',
  'The final query should look almost entirely unrelated at first glance, retaining only a thin, surprising associative thread to the starting idea.',
  'Prefer concrete, searchable concepts, phenomena, materials, methods, and examples over abstract wordplay or slogans.',
  'Use established, real-world terms. Do not invent words.',
  'Write the queries in the same language as the original query.',
  'Do not return the original query, empty strings, or duplicate queries.',
  'Return only the queries in the required JSON structure.',
].join(' ');

export function querySchema(count: number): object {
  return {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: { type: 'string', minLength: 1, maxLength: 40 },
      },
    },
    required: ['queries'],
    additionalProperties: false,
  };
}

/** 원본과 같은 규칙으로 검증하되, 공백 정리와 중복 제거 정도는 고쳐서 받아 준다. */
export function cleanQueries(raw: unknown, original: string, count: number): string[] | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { queries?: unknown }).queries)) return null;
  const seen = new Set<string>([original.trim().toLowerCase()]);
  const queries: string[] = [];
  for (const value of (raw as { queries: unknown[] }).queries) {
    if (typeof value !== 'string') continue;
    const query = value.replace(/^["'“”‘’\s]+|["'“”‘’\s.]+$/g, '').replace(/\s+/g, ' ').trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length === count) break;
  }
  return queries.length === count ? queries : null;
}

export function pickDirection(direction = ''): { text: string; index: number } {
  const trimmed = direction.trim();
  if (trimmed) return { text: trimmed, index: Math.max(0, AWESOME_DIRECTIONS.indexOf(trimmed)) };
  const index = Math.floor(Math.random() * AWESOME_DIRECTIONS.length);
  return { text: AWESOME_DIRECTIONS[index]!, index };
}

export function fallbackQueries(directionIndex: number, count: number): string[] {
  return (FALLBACK_QUERIES[directionIndex] ?? FALLBACK_QUERIES[0]!).slice(0, count);
}

export interface GeneratedQueries { queries: string[]; source: 'gemini-nano' | 'fallback'; direction: string }

export async function generateQueries(query: string, count: number, direction: string, signal?: AbortSignal): Promise<GeneratedQueries> {
  const picked = pickDirection(direction);
  const input = JSON.stringify({ query, direction: picked.text, count });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await nano.promptJson<unknown>(QUERY_INSTRUCTIONS, input, querySchema(count), { signal, timeoutMs: 45_000 });
      let queries = cleanQueries(raw, query, count);
      // Nano는 공식 출력 언어가 영어라 한국어 검색어에도 영어로 답하곤 한다. 원문이 한국어면 옮겨 준다.
      if (queries && hasHangul(query)) queries = cleanQueries({ queries: await toKorean(queries, signal) }, query, count) ?? queries;
      if (queries) return { queries, source: 'gemini-nano', direction: picked.text };
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn('[local] 검색어 생성 실패', error);
      if (!(error instanceof SyntaxError)) break; // 모델을 쓸 수 없는 상태면 재시도해도 같다.
    }
  }
  return { queries: fallbackQueries(picked.index, count), source: 'fallback', direction: picked.text };
}
