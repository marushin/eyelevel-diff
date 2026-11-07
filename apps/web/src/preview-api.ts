export interface PreviewMetadata {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface PreviewInspection {
  mode: 'iframe' | 'proxy' | 'fallback';
  embedUrl?: string;
  finalUrl: string;
  reason?: string;
  meta?: PreviewMetadata;
}

const inspectionCache = new Map<string, PreviewInspection>();

export function clearPreviewInspectionCache(): void {
  inspectionCache.clear();
}

export function buildPreviewEndpointUrl(apiEndpoint: string): URL | null {
  const trimmed = apiEndpoint.trim();
  if (!trimmed) return null;
  const base = new URL(
    trimmed,
    typeof location === 'undefined' ? 'http://localhost' : location.origin,
  );
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
  if (base.pathname.endsWith('/search')) {
    base.pathname = `${base.pathname.slice(0, -'/search'.length) || ''}/preview`;
  } else if (!base.pathname.endsWith('/preview')) {
    base.pathname = `${base.pathname.replace(/\/$/, '')}/preview`;
  }
  base.search = '';
  base.hash = '';
  return base;
}

export async function inspectPreviewTarget(
  apiEndpoint: string,
  targetUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PreviewInspection> {
  const previewBase = buildPreviewEndpointUrl(apiEndpoint);
  if (!previewBase) {
    return { mode: 'iframe', embedUrl: targetUrl, finalUrl: targetUrl };
  }

  const cacheKey = `${previewBase.href}|${targetUrl}`;
  const cached = inspectionCache.get(cacheKey);
  if (cached) return cached;

  const inspectUrl = new URL(previewBase.href);
  inspectUrl.search = new URLSearchParams({ mode: 'inspect', url: targetUrl }).toString();

  const response = await fetchImpl(inspectUrl.href, {
    method: 'GET',
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    return { mode: 'fallback', finalUrl: targetUrl, reason: `http_${response.status}` };
  }

  const payload = (await response.json()) as Partial<PreviewInspection> | null;
  if (!payload || typeof payload !== 'object') {
    return { mode: 'fallback', finalUrl: targetUrl, reason: 'invalid_payload' };
  }

  const finalUrl = typeof payload.finalUrl === 'string' && payload.finalUrl ? payload.finalUrl : targetUrl;
  const mode = payload.mode === 'iframe' || payload.mode === 'proxy' ? payload.mode : 'fallback';
  let embedUrl: string | undefined;
  if (mode === 'iframe' || mode === 'proxy') {
    const rawEmbed = typeof payload.embedUrl === 'string' && payload.embedUrl ? payload.embedUrl : finalUrl;
    embedUrl = new URL(rawEmbed, previewBase.origin).href;
  }

  const normalized: PreviewInspection = {
    mode,
    ...(embedUrl ? { embedUrl } : {}),
    finalUrl,
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    ...(payload.meta && typeof payload.meta === 'object' ? { meta: payload.meta } : {}),
  };
  inspectionCache.set(cacheKey, normalized);
  return normalized;
}
