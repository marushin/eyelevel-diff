/**
 * 다른 사이트의 문서를 브라우저에서 직접 읽는다. CORS를 끈 전용 Chrome 프로필에서만 동작한다.
 * 쿠키는 보내지 않는다(credentials: 'omit'). 전용 프로필이라도 로그인 상태가 섞이지 않게 하기 위해서다.
 */
import { errors } from './errors.ts';

export interface RemoteDocument {
  status: number;
  ok: boolean;
  finalUrl: string;
  contentType: string;
  headers: Headers;
  html: string;
}

/** 원래 신호와 제한 시간을 합친다. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function readBoundedBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    return all.byteLength > maxBytes ? { bytes: all.subarray(0, maxBytes), truncated: true } : { bytes: all, truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
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
  return { bytes: merged, truncated };
}

/** 한국 사이트에 남아 있는 EUC-KR 문서를 깨지지 않게 읽는다. */
export function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const header = contentType.match(/charset\s*=\s*["']?([\w.-]+)/i)?.[1];
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 4096)));
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.-]+)/i)?.[1];
  const charset = (header ?? meta ?? 'utf-8').toLowerCase();
  const label = ['euc-kr', 'cp949', 'ks_c_5601-1987', 'x-windows-949'].includes(charset) ? 'euc-kr' : charset;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)/i;

export async function fetchRemote(url: string, { signal, timeoutMs = 20_000, maxBytes = 8 * 1024 * 1024, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }:
  { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; accept?: string } = {}): Promise<RemoteDocument> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      headers: { Accept: accept, 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
      signal: withTimeout(signal, timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === 'TimeoutError') throw errors.pageTimeout();
    throw errors.fetchFailed();
  }
  const contentType = response.headers.get('content-type') ?? '';
  let html = '';
  if (!contentType || HTML_TYPES.test(contentType)) {
    const { bytes, truncated } = await readBoundedBytes(response, maxBytes);
    if (truncated) throw errors.pageTooLarge();
    html = decodeHtml(bytes, contentType);
  } else {
    response.body?.cancel().catch(() => {});
  }
  return { status: response.status, ok: response.ok, finalUrl: response.url || url, contentType, headers: response.headers, html };
}

/**
 * CORS가 꺼져 있는지 확인한다. 켜져 있으면 다른 출처의 fetch가 TypeError로 끝난다.
 */
export async function isCrossOriginReadable(probeUrl = 'https://www.bing.com/robots.txt'): Promise<boolean> {
  try {
    const response = await fetch(probeUrl, { credentials: 'omit', signal: AbortSignal.timeout(8_000) });
    await response.text();
    return true;
  } catch {
    return false;
  }
}
