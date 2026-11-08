/**
 * 검색어 생성·문장 경계·이미지 설명·구절 분해가 쓰는 LLM 연결 하나.
 *
 *   nano    Chrome 내장 Gemini Nano (기본, 무료, 기기 안에서만)
 *   claude  Anthropic API (공식 SDK, 브라우저에서 바로 호출)
 *   openai  OpenAI API (Chat Completions)
 *   local   OpenAI 호환 주소의 로컬 서버 (Ollama, LM Studio 등)
 *
 * 호출자는 모두 promptJson(시스템, 입력, JSON 스키마)만 쓴다. 응답이 깨지거나 연결이 실패하면
 * 호출자가 규칙 분할·대체 검색어로 이어 가므로, 여기서는 실패를 그대로 던진다.
 *
 * API 키는 기본적으로 이 탭의 메모리에만 둔다. 분해할 때 대상 페이지 스크립트가 이 앱과 같은 출처의
 * iframe에서 돌기 때문에, localStorage에 둔 키는 그 스크립트가 읽을 수 있다. 사용자가 '이 기기에 기억'을
 * 켰을 때만 저장한다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { nano, stripFence, type NanoStatus } from './nano.ts';

export type ProviderId = 'nano' | 'claude' | 'openai' | 'local';
export type Modality = 'text' | 'image';
export type LlmStatus = NanoStatus | 'needs-setup';
/** 분할 단계가 한 페이지에서 LLM에 맡길 분량. 작은 모델일수록 줄인다. */
export type LlmProfile = 'small' | 'medium' | 'large';
export type Effort = 'low' | 'medium' | 'high';

export interface LlmSettings {
  provider: ProviderId;
  claude: { model: string; apiKey: string };
  openai: { model: string; apiKey: string; baseUrl: string };
  local: { model: string; apiKey: string; baseUrl: string; vision: boolean };
  /** API 키를 localStorage에 저장할지. 꺼져 있으면 키는 탭을 닫을 때 사라진다. */
  remember: boolean;
}

export interface ImageInput { text: string; image: Blob }
export type LlmInput = string | ImageInput;

export interface PromptOptions { signal?: AbortSignal; modality?: Modality; timeoutMs?: number; effort?: Effort }

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  nano: 'Gemini Nano',
  claude: 'Claude',
  openai: 'OpenAI',
  local: '로컬 LLM',
};

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
export const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1';

export function defaultSettings(): LlmSettings {
  return {
    provider: 'nano',
    claude: { model: CLAUDE_MODELS[0]!, apiKey: '' },
    openai: { model: '', apiKey: '', baseUrl: DEFAULT_OPENAI_URL },
    local: { model: '', apiKey: '', baseUrl: DEFAULT_LOCAL_URL, vision: false },
    remember: false,
  };
}

const STORAGE_KEY = 'local-llm-settings';
const PROVIDERS = new Set<ProviderId>(['nano', 'claude', 'openai', 'local']);

/** 저장된 설정을 읽는다. 형식이 어긋난 값은 기본값으로 둔다. */
export function parseSettings(raw: string | null): LlmSettings {
  const base = defaultSettings();
  if (!raw) return base;
  try {
    const data = JSON.parse(raw) as Partial<LlmSettings>;
    const str = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
    return {
      provider: PROVIDERS.has(data.provider as ProviderId) ? data.provider as ProviderId : base.provider,
      claude: { model: str(data.claude?.model, base.claude.model), apiKey: str(data.claude?.apiKey, '') },
      openai: { model: str(data.openai?.model, ''), apiKey: str(data.openai?.apiKey, ''), baseUrl: str(data.openai?.baseUrl, base.openai.baseUrl) },
      local: {
        model: str(data.local?.model, ''),
        apiKey: str(data.local?.apiKey, ''),
        baseUrl: str(data.local?.baseUrl, base.local.baseUrl),
        vision: data.local?.vision === true,
      },
      remember: data.remember === true,
    };
  } catch {
    return base;
  }
}

/** 저장용 사본. 기억하기가 꺼져 있으면 키를 뺀다. */
export function serializeSettings(settings: LlmSettings): string {
  const keep = (key: string) => (settings.remember ? key : '');
  return JSON.stringify({
    ...settings,
    claude: { ...settings.claude, apiKey: keep(settings.claude.apiKey) },
    openai: { ...settings.openai, apiKey: keep(settings.openai.apiKey) },
    local: { ...settings.local, apiKey: keep(settings.local.apiKey) },
  });
}

