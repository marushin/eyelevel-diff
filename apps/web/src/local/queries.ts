/**
 * 원본 apps/api/llm.js의 검색어 생성을 선택한 LLM(기본 Gemini Nano, llm.ts)으로 옮겼다. 지시문과 검증 규칙은 원본을 따른다.
 * 원본은 잘못된 응답에 502를 돌려줬지만, 여기서는 한 번 다시 묻고
 * 그래도 안 되면 방향별 대체 검색어로 이어 간다.
 *
 * 한국어 검색어는 한국어로 이어져야 한다. Nano는 한국어 출력을 지원하지 않아 '같은 언어로' 지시하면
 * 영어·일본어(土器, 炭焼き 등)가 섞여 나왔다. 그래서 Nano로 한국어 검색을 할 때는 번역을 반드시 거친다.
 *
 *   검색어·방향 (한→영, 있으면) → Nano가 영어로 생성 → (영→한, 필수) → 한글만 통과 → 모자라면 대체 검색어
 *
 * 영→한 번역기가 없으면 Nano를 건너뛰고 한국어 대체 검색어를 쓴다. Claude·OpenAI는 한국어로 바로 답하므로
 * 번역 없이 같은 '한글만 통과' 검사만 한다.
 */
import { AWESOME_DIRECTIONS, FALLBACK_QUERIES } from './directions.ts';
import { llm } from './llm.ts';
import { hasHangul, isKoreanText, toEnglish, toKorean, translatorStatus } from './translate.ts';

const SAME_LANGUAGE = 'Write the queries in the same language as the original query.';
const IN_ENGLISH = 'Write every query in English, even if the original query or the direction is in another language.';

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
  SAME_LANGUAGE,
  'Do not return the original query, empty strings, or duplicate queries.',
  'Return only the queries in the required JSON structure.',
].join(' ');

/** Nano + 한국어 경로에서는 영어로 받아 번역한다. */
const ENGLISH_INSTRUCTIONS = QUERY_INSTRUCTIONS.replace(SAME_LANGUAGE, IN_ENGLISH);

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

/** 공백·따옴표를 정리하고 원래 검색어·중복·빈 값을 뺀 목록(최대 count개). */
export function normalizeQueries(raw: unknown, originals: string[], count: number): string[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { queries?: unknown }).queries)) return [];
  const seen = new Set<string>(originals.map((item) => item.trim().toLowerCase()));
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
  return queries;
}

/** 원본과 같은 규칙으로 검증하되, 공백 정리와 중복 제거 정도는 고쳐서 받아 준다. 개수가 모자라면 null. */
export function cleanQueries(raw: unknown, original: string, count: number): string[] | null {
  const queries = normalizeQueries(raw, [original], count);
  return queries.length === count ? queries : null;
}

/** 모자란 개수를 그 방향의 대체 검색어로 채운다(겹치는 것은 건너뜀). */
export function fillWithFallback(queries: string[], directionIndex: number, count: number, original: string): string[] {
  const seen = new Set([original, ...queries].map((item) => item.trim().toLowerCase()));
  const filled = [...queries];
  for (const candidate of FALLBACK_QUERIES[directionIndex] ?? FALLBACK_QUERIES[0]!) {
    if (filled.length >= count) break;
    if (seen.has(candidate.toLowerCase())) continue;
    seen.add(candidate.toLowerCase());
    filled.push(candidate);
  }
  return filled.slice(0, count);
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

/**
 * source는 검색어를 만든 경로: 연결 이름(llm.cacheTag, 예: gemini-nano, claude:claude-opus-5-5)에
 * 번역을 거쳤으면 '+translate', 대체 검색어로 채웠으면 '+fallback'이 붙는다. 전부 대체 검색어면 'fallback'.
 */
export interface GeneratedQueries { queries: string[]; source: string; direction: string }

export async function generateQueries(query: string, count: number, direction: string, signal?: AbortSignal): Promise<GeneratedQueries> {
  const picked = pickDirection(direction);
  const fallback = (reason: string): GeneratedQueries => {
    if (reason) console.warn(`[local] 검색어 생성: ${reason} → 대체 검색어 사용`);
    return { queries: fallbackQueries(picked.index, count), source: 'fallback', direction: picked.text };
  };
  const korean = hasHangul(query);
  const viaTranslation = korean && llm.needsTranslation;
  if (viaTranslation && (await translatorStatus()) !== 'ready') {
    return fallback('Gemini Nano로 한국어 검색어를 만들려면 번역 모델(영→한)이 필요합니다');
  }

  // Nano + 한국어: 입력을 영어로 옮기고(한→영 번역기가 없으면 원문 그대로) 영어로 받는다.
  const [promptQuery, promptDirection] = viaTranslation ? await toEnglish([query, picked.text], signal) : [query, picked.text];
  const input = JSON.stringify({ query: promptQuery, direction: promptDirection, count });
  const instructions = viaTranslation ? ENGLISH_INSTRUCTIONS : QUERY_INSTRUCTIONS;
  const tag = viaTranslation ? `${llm.cacheTag}+translate` : llm.cacheTag;

  let best: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 검색어 비틀기는 창의적인 일이라 다른 단계보다 생각을 더 쓰게 한다(원격 모델만 해당).
      const raw = await llm.promptJson<unknown>(instructions, input, querySchema(count), { signal, timeoutMs: 45_000, effort: 'medium' });
      let queries = normalizeQueries(raw, [query, promptQuery!], count);
      if (viaTranslation) queries = normalizeQueries({ queries: await toKorean(queries, signal) }, [query], count);
      // 한국어 검색어는 한국어로만 이어 간다. 번역이 안 된 영어·일본어·중국어 검색어는 버린다.
      if (korean) queries = queries.filter(isKoreanText);
      if (queries.length === count) return { queries, source: tag, direction: picked.text };
      if (queries.length > best.length) best = queries;
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn('[local] 검색어 생성 실패', error);
      if (!(error instanceof SyntaxError)) break; // 모델을 쓸 수 없는 상태면 재시도해도 같다.
    }
  }
  if (!best.length) return fallback('');
  return { queries: fillWithFallback(best, picked.index, count, query), source: `${tag}+fallback`, direction: picked.text };
}
