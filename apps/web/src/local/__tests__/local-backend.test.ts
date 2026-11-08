// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDeconstructResponse, parsePhraseResult } from '../../deconstruct-api.ts';
import { parseSearchResponse } from '../../search-api.ts';
import { AWESOME_DIRECTIONS, FALLBACK_QUERIES } from '../directions.ts';
import { cleanQueries, fallbackQueries, pickDirection, querySchema } from '../queries.ts';
import { parseBing, parseDuckDuckGo, stripDatePrefix, unwrapBingUrl, unwrapDuckDuckGoUrl } from '../web-search.ts';
import { isBlockedByFrameHeaders, resolveNativeEmbedUrl, sanitizeForProxy, extractMetadata } from '../preview.ts';
import { decodeHtml } from '../remote-fetch.ts';
import { NanoEngine, stripFence } from '../nano.ts';
import { toKorean } from '../translate.ts';
import { matchLocalRoute, handleLocalRequest } from '../install.ts';
import { parseInputUrl, prepareHtml } from '../deconstruct/extract.ts';
import { createSegmenter, type BoundaryFinder } from '../deconstruct/segment.ts';
import { isBlankPixels, isMeaningfulText } from '../deconstruct/describe.ts';
import { embeddingInput } from '../deconstruct/embed.ts';
import { createPhraseRefiner, keepSourcePhrases, rulePhrases } from '../deconstruct/phrases.ts';
import { renderBoundaryItems } from '../deconstruct/llm-finders.ts';
import { toPublicContents } from '../deconstruct/pipeline.ts';
import { computeWeights } from '../deconstruct/weights.js';

const b64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html') as unknown as Document;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('검색어 생성', () => {
  it('원본의 20가지 방향과 짝이 맞는 대체 검색어를 갖는다', () => {
    expect(AWESOME_DIRECTIONS).toHaveLength(20);
    expect(FALLBACK_QUERIES).toHaveLength(20);
    for (const row of FALLBACK_QUERIES) expect(row).toHaveLength(4);
    expect(fallbackQueries(3, 4)).toEqual([...FALLBACK_QUERIES[3]!]);
    expect(fallbackQueries(99, 2)).toEqual(FALLBACK_QUERIES[0]!.slice(0, 2));
  });

  it('방향을 주면 그대로, 없으면 20개 중 하나를 고른다', () => {
    expect(pickDirection(AWESOME_DIRECTIONS[5]!)).toEqual({ text: AWESOME_DIRECTIONS[5], index: 5 });
    expect(pickDirection('  직접 쓴 방향  ')).toEqual({ text: '직접 쓴 방향', index: 0 });
    const random = pickDirection('');
    expect(AWESOME_DIRECTIONS[random.index]).toBe(random.text);
  });

  it('정확히 count개만 받고, 원문·중복·빈 값은 걸러 낸다', () => {
    expect(cleanQueries({ queries: [' 군밤 ', '"전투식량"', '고구마', '군밤', '', '봉수대', '종자 저장고'] }, '고구마', 4))
      .toEqual(['군밤', '전투식량', '봉수대', '종자 저장고']);
    expect(cleanQueries({ queries: ['하나', '둘'] }, '고구마', 4)).toBeNull();
    expect(cleanQueries({ nope: [] }, '고구마', 4)).toBeNull();
    expect(cleanQueries(null, '고구마', 4)).toBeNull();
  });

  it('스키마가 개수를 고정한다', () => {
    expect(querySchema(4)).toMatchObject({ properties: { queries: { minItems: 4, maxItems: 4 } } });
  });
});

