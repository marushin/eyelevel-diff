/**
 * Chrome 내장 Translator API(온디바이스)로 영어 결과를 한국어로 옮긴다.
 * Prompt API가 한국어 출력을 공식 지원하지 않아, Nano가 영어로 답한 검색어와 이미지 설명에 쓴다.
 * 번역기를 쓸 수 없으면 원문을 그대로 돌려준다(검색과 임베딩은 영어로도 동작한다).
 */
export type TranslatorStatus = 'ready' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

interface TranslatorInstance { translate(text: string, options?: { signal?: AbortSignal }): Promise<string>; destroy?(): void }
interface TranslatorStatic {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void }): Promise<TranslatorInstance>;
}

const PAIR = { sourceLanguage: 'en', targetLanguage: 'ko' };
const HANGUL = /[ㄱ-ㆎ가-힣]/;

function api(): TranslatorStatic | null {
  return (globalThis as unknown as { Translator?: TranslatorStatic }).Translator ?? null;
}

let instance: Promise<TranslatorInstance> | null = null;

export async function translatorStatus(): Promise<TranslatorStatus> {
  const translator = api();
  if (!translator) return 'unsupported';
  try {
    const raw = await translator.availability(PAIR);
    if (raw === 'available' || raw === 'readily') return 'ready';
    if (raw === 'downloadable' || raw === 'after-download') return 'downloadable';
    if (raw === 'downloading') return 'downloading';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** 번역 모델 다운로드. 사용자 클릭 핸들러 안에서 불러야 한다. */
export async function activateTranslator(onProgress?: (ratio: number) => void): Promise<TranslatorStatus> {
  const translator = api();
  if (!translator) return 'unsupported';
  instance = translator.create({
    ...PAIR,
    monitor: onProgress ? (m) => m.addEventListener('downloadprogress', (event) => onProgress((event as unknown as { loaded: number }).loaded)) : undefined,
  });
  instance.catch(() => { instance = null; });
  await instance;
  return translatorStatus();
}

export const hasHangul = (text: string) => HANGUL.test(text);

/** 한글이 없는 문자열만 옮긴다. 실패하면 원문을 돌려준다. */
export async function toKorean(texts: string[], signal?: AbortSignal): Promise<string[]> {
  if (!texts.some((text) => text && !hasHangul(text))) return texts;
  if ((await translatorStatus()) !== 'ready') return texts;
  try {
    instance ??= api()!.create(PAIR);
    const translator = await instance;
    return await Promise.all(texts.map(async (text) => {
      if (!text || hasHangul(text)) return text;
      const translated = (await translator.translate(text, { signal })).trim();
      return translated || text;
    }));
  } catch (error) {
    if (signal?.aborted) throw error;
    instance = null;
    return texts;
  }
}
