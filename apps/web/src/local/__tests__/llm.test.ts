/**
 * llm.ts: 연결 고르기, 설정 저장, Claude·OpenAI·로컬 LLM 요청 모양. 실제 네트워크 대신 가짜 fetch를 쓴다.
 */
import { describe, expect, it, vi } from 'vitest';
import { LlmEngine, parseJsonText, parseSettings, serializeSettings, strictSchema, defaultSettings } from '../llm.ts';

const SCHEMA = { type: 'object', properties: { word: { type: 'string', minLength: 1 }, list: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } } }, required: ['word'] };

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

interface Call { url: string; init: RequestInit & { headers?: unknown }; body: Record<string, unknown> }

function fakeFetch(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const call = { url, init, body };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers as HeadersInit).get(name);

const openAiReply = (content: string) => json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const claudeReply = (text: string, stop = 'end_turn') => json({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text }], stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe('설정', () => {
  it('기본은 Gemini Nano이고, 깨진 저장값은 기본값으로 둔다', () => {
    expect(parseSettings(null).provider).toBe('nano');
    expect(parseSettings('{oops').provider).toBe('nano');
    expect(parseSettings(JSON.stringify({ provider: 'evil' })).provider).toBe('nano');
    expect(parseSettings(JSON.stringify({ provider: 'local', local: { model: 'gemma3', vision: true } })).local).toMatchObject({ model: 'gemma3', vision: true });
  });

  it('기억하기를 켜지 않으면 API 키를 저장하지 않는다', () => {
    const settings = { ...defaultSettings(), provider: 'claude' as const, claude: { model: 'claude-opus-5-5', apiKey: 'sk-ant-secret' } };
    expect(serializeSettings(settings)).not.toContain('sk-ant-secret');
    expect(serializeSettings({ ...settings, remember: true })).toContain('sk-ant-secret');

    const storage = memoryStorage();
    const engine = new LlmEngine({ storage });
    engine.update({ provider: 'openai', openai: { apiKey: 'sk-openai-secret', model: 'm' } });
    expect(storage.getItem('local-llm-settings')).not.toContain('sk-openai-secret');
    expect(engine.settings.openai.apiKey).toBe('sk-openai-secret'); // 이 탭에서는 쓴다
    // 다시 열면 연결과 모델은 남고 키는 비어 있다.
    const reopened = new LlmEngine({ storage });
    expect(reopened.provider).toBe('openai');
    expect(reopened.settings.openai).toMatchObject({ model: 'm', apiKey: '' });
  });

  it('일부 칸만 바꿔도 다른 칸은 그대로 둔다', () => {
    const engine = new LlmEngine();
    engine.update({ provider: 'claude', claude: { apiKey: 'k' } });
    engine.update({ claude: { model: undefined, apiKey: 'k2' } });
    expect(engine.settings.claude).toEqual({ model: 'claude-opus-5-5', apiKey: 'k2' });
  });

  it('필요한 값이 빠지면 needs-setup, 로컬 이미지는 켜야 쓴다', async () => {
    const engine = new LlmEngine();
    engine.update({ provider: 'claude' });
    expect(await engine.status()).toBe('needs-setup');
    expect(engine.missing()).toBe('API 키 필요');
    engine.update({ claude: { apiKey: 'k' } });
    expect(await engine.status()).toBe('ready');
    expect(await engine.status('image')).toBe('ready');

    engine.update({ provider: 'local' });
    expect(engine.missing()).toBe('모델 이름 필요');
    engine.update({ local: { model: 'gemma3' } });
    expect(await engine.status('text')).toBe('ready'); // 로컬은 키가 없어도 된다
    expect(await engine.status('image')).toBe('unavailable');
    engine.update({ local: { vision: true } });
    expect(await engine.status('image')).toBe('ready');
    expect(engine.profile).toBe('medium');
    expect(engine.needsTranslation).toBe(false);
  });
});

