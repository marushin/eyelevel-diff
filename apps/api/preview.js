import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_REDIRECT_HOPS = 5;
const MAX_HTML_BYTES = 512 * 1024;
const MIN_SSR_TEXT_LENGTH = 120;
const PREVIEW_CACHE_MAX = 32;
const PREVIEW_CACHE_TTL_MS = 60_000;

const previewHtmlCache = new Map();

export function clearPreviewCacheForTest() {
  previewHtmlCache.clear();
}

export class UnsafeUrlError extends Error {
  constructor(message = 'URL is not allowed') {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function stripIpv6Zone(ip) {
  const bracketStripped = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const zoneIdx = bracketStripped.indexOf('%');
  return zoneIdx === -1 ? bracketStripped : bracketStripped.slice(0, zoneIdx);
}

export function isPrivateOrReservedIp(rawIp) {
  const ip = stripIpv6Zone(rawIp.trim().toLowerCase());
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b, c] = parts;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return true;
    }
    return false;
  }
  if (version === 6) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('::ffff:')) {
      const suffix = ip.slice('::ffff:'.length);
      if (isIP(suffix) === 4) return isPrivateOrReservedIp(suffix);
      const hexMatch = suffix.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hexMatch) {
        const hi = Number.parseInt(hexMatch[1], 16);
        const lo = Number.parseInt(hexMatch[2], 16);
        const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
        return isPrivateOrReservedIp(v4);
      }
      return true;
    }
    if (
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      ip.startsWith('fe8') ||
      ip.startsWith('fe9') ||
      ip.startsWith('fea') ||
      ip.startsWith('feb') ||
      ip.startsWith('ff')
    ) {
      return true;
    }
    return false;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (!lower) return true;
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.invalid') ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }
  const bare = stripIpv6Zone(lower);
  if (isIP(bare)) return isPrivateOrReservedIp(bare);
  return false;
}

export async function assertSafePublicUrl(rawUrl, { lookupImpl, fetchImpl = globalThis.fetch } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https URLs are supported');
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError('Credentials in URL are not allowed');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new UnsafeUrlError('Private or local host is not allowed');
  }

  const effectiveLookup =
    lookupImpl !== undefined ? lookupImpl : fetchImpl === globalThis.fetch ? dnsLookup : null;
  if (effectiveLookup && !isIP(stripIpv6Zone(parsed.hostname))) {
    let records;
    try {
      records = await effectiveLookup(parsed.hostname, { all: true, verbatim: true });
    } catch {
      throw new UnsafeUrlError('Unable to resolve hostname');
    }
    const list = Array.isArray(records) ? records : [records];
    if (!list.length || list.some((entry) => !entry?.address || isPrivateOrReservedIp(entry.address))) {
      throw new UnsafeUrlError('Resolved address is not allowed');
    }
  }
  return parsed;
}

export function isGoogleRedirectUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const isGoogleHost = /^(?:www\.)?google\.(?:com|[a-z]{2,3}(?:\.[a-z]{2})?)$/i.test(parsed.hostname);
    return isGoogleHost && (parsed.pathname === '/goto' || parsed.pathname === '/url');
  } catch {
    return false;
  }
}

function combinedSignal(parentSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

function decodeBasicHtmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function unwrapDirectGoogleRedirectParam(rawUrl) {
  if (!isGoogleRedirectUrl(rawUrl)) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    for (const key of ['q', 'url']) {
      const candidate = parsed.searchParams.get(key)?.trim();
      if (candidate && /^https?:\/\//i.test(candidate) && !isGoogleRedirectUrl(candidate)) {
        const target = new URL(candidate);
        if (
          (target.protocol === 'http:' || target.protocol === 'https:') &&
          !target.username &&
          !target.password &&
          !isBlockedHostname(target.hostname)
        ) {
          return target.href;
        }
      }
    }
  } catch {
    // Keep original URL when malformed.
  }
  return rawUrl;
}

