/**
 * Chrome 내장 Gemini Nano(Prompt API) 래퍼.
 *
 * - 시스템 프롬프트별 베이스 세션을 만들어 두고 요청마다 clone()해 쓴다. 대화 맥락이 쌓이지 않고 프리필 비용도 아낀다.
 * - 온디바이스 모델은 한 번에 하나의 요청만 효율적으로 처리하므로 모든 호출을 직렬 큐에 넣는다.
 * - 구조화 출력은 responseConstraint(JSON 스키마)로 강제하고, 그래도 깨진 응답은 호출자가 검증한다.
 */

export type NanoStatus = 'ready' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

interface PromptContent { type: 'text' | 'image'; value: unknown }
interface PromptMessage { role: 'system' | 'user' | 'assistant'; content: string | PromptContent[] }
interface LanguageModelSession {
  prompt(input: string | PromptMessage[], options?: { signal?: AbortSignal; responseConstraint?: object }): Promise<string>;
  clone?(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
}
interface LanguageModelStatic {
  availability(options?: object): Promise<string>;
  create(options?: object): Promise<LanguageModelSession>;
}

function api(): LanguageModelStatic | null {
  const g = globalThis as unknown as { LanguageModel?: LanguageModelStatic };
  return g.LanguageModel ?? null;
}

type Modality = 'text' | 'image';

/**
 * Chrome 156 기준 Prompt API가 받는 언어는 de, en, es, fr, ja뿐이다. 'ko'를 넣으면 세션 생성이 거부되므로
 * 영어로 선언하고, 한국어 출력은 프롬프트로 요청한 뒤 필요하면 Translator API로 옮긴다(translate.ts).
 * 언어 지정 자체를 모르는 버전을 위해 언어 없는 조합을 마지막에 둔다.
 */
function optionVariants(modality: Modality): object[] {
  const image = modality === 'image' ? [{ type: 'image' }] : [];
  return [
    { expectedInputs: [{ type: 'text', languages: ['en'] }, ...image], expectedOutputs: [{ type: 'text', languages: ['en'] }] },
    { expectedInputs: [{ type: 'text' }, ...image] },
  ];
}

const READY = new Set(['available', 'readily']);
const DOWNLOAD = new Set(['downloadable', 'after-download']);

export class NanoEngine {
  private readonly baseSessions = new Map<string, Promise<LanguageModelSession>>();
  private readonly workingOptions = new Map<Modality, object>();
  private queue: Promise<unknown> = Promise.resolve();
  private statusCache = new Map<Modality, { status: NanoStatus; at: number }>();

  isExposed(): boolean {
    return api() !== null;
  }

  async status(modality: Modality = 'text', fresh = false): Promise<NanoStatus> {
    const cached = this.statusCache.get(modality);
    if (!fresh && cached && (cached.status === 'ready' || Date.now() - cached.at < 15_000)) return cached.status;
    const status = await this.queryStatus(modality);
    this.statusCache.set(modality, { status, at: Date.now() });
    return status;
  }

  private async queryStatus(modality: Modality): Promise<NanoStatus> {
    const lm = api();
    if (!lm) return 'unsupported';
    let best: NanoStatus = 'unavailable';
    for (const options of optionVariants(modality)) {
      try {
        const raw = await lm.availability(options);
        if (READY.has(raw)) {
          this.workingOptions.set(modality, options);
          return 'ready';
        }
        if (raw === 'downloading') best = 'downloading';
        else if (DOWNLOAD.has(raw) && best !== 'downloading') {
          best = 'downloadable';
          if (!this.workingOptions.has(modality)) this.workingOptions.set(modality, options);
        }
      } catch {
        // 이 옵션 조합을 모르는 버전이다. 다음 조합으로 넘어간다.
      }
    }
    return best;
  }

  /**
   * 모델 다운로드를 시작한다. 모델이 없을 때 create()는 사용자 활성화를 요구하므로 반드시 클릭 핸들러 안에서 부른다.
   */
  async activate(modality: Modality = 'text', onProgress?: (ratio: number) => void): Promise<NanoStatus> {
    const lm = api();
    if (!lm) return 'unsupported';
    await this.status(modality, true);
    const monitor = onProgress
      ? (m: EventTarget) => m.addEventListener('downloadprogress', (event) => onProgress((event as unknown as { loaded: number }).loaded))
      : undefined;
    const session = await this.createSession('You are a helpful assistant.', modality, monitor);
    session.destroy();
    this.statusCache.clear();
    return this.status(modality, true);
  }

  private async createSession(system: string, modality: Modality, monitor?: (m: EventTarget) => void): Promise<LanguageModelSession> {
    const lm = api();
    if (!lm) throw new Error('Prompt API를 사용할 수 없습니다.');
    const preferred = this.workingOptions.get(modality);
    const variants = preferred ? [preferred, ...optionVariants(modality).filter((item) => item !== preferred)] : optionVariants(modality);
    let lastError: unknown;
    for (const options of variants) {
      try {
        const session = await lm.create({
          ...options,
          initialPrompts: [{ role: 'system', content: system }],
          ...(monitor ? { monitor } : {}),
        });
        this.workingOptions.set(modality, options);
        return session;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private baseSession(system: string, modality: Modality): Promise<LanguageModelSession> {
    const key = `${modality}\0${system}`;
    let session = this.baseSessions.get(key);
    if (!session) {
      session = this.createSession(system, modality);
      this.baseSessions.set(key, session);
      session.catch(() => {
        if (this.baseSessions.get(key) === session) this.baseSessions.delete(key);
      });
    }
    return session;
  }

  private dropBase(system: string, modality: Modality): void {
    const key = `${modality}\0${system}`;
    const session = this.baseSessions.get(key);
    this.baseSessions.delete(key);
    session?.then((s) => s.destroy()).catch(() => {});
  }

  /** 요청 하나를 위한 1회용 세션. clone이 없거나 실패하면 새로 만든다. */
  private async freshSession(system: string, modality: Modality): Promise<LanguageModelSession> {
    const base = await this.baseSession(system, modality);
    if (typeof base.clone !== 'function') {
      this.dropBase(system, modality);
      return base;
    }
    try {
      return await base.clone();
    } catch {
      this.dropBase(system, modality);
      return this.createSession(system, modality);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  /** JSON 스키마로 제한한 응답을 파싱해 돌려준다. */
  promptJson<T>(system: string, input: string | PromptMessage[], schema: object,
    { signal, modality = 'text', timeoutMs = 60_000 }: { signal?: AbortSignal; modality?: Modality; timeoutMs?: number } = {}): Promise<T> {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      if ((await this.status(modality)) !== 'ready') throw new Error(`Gemini Nano(${modality}) 준비 안 됨`);
      const session = await this.freshSession(system, modality);
      try {
        const limit = AbortSignal.timeout(timeoutMs);
        const text = await session.prompt(input, {
          responseConstraint: schema,
          signal: signal ? AbortSignal.any([signal, limit]) : limit,
        });
        return JSON.parse(stripFence(text)) as T;
      } catch (error) {
        if (!(error instanceof SyntaxError)) this.dropBase(system, modality);
        throw error;
      } finally {
        session.destroy();
      }
    });
  }
}

/** 일부 버전은 제약을 걸어도 ```json 울타리를 붙인다. */
export function stripFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

export const nano = new NanoEngine();
