/**
 * 원본 apps/api/preview.js의 inspect 모드를 브라우저로 옮겼다.
 * - 프레임 삽입을 막지 않는 사이트는 그대로 iframe으로 띄운다.
 * - 막는 사이트는 받아 온 HTML에서 스크립트를 걷어 내고 <base>를 넣어 blob URL로 띄운다(proxy 모드).
 * - 읽을 수 없거나 스크립트 없이는 빈 껍데기인 문서는 메타데이터 요약(fallback)으로 보여 준다.
 */
import { fetchRemote } from './remote-fetch.ts';

export interface PreviewInspection {
  mode: 'iframe' | 'proxy' | 'fallback';
  embedUrl?: string;
  finalUrl: string;
  reason?: string;
  meta?: { title?: string; description?: string; image?: string; siteName?: string };
}

const MIN_SSR_TEXT_LENGTH = 200;
const BLOB_CACHE_SIZE = 12;
const blobCache = new Map<string, string>();

export function resolveNativeEmbedUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^(www|m)\./, '');
    let videoId: string | null = null;
    if (host === 'youtube.com') {
      if (parsed.pathname === '/watch') videoId = parsed.searchParams.get('v');
      else if (/^\/(shorts|embed)\//.test(parsed.pathname)) videoId = parsed.pathname.split('/')[2] ?? null;
    } else if (host === 'youtu.be') {
      videoId = parsed.pathname.slice(1).split('/')[0] ?? null;
    }
    if (videoId && /^[\w-]{6,20}$/.test(videoId)) return `https://www.youtube.com/embed/${videoId}`;
  } catch {
    // 잘못된 주소는 무시한다.
  }
  return null;
}

export function isBlockedByFrameHeaders(headers: Headers): boolean {
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase() ?? '';
  if (/deny|sameorigin|allow-from/.test(xfo)) return true;
  const csp = headers.get('content-security-policy') ?? '';
  for (const match of csp.matchAll(/(?:^|[;,])\s*frame-ancestors\s+([^;,]+)/gi)) {
    const tokens = match[1]!.trim().toLowerCase().split(/\s+/);
    if (!(tokens.includes('*') || tokens.includes('http:'))) return true;
  }
  return false;
}

function metaContent(doc: Document, selectors: string[]): string {
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    const value = (element?.getAttribute('content') ?? element?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (value) return value;
  }
  return '';
}

export function extractMetadata(doc: Document, baseUrl: string): NonNullable<PreviewInspection['meta']> {
  const rawImage = metaContent(doc, ['meta[property="og:image"]', 'meta[name="twitter:image"]']);
  let image = '';
  try {
    const resolved = rawImage ? new URL(rawImage, baseUrl) : null;
    if (resolved && /^https?:$/.test(resolved.protocol)) image = resolved.href;
  } catch {
    image = '';
  }
  return {
    title: metaContent(doc, ['meta[property="og:title"]', 'title']),
    description: metaContent(doc, ['meta[property="og:description"]', 'meta[name="description"]']),
    image,
    siteName: metaContent(doc, ['meta[property="og:site_name"]']),
  };
}

/**
 * 스크립트와 이벤트 속성을 걷어 낸 정적 문서. 링크는 새 탭에서 원문으로 열리게 한다.
 * iframe도 sandbox="allow-same-origin"(스크립트 없음)으로 띄우므로 이중으로 막힌다.
 */
export function sanitizeForProxy(doc: Document, finalUrl: string): string {
  doc.querySelectorAll('script, noscript, base, meta[http-equiv], iframe[src^="javascript:"], object, embed').forEach((node) => node.remove());
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) element.removeAttribute(attr.name);
    }
  }
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const lazy = img.getAttribute('data-src') ?? img.getAttribute('data-original') ?? img.getAttribute('data-lazy-src');
    const src = img.getAttribute('src') ?? '';
    if (lazy && (!src.trim() || src.startsWith('data:'))) img.setAttribute('src', lazy);
  }
  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    try {
      anchor.setAttribute('href', new URL(anchor.getAttribute('href')!, finalUrl).href);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    } catch {
      anchor.removeAttribute('href');
    }
  }
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  const base = doc.createElement('base');
  base.href = finalUrl;
  const referrer = doc.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(charset, base, referrer);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function visibleTextLength(doc: Document): number {
  const clone = doc.body?.cloneNode(true) as HTMLElement | undefined;
  if (!clone) return 0;
  clone.querySelectorAll('script, style, noscript, template, svg').forEach((node) => node.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

function rememberBlob(key: string, html: string): string {
  const existing = blobCache.get(key);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  blobCache.set(key, url);
  if (blobCache.size > BLOB_CACHE_SIZE) {
    const [oldKey, oldUrl] = blobCache.entries().next().value!;
    blobCache.delete(oldKey);
    URL.revokeObjectURL(oldUrl);
  }
  return url;
}

export async function inspectPreview(rawUrl: string, signal?: AbortSignal): Promise<PreviewInspection> {
  const nativeEmbed = resolveNativeEmbedUrl(rawUrl);
  if (nativeEmbed) return { mode: 'iframe', embedUrl: nativeEmbed, finalUrl: rawUrl };

  let remote;
  try {
    remote = await fetchRemote(rawUrl, { signal, timeoutMs: 10_000 });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { mode: 'fallback', finalUrl: rawUrl, reason: 'upstream_unreachable', meta: {} };
  }
  const { finalUrl } = remote;
  const redirectedEmbed = resolveNativeEmbedUrl(finalUrl);
  if (redirectedEmbed) return { mode: 'iframe', embedUrl: redirectedEmbed, finalUrl };

  const isHtml = !remote.contentType || /text\/html|application\/xhtml\+xml/i.test(remote.contentType);
  if (remote.ok && isHtml && !isBlockedByFrameHeaders(remote.headers)) return { mode: 'iframe', embedUrl: finalUrl, finalUrl };
  if (!remote.ok || !isHtml) return { mode: 'fallback', finalUrl, reason: remote.ok ? 'non_html' : `http_${remote.status}`, meta: {} };

  const doc = new DOMParser().parseFromString(remote.html, 'text/html');
  const meta = extractMetadata(doc, finalUrl);
  if (visibleTextLength(doc) < MIN_SSR_TEXT_LENGTH) return { mode: 'fallback', finalUrl, reason: 'client_only_shell', meta };
  return { mode: 'proxy', embedUrl: rememberBlob(finalUrl, sanitizeForProxy(doc, finalUrl)), finalUrl, meta };
}