describe('웹 검색 파싱', () => {
  it('Bing 결과 링크에서 실제 주소를 꺼낸다', () => {
    const target = 'https://namu.wiki/w/%EA%B3%A0%EA%B5%AC%EB%A7%88';
    expect(unwrapBingUrl(`https://www.bing.com/ck/a?!&&p=abc&u=a1${b64url(target)}&ntb=1`)).toBe(target);
    expect(unwrapBingUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(unwrapBingUrl('https://www.bing.com/ck/a?u=zzz')).toBeNull();
    expect(unwrapBingUrl('javascript:alert(1)')).toBeNull();
  });

  it('DuckDuckGo 결과 링크에서 실제 주소를 꺼내고 내부 링크는 버린다', () => {
    expect(unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fko.wikipedia.org%2Fwiki%2FA&rut=1')).toBe('https://ko.wikipedia.org/wiki/A');
    expect(unwrapDuckDuckGoUrl('https://duckduckgo.com/y.js?ad=1')).toBeNull();
  });

  it('스니펫 앞의 날짜를 뗀다', () => {
    expect(stripDatePrefix('2일 전 · 고구마 순도 살짝 데쳐')).toBe('고구마 순도 살짝 데쳐');
    expect(stripDatePrefix('2024년 6월 10일 · 칼슘이 많다')).toBe('칼슘이 많다');
    expect(stripDatePrefix('날짜 없는 설명')).toBe('날짜 없는 설명');
  });

  it('Bing 결과 페이지를 읽는다', () => {
    const doc = parse(`<ol id="b_results">
      <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&u=a1${b64url('https://ko.wikipedia.org/wiki/고구마')}">고구마 - 위키백과</a></h2>
        <div class="b_caption"><p>5일 전 · 고구마는 메꽃과의 여러해살이 식물이다.</p></div><img src="//th.bing.com/th/id/x?w=32&h=32"></li>
      <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&u=bad">깨진 링크</a></h2></li>
      <li class="b_ad"><h2><a href="https://ad.example">광고</a></h2></li>
    </ol>`);
    expect(parseBing(doc)).toEqual([{ url: 'https://ko.wikipedia.org/wiki/%EA%B3%A0%EA%B5%AC%EB%A7%88', title: '고구마 - 위키백과', description: '고구마는 메꽃과의 여러해살이 식물이다.', image: '' }]);
  });

  it('DuckDuckGo 결과 페이지를 읽고 광고를 뺀다', () => {
    const doc = parse(`<div class="result result--ad"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fad.example">광고</a></div>
      <div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnamu.wiki%2Fw%2FA">A - 나무위키</a></h2><a class="result__snippet">설명</a></div>`);
    expect(parseDuckDuckGo(doc)).toEqual([{ url: 'https://namu.wiki/w/A', title: 'A - 나무위키', description: '설명', image: '' }]);
  });
});

describe('미리보기', () => {
  it('프레임 삽입 차단 헤더를 판별한다', () => {
    expect(isBlockedByFrameHeaders(new Headers({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(true);
    expect(isBlockedByFrameHeaders(new Headers({ 'content-security-policy': "default-src *; frame-ancestors 'self'" }))).toBe(true);
    expect(isBlockedByFrameHeaders(new Headers({ 'content-security-policy': 'frame-ancestors *' }))).toBe(false);
    expect(isBlockedByFrameHeaders(new Headers())).toBe(false);
  });

  it('유튜브는 임베드 주소로 바꾼다', () => {
    expect(resolveNativeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(resolveNativeEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(resolveNativeEmbedUrl('https://example.com')).toBeNull();
  });

  it('정적 사본에서 스크립트와 이벤트 속성을 걷어 내고 링크를 원문으로 연다', () => {
    const doc = parse(`<html><head><title>제목</title><meta property="og:image" content="/og.png"><script>evil()</script><meta http-equiv="refresh" content="0;url=x"></head>
      <body onload="evil()"><a href="/next" onclick="evil()">다음</a><a href="javascript:evil()">x</a><img data-src="/lazy.jpg" src=""></body></html>`);
    expect(extractMetadata(doc, 'https://site.example/a/b')).toMatchObject({ title: '제목', image: 'https://site.example/og.png' });
    const html = sanitizeForProxy(doc, 'https://site.example/a/b');
    expect(html).not.toMatch(/<script|onload|onclick|javascript:|http-equiv/i);
    expect(html).toContain('<base href="https://site.example/a/b">');
    expect(html).toContain('href="https://site.example/next"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('src="/lazy.jpg"');
  });

  it('EUC-KR 문서를 읽는다', () => {
    const bytes = new Uint8Array([0xb0, 0xed, 0xb1, 0xb8, 0xb8, 0xb6]); // "고구마"
    expect(decodeHtml(bytes, 'text/html; charset=euc-kr')).toBe('고구마');
  });
});

describe('Gemini Nano 래퍼', () => {
  it('응답의 코드 울타리를 벗긴다', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('지원되는 언어 조합을 찾고, 베이스 세션을 복제해 요청마다 쓴다', async () => {
    const created: object[] = [];
    const prompts: unknown[] = [];
    const makeSession = () => ({
      prompt: vi.fn(async (input: unknown, options: { responseConstraint?: object }) => {
        prompts.push({ input, schema: options.responseConstraint });
        return '{"queries":["a","b"]}';
      }),
      clone: vi.fn(async () => makeSession()),
      destroy: vi.fn(),
    });
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async (options: object) => {
        created.push(options);
        return makeSession();
      }),
    });
    const engine = new NanoEngine();
    expect(await engine.status()).toBe('ready');
    await expect(engine.promptJson('system', 'one', { type: 'object' })).resolves.toEqual({ queries: ['a', 'b'] });
    await engine.promptJson('system', 'two', { type: 'object' });
    expect(created).toHaveLength(1); // 두 번째 요청은 clone
    expect(created[0]).toMatchObject({ expectedInputs: [{ type: 'text', languages: ['en'] }], initialPrompts: [{ role: 'system', content: 'system' }] });
    expect(prompts).toHaveLength(2);
  });

  it('Prompt API가 없으면 unsupported, 준비 안 됐으면 요청을 거절한다', async () => {
    const engine = new NanoEngine();
    expect(await engine.status()).toBe('unsupported');
    await expect(engine.promptJson('s', 'x', {})).rejects.toThrow(/준비 안 됨/);
  });

  it('번역기가 준비됐을 때만 한글 없는 문자열을 옮긴다', async () => {
    expect(await toKorean(['sweet potato'])).toEqual(['sweet potato']); // 번역기 없음
    vi.stubGlobal('Translator', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({ translate: async (text: string) => (text === 'sweet potato' ? '고구마' : text) })),
    });
    expect(await toKorean(['sweet potato', '군밤'])).toEqual(['고구마', '군밤']);
  });
});

describe('가짜 서버 라우팅', () => {
  it('같은 출처의 원본 API 경로만 가로챈다', () => {
    const origin = 'http://127.0.0.1:5173';
    expect(matchLocalRoute('/search?query=a', origin)?.url.pathname).toBe('/search');
    expect(matchLocalRoute('/deconstruct/phrases?text=a', origin)?.url.pathname).toBe('/deconstruct/phrases');
    expect(matchLocalRoute('/preview?mode=inspect&url=x', origin)).not.toBeNull();
    expect(matchLocalRoute('/src/main.ts', origin)).toBeNull();
    expect(matchLocalRoute('https://www.bing.com/search?q=a', origin)).toBeNull();
    expect(matchLocalRoute('/__proto__', origin)).toBeNull();
  });

  it('잘못된 요청은 원본과 같은 상태와 오류 코드로 답한다', async () => {
    const origin = 'http://127.0.0.1:5173';
    const call = async (path: string) => {
      const response = await handleLocalRequest(matchLocalRoute(path, origin)!);
      return { status: response.status, body: await response.json() };
    };
    expect(await call('/search')).toEqual({ status: 400, body: { error: 'query is required' } });
    expect(await call('/search?query=a&goodCount=101')).toEqual({ status: 400, body: { error: 'goodCount must be an integer from 0 to 100' } });
    expect(await call('/deconstruct')).toMatchObject({ status: 400, body: { error: { code: 'INVALID_URL' } } });
    expect(await call('/deconstruct?url=ftp%3A%2F%2Fx')).toMatchObject({ status: 400, body: { error: { code: 'INVALID_URL' } } });
    expect(await call('/deconstruct/phrases?text=')).toMatchObject({ status: 400, body: { error: { code: 'INVALID_TEXT' } } });
  });

  it('검색 응답 모양이 프론트엔드 파서를 통과한다', () => {
    const body = { good: [{ url: 'https://a.example/', title: 'A', description: '', image: '', rank: 1 }], awesome: { 군밤: { rank: 1, results: [] } } };
    expect(() => parseSearchResponse(JSON.parse(JSON.stringify(body)))).not.toThrow();
  });
});

describe('분해 파이프라인', () => {
  it('http(s) 주소만 받는다', () => {
    expect(parseInputUrl(' https://a.example/x ').href).toBe('https://a.example/x');
    expect(() => parseInputUrl('file:///etc/passwd')).toThrow();
    expect(() => parseInputUrl('not a url')).toThrow();
  });

  it('iframe에 넣을 문서에 기준 주소와 shadow root 열기를 넣고 CSP meta를 뺀다', () => {
    const html = prepareHtml('<html><head><base href="/x/"><meta http-equiv="Content-Security-Policy" content="script-src none"></head><body>본문</body></html>', 'https://a.example/p?q="1"');
    expect(html).toContain('<base href="https://a.example/p?q=&quot;1&quot;">');
    expect(html).toContain('attachShadow');
    expect(html).not.toMatch(/Content-Security-Policy|href="\/x\/"/);
    expect(prepareHtml('<p>조각</p>', 'https://a.example/')).toMatch(/^<!doctype html><html><head><base/);
  });

  it('규칙 분할과 LLM 경계 모두 원문 글자만 쓴다', async () => {
    const limits = { minChars: 20, minPieceChars: 4, maxSentenceChars: 100, maxBatchChars: 1000, maxLlmCharsPerPage: 5000, llmConcurrency: 1, maxContents: 100 };
    const text = '고구마는 메꽃과의 여러해살이 식물이다. 덩이뿌리를 식용으로 쓰며 조선 후기에 들어왔다.';
    const nodes = [{ type: 'text' as const, content: text, meta: { kind: 'text' } }, { type: 'text' as const, content: '메뉴', meta: { kind: 'link' } }];
    const rule = await createSegmenter({ finder: null, limits })(structuredClone(nodes));
    expect(rule.nodes.map((node) => node.content)).toEqual(['고구마는 메꽃과의 여러해살이 식물이다.', '덩이뿌리를 식용으로 쓰며 조선 후기에 들어왔다.', '메뉴']);

    const finder: BoundaryFinder = {
      cacheKey: 'fake',
      find: vi.fn(async (items: { id: number; tokens: string[] }[]) => ({ breaks: new Map<number, unknown>(items.map((item) => [item.id, [3, 999, -1]])) })),
    };
    const llm = await createSegmenter({ finder, limits })(structuredClone(nodes));
    expect(llm.nodes[0]!.content).toBe('고구마는 메꽃과의 여러해살이');
    expect(llm.nodes[0]!.meta.segment).toMatchObject({ method: 'llm' });
    expect(llm.nodes.map((node) => node.content).join(' ').replace(/\s+/g, '')).toBe((text + '메뉴').replace(/\s+/g, ''));
  });

  it('LLM 경계 입력은 번호 붙은 토큰이다', () => {
    expect(renderBoundaryItems([{ id: 3, tokens: ['가', '나'] }])).toBe('<text id="3">0:가 1:나</text>');
  });

  it('이미지 설명 글자와 단색 이미지를 판별한다', () => {
    expect(isMeaningfulText('붉은 고구마 밭')).toBe(true);
    expect(isMeaningfulText('image1')).toBe(false);
    expect(isMeaningfulText('2611_RM')).toBe(false);
    expect(isMeaningfulText('photo-2024-01')).toBe(false);
    const flat = new Uint8ClampedArray(4 * 100).fill(200);
    expect(isBlankPixels(flat)).toBe(true);
    const noisy = flat.map((value, index) => (index % 8 < 4 ? 0 : value));
    expect(isBlankPixels(noisy)).toBe(false);
  });

  it('설명 없는 이미지는 주변 글자, 그것도 없으면 파일명으로 임베딩한다', () => {
    const nodes = [
      { type: 'text' as const, content: '앞 글', meta: {} },
      { type: 'img' as const, content: 'https://a.example/x/%EA%B3%A0.jpg', meta: {} },
      { type: 'img' as const, content: 'https://a.example/y.jpg', meta: { description: '고구마 사진', descriptionSource: 'vision' } },
    ];
    expect(embeddingInput(nodes, 1)).toEqual({ text: '앞 글', source: 'nearby' });
    expect(embeddingInput(nodes, 2)).toEqual({ text: '고구마 사진', source: 'vision' });
    expect(embeddingInput([nodes[1]!], 0)).toEqual({ text: '고.jpg', source: 'filename' });
  });

  it('구절은 원문에 있는 것만 순서대로 남긴다', async () => {
    const text = '조선 후기 대마도에서 들여온 고구마';
    expect(keepSourcePhrases(['대마도', '조선 후기', '없는 말', '고구마', 7], text, 8)).toEqual(['대마도', '고구마']);
    expect(rulePhrases('고구마, 감자, 토란, 쌀', 8)).toEqual(['고구마', '감자', '토란']); // 한 글자 구절은 버린다(원본 규칙)
    const refine = createPhraseRefiner({ finder: { cacheKey: 'k', find: async () => ({ phrases: ['조선 후기', '고구마'] }) } });
    expect(await refine(text)).toEqual({ phrases: ['조선 후기', '고구마'], source: 'llm' });
    const broken = createPhraseRefiner({ finder: { cacheKey: 'k', find: async () => { throw new Error('down'); } } });
    expect((await broken(text)).source).toBe('rule');
  });

  it('응답이 프론트엔드의 DeconstructResponse 파서를 통과한다', () => {
    const nodes = [
      { type: 'text' as const, content: 'a', meta: {}, embedding: [1, 0] },
      { type: 'img' as const, content: 'https://a.example/i.png', meta: { label: '그림' }, embedding: [0, 1] },
      { type: 'text' as const, content: 'b', meta: {}, embedding: [Math.SQRT1_2, Math.SQRT1_2] },
    ];
    const response = { contents: toPublicContents(nodes), weights: computeWeights(nodes), querySimilarities: [1, 0.5, 0.85] };
    expect(parseDeconstructResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    expect(response.weights).toEqual([[0, 1, 0.5], [0, 2, 0.8536], [1, 2, 0.8536]]);
    expect(parsePhraseResult({ phrases: ['a'], source: 'llm', querySimilarities: [0.7] }).phrases).toEqual(['a']);
  });
});
