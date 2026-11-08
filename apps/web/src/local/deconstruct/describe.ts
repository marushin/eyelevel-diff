/**
 * 원본 apps/deconstruct/src/describe/describeImages.js와 fetchImage.js의 브라우저 판.
 * 이미지 노드에 meta.description을 채운다. alt나 캡션이 뜻을 가지면 그대로 쓰고, 없는 이미지 중
 * 큰 것부터 페이지당 정해진 개수만 선택한 LLM(기본 Gemini Nano)으로 설명한다. sharp 대신 createImageBitmap과
 * OffscreenCanvas로 줄이고 단색 이미지를 걸러 낸다. 실패해도 요청을 실패시키지 않는다.
 */
import { readBoundedBytes, withTimeout } from '../remote-fetch.ts';
import { toKorean } from '../translate.ts';
import type { PageNode } from './extract.ts';
import type { ImageDescriber } from './llm-finders.ts';

const VECTOR_FILE = /\.svgz?($|\?)/i;
const BLANK_STDEV = 3;
const GENERIC_WORDS = new Set([
  'image', 'img', 'photo', 'picture', 'pic', 'banner', 'icon', 'thumbnail', 'thumb', 'logo', 'untitled', 'default', 'placeholder', 'alt',
  '이미지', '사진', '그림', '배너', '썸네일', '아이콘', '로고', '대체텍스트',
]);

/** 사이트가 넣은 글자가 이미지를 설명하는지 판별한다(원본과 같은 규칙). */
export function isMeaningfulText(raw: string | null | undefined): boolean {
  const text = (raw ?? '').trim();
  if (text.length < 2 || !/\p{L}/u.test(text)) return false;
  if (/^(https?:\/\/|www\.)/i.test(text) || (/\.[a-z0-9]{2,5}$/i.test(text) && !/\s/.test(text))) return false;
  const withoutNumbers = text.toLowerCase().replace(/[\s_\-.()\d]+/g, '');
  if (GENERIC_WORDS.has(withoutNumbers)) return false;
  if (/\s/.test(text)) return true;
  if (text.includes('_')) return false;
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(text)) return false;
  return !(text.length >= 6 && /\d/.test(text) && /[a-z]/i.test(text));
}

const declaredDescription = (meta: Record<string, any>) =>
  [meta.alt, meta.caption, meta.ariaLabel, meta.title]
    .map((value) => String(value ?? '').trim())
    .filter(isMeaningfulText)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(' ');

export const BLANK_IMAGE = Symbol('blank image');

/** 픽셀의 채널별 표준편차가 모두 작으면 사실상 한 가지 색이다. */
export function isBlankPixels(data: Uint8ClampedArray): boolean {
  const pixels = data.length / 4;
  if (!pixels) return true;
  for (let channel = 0; channel < 3; channel += 1) {
    let sum = 0;
    let squares = 0;
    for (let i = channel; i < data.length; i += 4) {
      sum += data[i]!;
      squares += data[i]! * data[i]!;
    }
    const mean = sum / pixels;
    if (Math.sqrt(Math.max(0, squares / pixels - mean * mean)) >= BLANK_STDEV) return false;
  }
  return true;
}

export interface VisionLimits { maxPerPage: number; maxEdge: number; minEdge: number; maxImageBytes: number; fetchTimeoutMs: number; unknownArea: number }

/** 이미지를 받아 긴 변을 줄인 JPEG Blob으로 만든다. 너무 작으면 null, 단색이면 BLANK_IMAGE. */
export async function prepareImage(url: string, limits: VisionLimits, signal?: AbortSignal): Promise<Blob | null | typeof BLANK_IMAGE> {
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'image/*' }, signal: withTimeout(signal, limits.fetchTimeoutMs) });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.startsWith('image/') || type.includes('svg')) {
    response.body?.cancel().catch(() => {});
    return null;
  }
  const { bytes, truncated } = await readBoundedBytes(response, limits.maxImageBytes);
  if (truncated) return null;
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
  try {
    if (Math.max(bitmap.width, bitmap.height) < limits.minEdge) return null;
    const scale = Math.min(1, limits.maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    if (isBlankPixels(context.getImageData(0, 0, width, height).data)) return BLANK_IMAGE;
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  } finally {
    bitmap.close();
  }
}

export function createImageDescriber({ describer, limits }: { describer: ImageDescriber | null; limits: VisionLimits }) {
  const cache = new Map<string, string>();
  const cacheKey = (url: string) => `${describer?.cacheKey}\0${url}`;

  return async function describeImages(nodes: PageNode[], { signal, onProgress }: { signal?: AbortSignal; onProgress?: (message: string) => void } = {}) {
    const stats = { declared: 0, vision: 0, cached: 0, none: 0, skipped: 0, failed: 0, blank: 0 };
    const candidates: PageNode[] = [];
    for (const node of nodes) {
      if (node.type !== 'img') continue;
      const declared = declaredDescription(node.meta);
      if (declared) {
        node.meta.description = declared;
        node.meta.descriptionSource = 'declared';
        stats.declared += 1;
        continue;
      }
      const cached = describer && cache.get(cacheKey(node.content));
      if (cached) {
        node.meta.description = cached;
        node.meta.descriptionSource = 'vision';
        stats.cached += 1;
      } else if (describer && !VECTOR_FILE.test(node.content)) {
        candidates.push(node);
      } else {
        stats.none += 1;
      }
    }

    const area = (node: PageNode) => (node.meta.width && node.meta.height ? node.meta.width * node.meta.height : limits.unknownArea);
    candidates.sort((a, b) => area(b) - area(a));
    const selected = candidates.slice(0, limits.maxPerPage);
    stats.skipped = candidates.length - selected.length;

    const blank = new Set<PageNode>();
    let index = 0;
    for (const node of selected) {
      signal?.throwIfAborted();
      index += 1;
      onProgress?.(`${describer!.label ?? 'LLM'} · 이미지를 보는 중 (${index}/${selected.length})`);
      try {
        const image = await prepareImage(node.content, limits, signal);
        if (image === BLANK_IMAGE) {
          blank.add(node);
          stats.blank += 1;
          continue;
        }
        if (!image) {
          stats.none += 1;
          continue;
        }
        // 설명은 재검색어(label)로도 쓰이므로, 영어로 나오면 한국어로 옮긴다(번역기가 없으면 영어 그대로).
        const [description] = await toKorean([await describer!.describe(image, signal)], signal);
        if (!description) {
          stats.failed += 1;
          continue;
        }
        node.meta.description = description;
        node.meta.descriptionSource = 'vision';
        cache.set(cacheKey(node.content), description);
        stats.vision += 1;
      } catch (error) {
        if (signal?.aborted) throw error;
        stats.failed += 1;
      }
    }

    const warnings: string[] = [];
    if (stats.skipped) warnings.push(`vision-skipped:${stats.skipped}`);
    if (stats.failed) warnings.push(`vision-failed:${stats.failed}`);
    return { nodes: nodes.filter((node) => !blank.has(node)), stats, warnings };
  };
}