describe('스키마와 응답 정리', () => {
  it('구조화 출력이 받지 않는 제약을 빼고 객체를 닫는다', () => {
    const strict = strictSchema(SCHEMA) as { additionalProperties: boolean; required: string[]; properties: Record<string, Record<string, unknown>> };
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(['word', 'list']);
    expect(strict.properties.word).toEqual({ type: 'string' });
    expect(strict.properties.list).toEqual({ type: 'array', items: { type: 'string' } });
    expect(SCHEMA.properties.list.minItems).toBe(2); // 원본은 건드리지 않는다
  });

  it('생각 태그, 코드 울타리, 앞뒤 설명을 걷어 내고 JSON을 읽는다', () => {
    expect(parseJsonText('<think>음…</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonText('결과입니다: {"a":2} 끝')).toEqual({ a: 2 });
    expect(() => parseJsonText('no json')).toThrow(SyntaxError);
  });
});

describe('OpenAI·로컬 LLM', () => {
  it('Chat Completions에 json_schema 형식과 키를 보내고 응답을 파싱한다', async () => {
    const { fetch, calls } = fakeFetch(() => openAiReply('{"word":"고구마"}'));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'openai', openai: { apiKey: 'sk-1', model: 'some-model', baseUrl: 'https://api.example.com/v1/' } });

    expect(await engine.promptJson('sys', 'hello', SCHEMA)).toEqual({ word: '고구마' });
    const [call] = calls;
    expect(call!.url).toBe('https://api.example.com/v1/chat/completions');
    expect(headerOf(call!.init, 'authorization')).toBe('Bearer sk-1');
    expect(call!.init.credentials).toBe('omit');
    expect(call!.body).toMatchObject({
      model: 'some-model',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
      response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true } },
    });
  });

  it('이미지는 data URL로 보낸다', async () => {
    const { fetch, calls } = fakeFetch(() => openAiReply('{"description":"고양이"}'));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'local', local: { model: 'llava', vision: true } });
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    await engine.promptJson('sys', { text: 'Describe', image }, SCHEMA, { modality: 'image' });
    const content = (calls[0]!.body.messages as { content: unknown }[])[1]!.content as { type: string; image_url?: { url: string } }[];
    expect(content[1]!.image_url!.url).toBe('data:image/jpeg;base64,AQID');
    expect(headerOf(calls[0]!.init, 'authorization')).toBeNull(); // 로컬은 키 없이
  });

  it('로컬 모델의 생각을 끄고, 서버가 모르는 옵션은 하나씩 빼고 다시 보낸 뒤 기억한다', async () => {
    const { fetch, calls } = fakeFetch((call) => (call.body.response_format || call.body.reasoning_effort ? json({ error: 'unsupported' }, 400) : openAiReply('{"word":"감자"}')));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'local', local: { model: 'tiny' } });
    expect(await engine.promptJson('sys', 'x', SCHEMA)).toEqual({ word: '감자' });
    expect(calls.map((call) => [call.body.reasoning_effort ?? null, Boolean(call.body.response_format)])).toEqual([['none', true], [null, true], [null, false]]);
    expect((calls[2]!.body.messages as { content: string }[])[0]!.content).toContain('JSON schema');
    await engine.promptJson('sys', 'y', SCHEMA);
    expect(calls).toHaveLength(4);
    expect(calls[3]!.body.response_format).toBeUndefined();
    expect(calls[3]!.body.reasoning_effort).toBeUndefined();
  });

  it('OpenAI 본 API에는 reasoning_effort를 보내지 않는다', async () => {
    const { fetch, calls } = fakeFetch(() => openAiReply('{"word":"a"}'));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
    await engine.promptJson('s', 'x', SCHEMA);
    expect(calls[0]!.body.reasoning_effort).toBeUndefined();
  });

  it('키가 틀리면 설정 오류로 멈추고, 설정을 바꾸면 다시 시도한다', async () => {
    const { fetch, calls } = fakeFetch(() => json({ error: 'bad key' }, 401));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'openai', openai: { apiKey: 'wrong', model: 'm' } });
    await expect(engine.promptJson('s', 'x', SCHEMA)).rejects.toThrow();
    expect(await engine.status()).toBe('needs-setup');
    expect(engine.missing()).toBe('API 키가 올바르지 않음');
    await expect(engine.promptJson('s', 'x', SCHEMA)).rejects.toThrow('API 키가 올바르지 않음');
    expect(calls).toHaveLength(1); // 두 번째는 보내지 않는다
    engine.update({ openai: { apiKey: 'right' } });
    expect(await engine.status()).toBe('ready');
  });

  it('잘린 응답과 거절은 오류로 돌려준다', async () => {
    const replies = [
      json({ choices: [{ message: { content: '{"wo' }, finish_reason: 'length' }] }),
      json({ choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] }),
    ];
    const { fetch } = fakeFetch((_call, index) => replies[index]!);
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'openai', openai: { apiKey: 'k', model: 'm' } });
    await expect(engine.promptJson('s', 'x', SCHEMA)).rejects.toThrow(SyntaxError);
    await expect(engine.promptJson('s', 'x', SCHEMA)).rejects.toThrow('거절');
  });

  it('모델 목록을 /models에서 읽는다', async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: [{ id: 'b' }, { id: 'a' }, { id: 3 }] }));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'local' });
    expect(await engine.listModels()).toEqual(['a', 'b']);
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/models');
  });
});

