/**
 * 원본 apps/deconstruct/src/extract/extractPage.js의 브라우저 판.
 *
 * Playwright 대신 문서를 fetch로 받아 숨은 iframe(srcdoc)에 띄우고, 원본이 페이지에 주입하던 함수
 * (autoScroll, waitForDomQuiet, collectFrameNodes)를 그 iframe 안에서 그대로 실행한다.
 * srcdoc으로 띄우므로 X-Frame-Options에 막히지 않고, 페이지 스크립트가 돌아 지연 렌더링도 잡힌다.
 *
 * 주의: 페이지 스크립트가 이 앱과 같은 출처에서 돈다. sandbox로 최상위 이동, 팝업, 대화상자는 막지만
 * 로컬 전용 도구라는 전제에서만 받아들일 수 있는 구조다.
 */
import { errors } from '../errors.ts';
import { HTML_TYPES, fetchRemote } from '../remote-fetch.ts';
import { autoScroll, collectFrameNodes, forceOpenShadowRoots, waitForDomQuiet } from './in-page.js';
import { normalizeNodes } from './normalize.js';
import { config } from './config.ts';

export interface PageNode {
  type: 'text' | 'img';
  content: string;
  meta: Record<string, any>;
  embedding?: number[];
}

export interface Extracted { nodes: PageNode[]; finalUrl: string; warnings: string[] }

export function parseInputUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw errors.invalidUrl();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw errors.invalidUrl();
  return url;
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * iframe에 넣기 전 손질: 문서 기준 주소를 원문으로 맞추고, closed shadow root를 열고,
 * 이 앱에서 eval을 막거나 다른 곳으로 보내는 meta(CSP, refresh)와 기존 <base>를 없앤다.
 */
export function prepareHtml(html: string, finalUrl: string): string {
  const cleaned = html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:content-security-policy|refresh|x-frame-options)["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const inject = `<base href="${escapeAttr(finalUrl)}"><script>(${forceOpenShadowRoots.toString()})()</script>`;
  if (/<head\b[^>]*>/i.test(cleaned)) return cleaned.replace(/<head\b[^>]*>/i, (tag) => `${tag}${inject}`);
  if (/<html\b[^>]*>/i.test(cleaned)) return cleaned.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${cleaned}</body></html>`;
}

/** 원본이 Playwright의 page.evaluate로 하던 일: 함수를 문자열로 만들어 iframe 안에서 실행한다. */
function evaluate<T>(win: Window, fn: (...args: any[]) => T | Promise<T>, arg: unknown): Promise<T> {
  const run = (win as unknown as { eval(code: string): T | Promise<T> }).eval(`(${fn.toString()})(${JSON.stringify(arg)})`);
  return Promise.resolve(run);
}

function waitForLoad(frame: HTMLIFrameElement, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const done = (loaded: boolean) => {
      clearTimeout(timer);
      frame.removeEventListener('load', onLoad);
      signal?.removeEventListener('abort', onAbort);
      resolve(loaded);
    };
    const onLoad = () => done(true);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    frame.addEventListener('load', onLoad);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function extractPage(rawUrl: string, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (message: string) => void } = {}): Promise<Extracted> {
  const url = parseInputUrl(rawUrl);
  onProgress?.('페이지를 받는 중');
  const remote = await fetchRemote(url.href, { signal, timeoutMs: config.page.fetchTimeoutMs, maxBytes: config.page.maxBytes });
  if (remote.status >= 400) throw errors.upstreamStatus(remote.status);
  if (remote.contentType && !HTML_TYPES.test(remote.contentType)) throw errors.unsupportedContent(remote.contentType.split(';')[0]);
  if (!remote.html.trim()) throw errors.emptyContent();

  const warnings: string[] = [];
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  const { width, height } = config.page.viewport;
  frame.style.cssText = `position:fixed;left:-${width * 3}px;top:0;width:${width}px;height:${height}px;border:0;pointer-events:none;`;
  frame.srcdoc = prepareHtml(remote.html, remote.finalUrl);
  try {
    onProgress?.('페이지를 그리는 중');
    const loaded = waitForLoad(frame, config.page.loadWaitMs, signal);
    document.body.append(frame);
    if (!(await loaded)) warnings.push('load-timeout');
    const win = frame.contentWindow;
    if (!win) throw errors.fetchFailed();
    signal?.throwIfAborted();
    await evaluate(win, autoScroll, { budgetMs: config.page.scrollBudgetMs, maxScreens: config.page.maxScrollScreens })
      .catch(() => warnings.push('scroll-failed'));
    await evaluate(win, waitForDomQuiet, { quietMs: config.page.settleQuietMs, maxMs: config.page.settleMaxMs })
      .catch(() => warnings.push('settle-failed'));
    signal?.throwIfAborted();
    onProgress?.('글과 이미지를 꺼내는 중');
    const main = await evaluate(win, collectFrameNodes, { maxVisited: config.extract.maxVisitedNodes, maxTextChars: config.extract.maxTextChars }) as
      { nodes: PageNode[]; truncated: boolean; visited: number };
    // 하위 iframe은 다른 출처라 읽지 않는다(원본은 프레임마다 따로 수집했다).
    if (frame.contentDocument?.querySelector('iframe[src]')) warnings.push('child-frames-skipped');
    const { nodes, dropped } = normalizeNodes([{ url: remote.finalUrl, ...main }], { maxContents: config.extract.maxContents });
    if (main.truncated) warnings.push('visited-node-limit');
    if (dropped) warnings.push(`contents-dropped:${dropped}`);
    if (!nodes.length) throw errors.emptyContent();
    return { nodes: nodes as PageNode[], finalUrl: remote.finalUrl, warnings };
  } finally {
    frame.srcdoc = '';
    frame.remove();
  }
}
