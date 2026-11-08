/**
 * 한국어 검색어는 한국어로 이어져야 한다. Nano 경로는 번역(한→영→Nano→영→한)을 거치고,
 * 어느 연결이든 한글이 없는 검색어는 버린 뒤 모자란 만큼 대체 검색어로 채운다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_QUERIES } from '../directions.ts';
import { llm } from '../llm.ts';
import { nano } from '../nano.ts';
import { fillWithFallback, generateQueries } from '../queries.ts';
import { isKoreanText, resetTranslators } from '../translate.ts';

const DIRECTION_INDEX = 1;
const DIRECTION = '원문을 고고학 유물처럼 바라보라'; // 목록에 없는 방향은 0번 대체 검색어와 짝

function stubTranslator(table: Record<string, string>, available = true) {
  const created: string[] = [];
  vi.stubGlobal('Translator', {
    availability: vi.fn(async () => (available ? 'available' : 'downloadable')),
    create: vi.fn(async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
      created.push(`${sourceLanguage}>${targetLanguage}`);
      return { translate: async (text: string) => table[text] ?? text };
    }),
  });
  return created;
}

afterEach(() => {
  resetTranslators();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('한국어 판별', () => {
  it('한글이 있고 가나가 없어야 한국어 검색어다', () => {
    expect(isKoreanText('토기')).toBe(true);
    expect(isKoreanText('고구마 전래(甘藷)')).toBe(true);
    expect(isKoreanText('土器')).toBe(false);
    expect(isKoreanText('炭焼き')).toBe(false);
    expect(isKoreanText('고구마 やきいも')).toBe(false);
    expect(isKoreanText('sweet potato')).toBe(false);
  });

  it('모자란 개수는 그 방향의 대체 검색어로, 겹치지 않게 채운다', () => {
    const own = FALLBACK_QUERIES[DIRECTION_INDEX]!;
    expect(fillWithFallback(['토기', own[0]!], DIRECTION_INDEX, 4, '고구마')).toEqual(['토기', own[0], own[1], own[2]]);
  });
});

describe('Gemini Nano + 한국어 검색어', () => {
  it('한→영으로 묻고 영어로 받아 영→한으로 옮긴다', async () => {
    const created = stubTranslator({ 고구마: 'sweet potato', [DIRECTION]: 'see it as an artifact', pottery: '토기', charcoal: '숯', 'bone tools': '골각기', excavation: '발굴 조사' });
    vi.spyOn(nano, 'status').mockResolvedValue('ready');
    const prompt = vi.spyOn(nano, 'promptJson').mockResolvedValue({ queries: ['pottery', 'charcoal', 'bone tools', 'excavation'] });

    const result = await generateQueries('고구마', 4, DIRECTION);
    expect(result).toMatchObject({ queries: ['토기', '숯', '골각기', '발굴 조사'], source: 'gemini-nano+translate' });
    const [system, input] = prompt.mock.calls[0]!;
    expect(system).toContain('Write every query in English');
    expect(system).not.toContain('same language');
    expect(JSON.parse(String(input))).toEqual({ query: 'sweet potato', direction: 'see it as an artifact', count: 4 });
    expect(created).toEqual(expect.arrayContaining(['ko>en', 'en>ko']));
  });

  it('번역되지 않은 일본어·한자 검색어는 버리고 대체 검색어로 채운다', async () => {
    stubTranslator({ pottery: '토기' }); // 土器, 炭焼き는 번역기가 그대로 돌려준다
    vi.spyOn(nano, 'status').mockResolvedValue('ready');
    vi.spyOn(nano, 'promptJson').mockResolvedValue({ queries: ['pottery', '土器', '炭焼き', '発掘調査'] });

    const result = await generateQueries('고구마', 4, DIRECTION);
    expect(result.queries).toHaveLength(4);
    expect(result.queries[0]).toBe('토기');
    expect(result.queries.every(isKoreanText)).toBe(true);
    expect(result.source).toBe('gemini-nano+translate+fallback');
  });

  it('영→한 번역기가 없으면 Nano를 부르지 않고 한국어 대체 검색어를 쓴다', async () => {
    stubTranslator({}, false);
    vi.spyOn(nano, 'status').mockResolvedValue('ready');
    const prompt = vi.spyOn(nano, 'promptJson');
    const result = await generateQueries('고구마', 4, DIRECTION);
    expect(prompt).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback');
    expect(result.queries.every(isKoreanText)).toBe(true);
  });

  it('영어 검색어는 번역 없이 같은 언어로 묻는다', async () => {
    vi.spyOn(nano, 'status').mockResolvedValue('ready');
    const prompt = vi.spyOn(nano, 'promptJson').mockResolvedValue({ queries: ['a b', 'c d', 'e f', 'g h'] });
    const result = await generateQueries('sweet potato', 4, DIRECTION);
    expect(result).toMatchObject({ queries: ['a b', 'c d', 'e f', 'g h'], source: 'gemini-nano' });
    expect(prompt.mock.calls[0]![0]).toContain('same language');
  });
});

describe('API 연결 + 한국어 검색어', () => {
  it('번역 없이 한국어로 받고, 한글이 없는 검색어만 대체 검색어로 바꾼다', async () => {
    const original = llm.settings;
    llm.update({ provider: 'claude', claude: { apiKey: 'k' } });
    try {
      const prompt = vi.spyOn(llm, 'promptJson').mockResolvedValue({ queries: ['토기', 'charcoal', '골각기', '발굴 조사'] });
      const result = await generateQueries('고구마', 4, DIRECTION);
      expect(prompt.mock.calls[0]![0]).toContain('same language');
      expect(result.queries.slice(0, 3)).toEqual(['토기', '골각기', '발굴 조사']);
      expect(result.queries.every(isKoreanText)).toBe(true);
      expect(result.source).toBe('claude:claude-opus-5-5+fallback');
    } finally {
      llm.update({ provider: original.provider, claude: original.claude });
    }
  });
});
