/**
 * Chrome 내장 Translator API(온디바이스). Gemini Nano(Prompt API)가 한국어 입출력을 공식 지원하지 않아
 * (Chrome 156 기준 de, en, es, fr, ja), Nano로 한국어 검색을 할 때는 반드시 번역을 거친다.
 *
 *   한국어 입력 → (한→영) → Nano는 영어로 답함 → (영→한) → 한국어 결과
 *
 * 영→한은 필수(없으면 Nano 대신 한국어 대체 검색어·alt 문구를 쓴다), 한→영은 있으면 Nano가 입력을 더 잘
 * 이해하도록 돕는 선택 단계다(없으면 한국어 원문을 그대로 넘긴다). Claude·OpenAI는 한국어로 바로 답하므로
 * 이 경로를 쓰지 않는다.
 */
export type TranslatorStatus = 'ready' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

interface TranslatorInstance { translate(text: string, options?: { signal?: AbortSignal }): Promise<string>; destroy?(): void }
interface TranslatorStatic {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void }): Promise<TranslatorInstance>;
}

type Pair = { sourceLanguage: string; targetLanguage: string };
const TO_KOREAN: Pair = { sourceLanguage: 'en', targetLanguage: 'ko' };
const TO_ENGLISH: Pair = { sourceLanguage: 'ko', targetLanguage: 'en' };
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const KANA = /[぀-ヿㇰ-ㇿ]/;

function api(): TranslatorStatic | null {
  return (globalThis as unknown as { Translator?: TranslatorStatic }).Translator ?? null;
}

const instances = new Map<string, Promise<TranslatorInstance>>();

/** 만들어 둔 번역기를 버린다(테스트용). */
export function resetTranslators(): void {
  instances.clear();
}
const keyOf = (pair: Pair) => `${pair.sourceLanguage}>${pair.targetLanguage}`;

async function pairStatus(pair: Pair): Promise<TranslatorStatus> {
  const translator = api();
  if (!translator) return 'unsupported';
  try {
    const raw = await translator.availability(pair);
    if (raw === 'available' || raw === 'readily') return 'ready';
    if (raw === 'downloadable' || raw === 'after-download') return 'downloadable';
    if (raw === 'downloading') return 'downloading';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** 필수인 영→한 번역기의 상태. 패널과 한국어 경로 판단에 쓴다. */
export function translatorStatus(): Promise<TranslatorStatus> {
  return pairStatus(TO_KOREAN);
}

/**
 * 번역 모델 다운로드. 사용자 클릭 핸들러 안에서 불러야 한다. 사용자 활성화가 유지되는 동안
 * 두 방향(영→한 필수, 한→영 선택)을 함께 시작한다.
 */
export async function activateTranslator(onProgress?: (ratio: number) => void): Promise<TranslatorStatus> {
  const translator = api();
  if (!translator) return 'unsupported';
  const monitor = onProgress ? (m: EventTarget) => m.addEventListener('downloadprogress', (event) => onProgress((event as unknown as { loaded: number }).loaded)) : undefined;
  const toKo = translator.create({ ...TO_KOREAN, monitor });
  const toEn = translator.create(TO_ENGLISH);
  instances.set(keyOf(TO_KOREAN), toKo);
  instances.set(keyOf(TO_ENGLISH), toEn);
  toKo.catch(() => instances.delete(keyOf(TO_KOREAN)));
  toEn.catch(() => instances.delete(keyOf(TO_ENGLISH)));
  await toKo;
  return translatorStatus();
}

export const hasHangul = (text: string) => HANGUL.test(text);

/** 한국어 검색어로 내보내도 되는지: 한글이 있고 일본어 가나가 섞이지 않았다. */
export const isKoreanText = (text: string) => HANGUL.test(text) && !KANA.test(text);

async function translateAll(pair: Pair, texts: string[], skip: (text: string) => boolean, signal?: AbortSignal): Promise<string[]> {
  if (!texts.some((text) => text && !skip(text))) return texts;
  if ((await pairStatus(pair)) !== 'ready') return texts;
  const key = keyOf(pair);
  try {
    if (!instances.has(key)) instances.set(key, api()!.create(pair));
    const translator = await instances.get(key)!;
    return await Promise.all(texts.map(async (text) => {
      if (!text || skip(text)) return text;
      const translated = (await translator.translate(text, { signal })).trim();
      return translated || text;
    }));
  } catch (error) {
    if (signal?.aborted) throw error;
    instances.delete(key);
    return texts;
  }
}

/** 영어 → 한국어. 한글이 있는 문자열은 그대로 둔다. 번역기가 없거나 실패하면 원문을 돌려준다. */
export function toKorean(texts: string[], signal?: AbortSignal): Promise<string[]> {
  return translateAll(TO_KOREAN, texts, hasHangul, signal);
}

/** 한국어 → 영어(Nano 입력용, 선택). 한글이 없는 문자열은 그대로 둔다. 번역기가 없으면 원문을 돌려준다. */
export function toEnglish(texts: string[], signal?: AbortSignal): Promise<string[]> {
  return translateAll(TO_ENGLISH, texts, (text) => !hasHangul(text), signal);
}