export async function unwrapGoogleRedirectUrl(
  rawUrl,
  { fetchImpl = globalThis.fetch, lookupImpl, signal, timeoutMs = 4_000 } = {},
) {
  if (!isGoogleRedirectUrl(rawUrl)) return rawUrl;

  const direct = unwrapDirectGoogleRedirectParam(rawUrl);
  if (direct !== rawUrl) {
    try {
      await assertSafePublicUrl(direct, { lookupImpl, fetchImpl });
      return direct;
    } catch {
      return rawUrl;
    }
  }

  try {
    const response = await fetchImpl(new URL(rawUrl), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: combinedSignal(signal, timeoutMs),
    });

    const locationHeader = response.headers.get('location')?.trim();
    if (locationHeader) {
      response.body?.cancel?.().catch(() => {});
      const resolved = new URL(locationHeader, rawUrl).href;
      if (!isGoogleRedirectUrl(resolved)) {
        await assertSafePublicUrl(resolved, { lookupImpl, fetchImpl });
        return resolved;
      }
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('text/html')) {
      const bytes = await readBoundedBytes(response, 8 * 1024);
      const text = new TextDecoder('utf-8').decode(bytes);
      const anchorMatch = text.match(/<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["']/i);
      if (anchorMatch) {
        const resolved = new URL(decodeBasicHtmlEntities(anchorMatch[1]), rawUrl).href;
        if (!isGoogleRedirectUrl(resolved)) {
          await assertSafePublicUrl(resolved, { lookupImpl, fetchImpl });
          return resolved;
        }
      }
    } else {
      response.body?.cancel?.().catch(() => {});
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  return rawUrl;
}

export function resolveNativeEmbedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    let videoId = null;
    if (host === 'youtube.com') {
      if (parsed.pathname === '/watch') {
        videoId = parsed.searchParams.get('v');
      } else if (parsed.pathname.startsWith('/shorts/') || parsed.pathname.startsWith('/embed/')) {
        videoId = parsed.pathname.split('/')[2] ?? null;
      }
    } else if (host === 'youtu.be') {
      videoId = parsed.pathname.slice(1).split('/')[0] ?? null;
    }
    if (videoId && /^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      return `https://www.youtube.com/embed/${videoId}`;
    }
  } catch {
    // Ignore malformed URLs.
  }
  return null;
}

export function isBlockedByFrameHeaders(headers) {
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase() ?? '';
  if (xfo && (xfo.includes('deny') || xfo.includes('sameorigin') || xfo.includes('allow-from'))) {
    return true;
  }
  const csp = headers.get('content-security-policy') ?? '';
  if (csp) {
    const matches = [...csp.matchAll(/(?:^|[;,])\s*frame-ancestors\s+([^;,]+)/gi)];
    for (const match of matches) {
      const tokens = match[1].trim().toLowerCase().split(/\s+/).filter(Boolean);
      const allowsAllHttp =
        tokens.includes('*') || (tokens.includes('http:') && tokens.includes('https:')) || tokens.includes('http:');
      if (!allowsAllHttp) return true;
    }
  }
  return false;
}

async function readBoundedBytes(response, maxBytes) {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function detectHtmlCharset(bytes, contentTypeHeader) {
  const headerMatch = (contentTypeHeader ?? '').match(/charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i);
  const headAscii = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 2048)));
  const metaMatch = headAscii.match(/charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i);
  const rawCharset = (headerMatch?.[1] ?? metaMatch?.[1] ?? 'utf-8').toLowerCase();
  if (rawCharset === 'euc-kr' || rawCharset === 'cp949' || rawCharset === 'ks_c_5601-1987') {
    return 'euc-kr';
  }
  return 'utf-8';
}

function decodeHtmlBytes(bytes, contentTypeHeader) {
  const charset = detectHtmlCharset(bytes, contentTypeHeader);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function escapeHtmlAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractMetaContent(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const cleaned = decodeBasicHtmlEntities(match[1].replace(/\s+/g, ' ').trim());
      if (cleaned) return cleaned;
    }
  }
  return '';
}