describe('Claude', () => {
  it('Messages API에 구조화 출력, effort, 서버 쪽 대체 모델을 넣어 보낸다', async () => {
    const { fetch, calls } = fakeFetch(() => claudeReply('{"word":"고구마"}'));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'claude', claude: { apiKey: 'sk-ant-test' } });

    expect(await engine.promptJson('sys', 'hello', SCHEMA, { effort: 'medium' })).toEqual({ word: '고구마' });
    const [call] = calls;
    expect(call!.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages(\?|$)/);
    // SDK 버전에 따라 x-api-key 또는 Bearer로 보낸다.
    expect([headerOf(call!.init, 'x-api-key'), headerOf(call!.init, 'authorization')]).toContain(headerOf(call!.init, 'x-api-key') ? 'sk-ant-test' : 'Bearer sk-ant-test');
    expect(headerOf(call!.init, 'anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(headerOf(call!.init, 'anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(call!.body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'sys',
      fallbacks: 'default',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    const schema = (call!.body.output_config as { format: { schema: { additionalProperties: boolean } } }).format.schema;
    expect(schema.additionalProperties).toBe(false);
  });

  it('Haiku에는 대체 모델을 붙이지 않고, 이미지는 base64로 보낸다', async () => {
    const { fetch, calls } = fakeFetch(() => claudeReply('{"description":"고양이"}'));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'claude', claude: { apiKey: 'k', model: 'claude-haiku-5-5' } });
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await engine.promptJson('sys', { text: 'Describe', image }, SCHEMA, { modality: 'image' });
    expect(calls[0]!.body.fallbacks).toBeUndefined();
    expect(calls[0]!.body.messages).toEqual([{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'text', text: 'Describe' },
    ] }]);
  });

  it('거절·잘림은 오류, 잘못된 키는 설정 오류로 멈춘다', async () => {
    const replies = [
      claudeReply('', 'refusal'),
      claudeReply('{"wo', 'max_tokens'),
      json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
    ];
    // 연결 테스트는 멈춘 상태를 풀고 다시 보내므로, 세 번째 이후는 계속 401을 돌려준다.
    const { fetch } = fakeFetch((_call, index) => replies[Math.min(index, 2)]!.clone());
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'claude', claude: { apiKey: 'k' } });
    await expect(engine.promptJson('s', 'x', SCHEMA)).rejects.toThrow('거절');
    await expect(engine.promptJson('s', 'x', SCHEMA)).rejects.toThrow(SyntaxError);
    await expect(engine.promptJson('s', 'x', SCHEMA)).rejects.toThrow();
    expect(engine.missing()).toBe('API 키가 올바르지 않음');
    const outcome = await engine.test();
    expect(outcome).toEqual({ ok: false, message: 'API 키가 올바르지 않음' });
  });

  it('연결 테스트는 짧은 요청 하나로 확인한다', async () => {
    const { fetch, calls } = fakeFetch(() => claudeReply('{"word":"고구마"}'));
    const engine = new LlmEngine({ fetch });
    engine.update({ provider: 'claude', claude: { apiKey: 'k' } });
    const outcome = await engine.test();
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(engine.label).toBe('Claude(claude-opus-5-5)');
    expect(engine.cacheTag).toBe('claude:claude-opus-5-5');
  });
});
