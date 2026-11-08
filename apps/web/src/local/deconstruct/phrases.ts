/**
 * 원본 apps/deconstruct/src/refine/phrases.js의 브라우저 판. 분해 조각 하나를 검색어로 쓸 만한 구절로 다시 나눈다.
 * LLM 응답에서 원문에 실제로 있는 부분만 통과시키므로, 검색어로 나갈 수 있는 것은 원문의 일부뿐이다.
 */
import { toWeight } from './weights.js';
import type { Embedder } from './embed.ts';
import type { PhraseFinder } from './llm-finders.ts';

const CACHE_SIZE = 500;
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();

/** 원문에 없는 글자, 원문 전체와 같은 구절, 앞 구절과 겹치거나 순서가 어긋난 구절을 걸러 낸다. */
export function keepSourcePhrases(phrases: unknown[], text: string, limit: number): string[] {
  const source = compact(text);
  const kept: string[] = [];
  let cursor = 0;
  for (const raw of phrases) {
    if (typeof raw !== 'string') continue;
    const phrase = compact(raw);
    if (Array.from(phrase).length < 2 || phrase === source) continue;
    const at = source.indexOf(phrase, cursor);
    if (at < 0) continue;
    kept.push(phrase);
    cursor = at + phrase.length;
    if (kept.length === limit) break;
  }
  return kept;
}

/** LLM이 없거나 실패할 때의 대체 경로. 문장 부호로 나누고, 한 덩어리면 낱말로 나눈다. */
export function rulePhrases(text: string, limit: number): string[] {
  const source = compact(text);
  const clauses = source.split(/[,.;:!?·|/()[\]{}<>「」『』“”"]+/u).map(compact).filter(Boolean);
  const pieces = clauses.length > 1 ? clauses : source.split(' ');
  return keepSourcePhrases(pieces, source, limit);
}

/** 조각과 같은 척도의 검색어 유사도. 임베딩이 실패해도 구절 자체는 돌려준다. */
export async function phraseSimilarities(phrases: string[], query: string | undefined, target: Embedder | null): Promise<number[] | undefined> {
  const term = query?.trim();
  if (!term || !target || !phrases.length) return undefined;
  try {
    const [queryVector, ...vectors] = await target.embed([term, ...phrases]);
    return vectors.map((vector) => toWeight(vector.reduce((sum, value, k) => sum + value * queryVector![k]!, 0)));
  } catch {
    return undefined;
  }
}

export interface PhraseResult { phrases: string[]; source: 'llm' | 'rule' }

export function createPhraseRefiner({ finder = null, limit = 8 }: { finder?: PhraseFinder | null; limit?: number } = {}) {
  const cache = new Map<string, PhraseResult>();
  return async function refine(rawText: string, signal?: AbortSignal): Promise<PhraseResult> {
    const text = compact(rawText);
    const key = `${finder?.cacheKey}\0${text}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let result: PhraseResult | null = null;
    if (finder) {
      try {
        const phrases = keepSourcePhrases((await finder.find(text, signal)).phrases, text, limit);
        if (phrases.length) result = { phrases, source: 'llm' };
      } catch (error) {
        if (signal?.aborted) throw error;
        // 호출 실패는 규칙 분할로 이어 가므로 요청을 실패시키지 않는다.
      }
    }
    result ??= { phrases: rulePhrases(text, limit), source: 'rule' };
    if (result.source === 'llm') {
      cache.set(key, result);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    }
    return result;
  };
}