/**
 * Claude·OpenAI 구조화 출력이 받지 않는 제약(개수·길이·범위)을 빼고, 모든 객체에
 * additionalProperties:false와 전체 required를 붙인다. 빠진 제약은 호출자가 응답을 검증할 때 다시 본다.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key)) continue;
    out[key] = strictSchema(value);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

/** 모델이 JSON 앞뒤에 덧붙이는 생각 태그·코드 울타리·설명을 걷어 내고 파싱한다. */
export function parseJsonText(text: string): unknown {
  const cleaned = stripFence(text.replace(/<think>[\s\S]*?<\/think>/gi, ''));
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw error;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const imageType = (blob: Blob) => (['image/png', 'image/gif', 'image/webp'].includes(blob.type) ? blob.type : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** 인증 실패처럼 다시 시도해도 같은 결과인 오류. 설정을 바꿀 때까지 호출을 멈춘다. */
export class LlmSetupError extends Error {}

/** Claude 요청이 서버 쪽 대체 모델(fallbacks: "default")을 받는 모델. Haiku에는 대체가 없다. */
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1|sonnet-5-5|mythos-5-1)/;
/** effort를 모르는 옛 모델에는 보내지 않는다. */
const NO_EFFORT = /claude-3|haiku-4|sonnet-4-5|opus-4-1/;

type FetchLike = typeof fetch;

export class LlmEngine {
  private current: LlmSettings;
  private readonly listeners = new Set<(settings: LlmSettings) => void>();
  private setupError: string | null = null;
  /** 로컬 서버가 response_format(json_schema)을 거부하면 지시문으로만 JSON을 요청한다. */
  private readonly noSchemaFormat = new Set<string>();
  /** reasoning_effort를 거부하는 로컬 서버 */
  private readonly noReasoningParam = new Set<string>();
  private claudeClient: { key: string; client: Anthropic } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { storage?: Storage | null; fetch?: FetchLike } = {}) {
    let raw: string | null = null;
    try { raw = options.storage?.getItem(STORAGE_KEY) ?? null; } catch { /* 저장소를 쓸 수 없는 환경 */ }
    this.current = parseSettings(raw);
  }

  // 페이지 스크립트가 나중에 window.fetch를 바꿔치기해도 키가 새지 않도록, 처음 받은 fetch를 쓴다.
  private get fetchImpl(): FetchLike {
    return this.options.fetch ?? pristineFetch;
  }

  get settings(): LlmSettings {
    return structuredClone(this.current);
  }

  get provider(): ProviderId {
    return this.current.provider;
  }

  get label(): string {
    const { provider } = this.current;
    if (provider === 'nano') return PROVIDER_LABEL.nano;
    const model = this.current[provider].model;
    return model ? `${PROVIDER_LABEL[provider]}(${model})` : PROVIDER_LABEL[provider];
  }

  /** 캐시 열쇠. 연결이나 모델이 바뀌면 이전 응답을 다시 쓰지 않는다. */
  get cacheTag(): string {
    const { provider } = this.current;
    return provider === 'nano' ? 'gemini-nano' : `${provider}:${this.current[provider].model}`;
  }

  get profile(): LlmProfile {
    return this.current.provider === 'nano' ? 'small' : this.current.provider === 'local' ? 'medium' : 'large';
  }

  /** API는 한국어로 바로 답하므로 Nano용 번역을 거치지 않는다. */
  get needsTranslation(): boolean {
    return this.current.provider === 'nano';
  }

  get lastSetupError(): string | null {
    return this.setupError;
  }

  update(patch: Partial<Omit<LlmSettings, 'claude' | 'openai' | 'local'>> & {
    claude?: Partial<LlmSettings['claude']>; openai?: Partial<LlmSettings['openai']>; local?: Partial<LlmSettings['local']>;
  }): void {
    const next = this.settings;
    if (patch.provider) next.provider = patch.provider;
    if (patch.remember !== undefined) next.remember = patch.remember;
    // undefined로 넘어온 칸은 기존 값을 지우지 않는다.
    const defined = <T extends object>(value: T | undefined) => Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
    Object.assign(next.claude, defined(patch.claude));
    Object.assign(next.openai, defined(patch.openai));
    Object.assign(next.local, defined(patch.local));
    this.current = next;
    this.setupError = null;
    this.claudeClient = null;
    try { this.options.storage?.setItem(STORAGE_KEY, serializeSettings(next)); } catch { /* 저장 실패는 이번 탭에서만 쓰면 된다 */ }
    for (const listener of this.listeners) listener(this.settings);
  }

  subscribe(listener: (settings: LlmSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 지금 연결로 이 종류의 입력을 처리할 수 있는지. API 연결은 설정만 보고, 실제 확인은 test()가 한다. */
  async status(modality: Modality = 'text', fresh = false): Promise<LlmStatus> {
    const { provider } = this.current;
    if (provider === 'nano') return nano.status(modality, fresh);
    if (this.setupError) return 'needs-setup';
    const settings = this.current[provider];
    if (!settings.model.trim()) return 'needs-setup';
    if (provider !== 'local' && !settings.apiKey.trim()) return 'needs-setup';
    if (provider !== 'claude' && !(settings as { baseUrl: string }).baseUrl.trim()) return 'needs-setup';
    if (modality === 'image' && provider === 'local' && !this.current.local.vision) return 'unavailable';
    return 'ready';
  }

  /** 설정이 빠졌을 때 화면에 보여 줄 이유. */
  missing(): string | null {
    const { provider } = this.current;
    if (provider === 'nano') return null;
    if (this.setupError) return this.setupError;
    const settings = this.current[provider];
    if (provider !== 'local' && !settings.apiKey.trim()) return 'API 키 필요';
    if (!settings.model.trim()) return '모델 이름 필요';
    if (provider !== 'claude' && !(settings as { baseUrl: string }).baseUrl.trim()) return '주소 필요';
    return null;
  }

  /** JSON 스키마로 제한한 응답을 파싱해 돌려준다. */
  promptJson<T>(system: string, input: LlmInput, schema: object, { signal, modality = 'text', timeoutMs = 60_000, effort = 'low' }: PromptOptions = {}): Promise<T> {
    const { provider } = this.current;
    if (provider === 'nano') {
      const nanoInput = typeof input === 'string'
        ? input
        : [{ role: 'user' as const, content: [{ type: 'text' as const, value: input.text }, { type: 'image' as const, value: input.image }] }];
      return nano.promptJson<T>(system, nanoInput, schema, { signal, modality, timeoutMs });
    }
    // 원격 모델은 생각하는 시간이 있어 Nano 기준 제한 시간보다 넉넉히 준다.
    const limit = Math.max(timeoutMs * 3, 60_000);
    const task = async () => {
      signal?.throwIfAborted();
      if ((await this.status(modality)) !== 'ready') throw new LlmSetupError(this.missing() ?? `${this.label} 준비 안 됨`);
      const text = provider === 'claude'
        ? await this.callClaude(system, input, schema, { signal, timeoutMs: limit, effort })
        : await this.callOpenAiCompatible(provider, system, input, schema, { signal, timeoutMs: limit });
      return parseJsonText(text) as T;
    };
    // 로컬 서버는 보통 한 번에 하나씩 처리하므로 줄을 세운다. 원격 API는 동시에 보낸다.
    if (provider !== 'local') return task();
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private claude(): Anthropic {
    const key = this.current.claude.apiKey.trim();
    if (this.claudeClient?.key !== key) {
      this.claudeClient = {
        key,
        client: new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, fetch: this.fetchImpl, maxRetries: 1 }),
      };
    }
    return this.claudeClient.client;
  }

  private async callClaude(system: string, input: LlmInput, schema: object,
    { signal, timeoutMs, effort }: { signal?: AbortSignal; timeoutMs: number; effort: Effort }): Promise<string> {
    const model = this.current.claude.model.trim();
    const content: Anthropic.Beta.BetaContentBlockParam[] = typeof input === 'string'
      ? [{ type: 'text', text: input }]
      : [
          { type: 'image', source: { type: 'base64', media_type: imageType(input.image), data: await blobToBase64(input.image) } },
          { type: 'text', text: input.text },
        ];
    const fallback = FALLBACK_MODELS.test(model);
    try {
      const response = await this.claude().beta.messages.create({
        model,
        max_tokens: 16_000,
        system,
        messages: [{ role: 'user', content }],
        output_config: {
          ...(NO_EFFORT.test(model) ? {} : { effort }),
          format: { type: 'json_schema', schema: strictSchema(schema) as Record<string, unknown> },
        },
        // 안전 분류기가 거절하면 서버가 권장 대체 모델로 다시 돌린다.
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }, { signal, timeout: timeoutMs });
      if (response.stop_reason === 'refusal') throw new Error('Claude가 요청을 거절했습니다');
      if (response.stop_reason === 'max_tokens') throw new SyntaxError('Claude 응답이 길이 제한에 걸려 잘렸습니다');
      return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        this.failSetup('API 키가 올바르지 않음');
      } else if (error instanceof Anthropic.NotFoundError) {
        this.failSetup(`모델 '${model}'을 찾을 수 없음`);
      }
      throw error;
    }
  }

  private async callOpenAiCompatible(provider: 'openai' | 'local', system: string, input: LlmInput, schema: object,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number }): Promise<string> {
    const settings = this.current[provider];
    const base = settings.baseUrl.trim().replace(/\/+$/, '');
    const strict = strictSchema(schema);
    const userContent = typeof input === 'string'
      ? input
      : [
          { type: 'text', text: input.text },
          { type: 'image_url', image_url: { url: `data:${imageType(input.image)};base64,${await blobToBase64(input.image)}` } },
        ];
    // 로컬 모델(Gemma, Qwen 등)은 기본으로 길게 '생각'한 뒤 답해서, 짧은 분류 작업에도 수천 토큰을 쓰다
    // 문맥 한도에 걸려 잘린다(gemma-4-12b: 생각 6,894토큰 → 잘림). reasoning_effort: 'none'으로 끈다.
    // OpenAI 본 API는 모델마다 받는 값이 달라 보내지 않는다.
    const body = (useFormat: boolean, noThinking: boolean) => JSON.stringify({
      model: settings.model.trim(),
      messages: [
        { role: 'system', content: useFormat ? system : `${system}\n\nRespond with only a JSON object that matches this JSON schema:\n${JSON.stringify(strict)}` },
        { role: 'user', content: userContent },
      ],
      ...(useFormat ? { response_format: { type: 'json_schema', json_schema: { name: 'result', schema: strict, strict: true } } } : {}),
      ...(noThinking ? { reasoning_effort: 'none' } : {}),
    });
    const send = (useFormat: boolean, noThinking: boolean) => this.fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(settings.apiKey.trim() ? { authorization: `Bearer ${settings.apiKey.trim()}` } : {}) },
      body: body(useFormat, noThinking),
      credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });

    // 로컬 서버가 모르는 옵션을 400/422로 거부하면 하나씩 빼고 다시 보낸다(생각 끄기 → 스키마 형식 순).
    let useFormat = !this.noSchemaFormat.has(base);
    let noThinking = provider === 'local' && !this.noReasoningParam.has(base);
    let response = await send(useFormat, noThinking);
    while (provider === 'local' && (response.status === 400 || response.status === 422) && (noThinking || useFormat)) {
      if (noThinking) {
        noThinking = false;
        this.noReasoningParam.add(base);
      } else {
        useFormat = false;
        this.noSchemaFormat.add(base);
      }
      response = await send(useFormat, noThinking);
    }
    if (response.status === 401 || response.status === 403) this.failSetup('API 키가 올바르지 않음');
    if (response.status === 404) this.failSetup(`주소나 모델 '${settings.model}'을 찾을 수 없음`);
    if (!response.ok) throw new Error(`${PROVIDER_LABEL[provider]} 응답 ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    const data = await response.json() as { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[] };
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) throw new Error(`${PROVIDER_LABEL[provider]}가 요청을 거절했습니다`);
    if (choice?.finish_reason === 'length') throw new SyntaxError('응답이 길이 제한에 걸려 잘렸습니다');
    const text = choice?.message?.content;
    if (typeof text !== 'string') throw new SyntaxError('응답에 내용이 없습니다');
    return text;
  }

  private failSetup(message: string): void {
    this.setupError = message;
    for (const listener of this.listeners) listener(this.settings);
  }

  /** 연결 확인. 아주 짧은 요청 하나를 보낸다(API는 소액 과금). */
  async test(signal?: AbortSignal): Promise<{ ok: true; ms: number } | { ok: false; message: string }> {
    const started = performance.now();
    this.setupError = null;
    try {
      const result = await this.promptJson<{ word: unknown }>(
        'Reply with a JSON object whose "word" field is the Korean word for "sweet potato".',
        'Answer now.',
        { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false },
        { signal, timeoutMs: 20_000 },
      );
      if (typeof result?.word !== 'string') return { ok: false, message: '응답 형식이 맞지 않음' };
      return { ok: true, ms: Math.round(performance.now() - started) };
    } catch (error) {
      return { ok: false, message: this.setupError ?? (error instanceof Error ? error.message : String(error)) };
    }
  }

  /** OpenAI 호환 서버의 모델 목록(/models). 화면의 모델 입력 칸 제안용. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const { provider } = this.current;
    if (provider === 'nano') return [];
    if (provider === 'claude') return CLAUDE_MODELS;
    const settings = this.current[provider];
    const base = settings.baseUrl.trim().replace(/\/+$/, '');
    if (!base) return [];
    const response = await this.fetchImpl(`${base}/models`, {
      headers: settings.apiKey.trim() ? { authorization: `Bearer ${settings.apiKey.trim()}` } : {},
      credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`모델 목록 응답 ${response.status}`);
    const data = await response.json() as { data?: { id?: unknown }[] };
    return (data.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string').sort();
  }
}

const pristineFetch: FetchLike = globalThis.fetch.bind(globalThis);

function browserStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export const llm = new LlmEngine({ storage: browserStorage() });