export function extractHtmlMetadata(html, baseUrl) {
  const title = extractMetaContent(html, [
    /<meta\b[^>]*\bproperty=["']og:title["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:title["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ]);
  const description = extractMetaContent(html, [
    /<meta\b[^>]*\bproperty=["']og:description["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:description["']/i,
    /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']description["']/i,
  ]);
  const rawImage = extractMetaContent(html, [
    /<meta\b[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:image["']/i,
  ]);
  const siteName = extractMetaContent(html, [
    /<meta\b[^>]*\bproperty=["']og:site_name["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:site_name["']/i,
  ]);

  let image = '';
  if (rawImage) {
    try {
      const resolved = new URL(rawImage, baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        image = resolved.href;
      }
    } catch {
      image = '';
    }
  }

  return { title, description, image, siteName };
}

function measureVisibleTextLength(html) {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const region = bodyMatch ? bodyMatch[1] : html;
  const stripped = region
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length;
}

export function sanitizeProxiedHtml(html, finalUrl) {
  let sanitized = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(
      /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?(?:content-security-policy|x-frame-options|refresh)["']?[^>]*>/gi,
      '',
    )
    .replace(/<meta\b[^>]*\bcharset\s*=\s*["']?[^"'>\s]+["']?[^>]*>/gi, '')
    .replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-type["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '')
    .replace(/\b(href|src|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');

  // Promote lazy-loaded images when src is missing or a blank data placeholder.
  sanitized = sanitized.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    const lazyMatch = attrs.match(/\bdata-(?:src|original|lazy-src)=["']([^"']+)["']/i);
    if (!lazyMatch) return full;
    const srcMatch = attrs.match(/\bsrc=["']([^"']*)["']/i);
    if (!srcMatch) {
      return `<img src="${escapeHtmlAttr(lazyMatch[1])}"${attrs}>`;
    }
    if (!srcMatch[1].trim() || srcMatch[1].startsWith('data:image/gif')) {
      return `<img${attrs.replace(/\bsrc=["'][^"']*["']/i, `src="${escapeHtmlAttr(lazyMatch[1])}"`)}>`;
    }
    return full;
  });

  // Rewrite external/relative HTTP(S) anchor links to stay inside /preview without opening new tabs.
  sanitized = sanitized.replace(/<a\b([^>]*)>/gi, (full, rawAttrs) => {
    let attrs = rawAttrs.replace(/\s+\btarget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '');
    const hrefMatch = attrs.match(/\bhref\s*=\s*(["'])([^"']*)\1/i);
    if (!hrefMatch) return `<a${attrs}>`;
    const quote = hrefMatch[1];
    const rawHref = decodeBasicHtmlEntities(hrefMatch[2].trim());
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('/preview?')) {
      return `<a${attrs}>`;
    }
    try {
      const resolved = new URL(rawHref, finalUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        const inAppHref = `/preview?url=${encodeURIComponent(resolved.href)}`;
        attrs = attrs.replace(
          /\bhref\s*=\s*(["'])[^"']*\1/i,
          `href=${quote}${escapeHtmlAttr(inAppHref)}${quote}`,
        );
      }
    } catch {
      // Keep original href if malformed.
    }
    return `<a target="_self"${attrs}>`;
  });

  const injectedHead = `<meta charset="utf-8"><base href="${escapeHtmlAttr(finalUrl)}" target="_self"><meta name="referrer" content="no-referrer">`;
  if (/<head\b[^>]*>/i.test(sanitized)) {
    sanitized = sanitized.replace(/<head\b[^>]*>/i, (tag) => `${tag}${injectedHead}`);
  } else {
    sanitized = `<!doctype html><html><head>${injectedHead}</head><body>${sanitized}</body></html>`;
  }
  return sanitized;
}

function putPreviewCache(url, entry) {
  const now = Date.now();
  for (const [key, item] of previewHtmlCache) {
    if (item.expiresAt <= now) previewHtmlCache.delete(key);
  }
  if (previewHtmlCache.size >= PREVIEW_CACHE_MAX) {
    const oldestKey = previewHtmlCache.keys().next().value;
    if (oldestKey !== undefined) previewHtmlCache.delete(oldestKey);
  }
  previewHtmlCache.set(url, { ...entry, expiresAt: now + PREVIEW_CACHE_TTL_MS });
}

function getPreviewCache(url) {
  const entry = previewHtmlCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    previewHtmlCache.delete(url);
    return null;
  }
  return entry;
}

async function fetchFollowingSafeRedirects(
  initialUrl,
  { fetchImpl = globalThis.fetch, lookupImpl, signal, timeoutMs = 8_000 } = {},
) {
  let currentUrl = (await assertSafePublicUrl(initialUrl, { lookupImpl, fetchImpl })).href;
  const activeSignal = combinedSignal(signal, timeoutMs);

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const googleHop = isGoogleRedirectUrl(currentUrl);
    const response = await fetchImpl(new URL(currentUrl), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        ...(googleHop
          ? {}
          : {
              'Sec-Fetch-Dest': 'iframe',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'cross-site',
            }),
      },
      signal: activeSignal,
    });

    if (response.status >= 300 && response.status < 400) {
      const locationHeader = response.headers.get('location')?.trim();
      response.body?.cancel?.().catch(() => {});
      if (!locationHeader || hop === MAX_REDIRECT_HOPS) {
        throw new Error('Too many or invalid redirects');
      }
      const nextUrl = new URL(locationHeader, currentUrl).href;
      currentUrl = (await assertSafePublicUrl(nextUrl, { lookupImpl, fetchImpl })).href;
      continue;
    }

    // Handle Google's HTML 200/302 wrapper if encountered directly.
    if (isGoogleRedirectUrl(currentUrl) && (response.headers.get('content-type') ?? '').includes('text/html')) {
      const bytes = await readBoundedBytes(response, 8 * 1024);
      const html = new TextDecoder('utf-8').decode(bytes);
      const anchorMatch = html.match(/<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["']/i);
      if (anchorMatch && hop < MAX_REDIRECT_HOPS) {
        const nextUrl = new URL(decodeBasicHtmlEntities(anchorMatch[1]), currentUrl).href;
        currentUrl = (await assertSafePublicUrl(nextUrl, { lookupImpl, fetchImpl })).href;
        continue;
      }
    }

    return { response, finalUrl: currentUrl };
  }

  throw new Error('Redirect limit exceeded');
}

export async function inspectOrRenderPreview(
  rawUrl,
  { mode = 'inspect', fetchImpl = globalThis.fetch, lookupImpl, signal, timeoutMs = 8_000 } = {},
) {
  const safeInitial = (await assertSafePublicUrl(rawUrl, { lookupImpl, fetchImpl })).href;

  const nativeEmbed = resolveNativeEmbedUrl(safeInitial);
  if (nativeEmbed && mode === 'inspect') {
    return {
      kind: 'json',
      body: { mode: 'iframe', embedUrl: nativeEmbed, finalUrl: safeInitial },
    };
  }

  if (mode === 'html') {
    const cached = getPreviewCache(safeInitial);
    if (cached) {
      return { kind: 'html', html: cached.html, finalUrl: cached.finalUrl };
    }
  }

  let fetched;
  try {
    fetched = await fetchFollowingSafeRedirects(safeInitial, { fetchImpl, lookupImpl, signal, timeoutMs });
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error;
    if (signal?.aborted) throw error;
    if (mode === 'inspect') {
      return {
        kind: 'json',
        body: { mode: 'fallback', finalUrl: safeInitial, reason: 'upstream_unreachable', meta: {} },
      };
    }
    throw error;
  }

  const { response, finalUrl } = fetched;
  const postRedirectEmbed = resolveNativeEmbedUrl(finalUrl);
  if (postRedirectEmbed && mode === 'inspect') {
    response.body?.cancel?.().catch(() => {});
    return {
      kind: 'json',
      body: { mode: 'iframe', embedUrl: postRedirectEmbed, finalUrl },
    };
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
  const blockedByHeaders = isBlockedByFrameHeaders(response.headers);

  if (mode === 'inspect' && response.ok && !blockedByHeaders && (isHtml || !contentType)) {
    response.body?.cancel?.().catch(() => {});
    return {
      kind: 'json',
      body: { mode: 'iframe', embedUrl: finalUrl, finalUrl },
    };
  }

  if (!response.ok || !isHtml) {
    response.body?.cancel?.().catch(() => {});
    if (mode === 'inspect') {
      return {
        kind: 'json',
        body: {
          mode: 'fallback',
          finalUrl,
          reason: !response.ok ? `http_${response.status}` : 'non_html',
          meta: {},
        },
      };
    }
    throw new Error(`Preview unavailable (${response.status})`);
  }

  const bytes = await readBoundedBytes(response, MAX_HTML_BYTES);
  const html = decodeHtmlBytes(bytes, contentType);
  const meta = extractHtmlMetadata(html, finalUrl);
  const textLen = measureVisibleTextLength(html);

  if (textLen < MIN_SSR_TEXT_LENGTH) {
    if (mode === 'inspect') {
      return {
        kind: 'json',
        body: { mode: 'fallback', finalUrl, reason: 'client_only_shell', meta },
      };
    }
    throw new Error('Client-only page has insufficient static HTML');
  }

  const sanitized = sanitizeProxiedHtml(html, finalUrl);
  putPreviewCache(finalUrl, { html: sanitized, finalUrl, meta });
  if (finalUrl !== safeInitial) {
    putPreviewCache(safeInitial, { html: sanitized, finalUrl, meta });
  }

  if (mode === 'inspect') {
    return {
      kind: 'json',
      body: {
        mode: 'proxy',
        embedUrl: `/preview?url=${encodeURIComponent(finalUrl)}`,
        finalUrl,
        meta,
      },
    };
  }

  return { kind: 'html', html: sanitized, finalUrl };
}
