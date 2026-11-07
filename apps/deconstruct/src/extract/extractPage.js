/** URL 하나를 렌더링해 정리된 콘텐츠 노드를 돌려주는 Phase 1의 진입점. */
import { errors, AppError } from "../errors.js";
import { BLOCKED_HEADER, createEgressProxy } from "../security/egressProxy.js";
import { assertAllowedUrl, publicInternetPolicy } from "../security/urlPolicy.js";
import { autoScroll, collectFrameNodes, forceOpenShadowRoots, waitForDomQuiet } from "./inPage.js";
import { normalizeNodes } from "./normalize.js";

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)/i;
const OVER_BUDGET_GRACE_MS = 2_000;
const BLOCKED_RESOURCES = new Set(["media", "font"]); // 추출에 쓰지 않으면서 무거운 리소스

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function translateNavigationError(error, proxy) {
  const message = String(error?.message ?? "");
  if (message.includes("Download is starting")) return errors.unsupportedContent("download");
  if (error?.name === "TimeoutError" || message.includes("Timeout")) return errors.pageTimeout();
  if (proxy.stats.blocked.length > 0) return errors.blockedUrl(); // 리다이렉트 끝이 내부 주소였던 경우
  return errors.fetchFailed();
}

async function navigate(page, url, limits, proxy) {
  // 본문이 중간에 끊긴 문서는 domcontentloaded가 오지 않아 goto가 타임아웃까지 멈춘다.
  // 예산 초과 후 잠깐 기다려도 끝나지 않으면 메인 문서가 너무 큰 것으로 판단한다.
  const tooLarge = proxy.whenOverBudget.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, OVER_BUDGET_GRACE_MS));
    throw errors.pageTooLarge();
  });
  let response;
  try {
    response = await Promise.race([
      page.goto(url, { waitUntil: "domcontentloaded", timeout: limits.navigationTimeoutMs }),
      tooLarge,
    ]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw translateNavigationError(error, proxy);
  }
  if (!response) return;
  const headers = response.headers();
  if (headers[BLOCKED_HEADER]) throw errors.blockedUrl();
  if (response.status() >= 400) throw errors.upstreamStatus(response.status());
  const contentType = headers["content-type"] ?? "";
  if (contentType && !HTML_TYPES.test(contentType)) throw errors.unsupportedContent(contentType.split(";")[0]);
}

/** 준비 단계는 실패해도 그때까지 렌더링된 DOM을 추출할 수 있으므로 전체를 실패시키지 않는다. */
async function settle(page, limits, warnings) {
  await page.waitForLoadState("load", { timeout: limits.loadWaitMs }).catch(() => warnings.push("load-timeout"));
  await page
    .evaluate(autoScroll, { budgetMs: limits.scrollBudgetMs, maxScreens: limits.maxScrollScreens })
    .catch(() => warnings.push("scroll-failed"));
  await page
    .evaluate(waitForDomQuiet, { quietMs: limits.settleQuietMs, maxMs: limits.settleMaxMs })
    .catch(() => warnings.push("settle-failed"));
}

async function collectFrames(page, limits, extractLimits, warnings) {
  const options = { maxVisited: extractLimits.maxVisitedNodes, maxTextChars: extractLimits.maxTextChars };
  const collect = (frame) =>
    withTimeout(frame.evaluate(collectFrameNodes, options), limits.frameTimeoutMs, () => new Error("frame timeout"));

  let main;
  try {
    main = await collect(page.mainFrame());
  } catch {
    // 클라이언트 측 리다이렉트로 실행 컨텍스트가 사라진 경우 한 번 더 시도한다.
    await page.waitForLoadState("domcontentloaded", { timeout: limits.loadWaitMs }).catch(() => {});
    main = await collect(page.mainFrame());
  }

  const children = page.frames().filter((frame) => frame !== page.mainFrame() && !frame.isDetached());
  if (children.length > limits.maxFrames) warnings.push(`frames-limited:${children.length}`);
  const settled = await Promise.allSettled(
    children.slice(0, limits.maxFrames).map(async (frame) => ({ url: frame.url(), ...(await collect(frame)) })),
  );
  const childResults = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const failedFrames = settled.length - childResults.length;
  if (failedFrames) warnings.push(`frames-failed:${failedFrames}`);
  return [{ url: page.url(), ...main }, ...childResults];
}

async function extractWithBrowser(browser, url, { policy, limits, extractLimits }) {
  const proxy = await createEgressProxy({ policy, maxBytes: limits.maxBytes });
  const warnings = [];
  let context;
  try {
    context = await browser.newContext({
      // Chromium은 원래 루프백 주소에 프록시를 쓰지 않는다. 현재 Playwright가 이를 해제해 주지만
      // 이 값이 SSRF 방어의 전제이므로 버전에 기대지 않고 명시한다.
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      // 서비스 워커가 처리한 요청은 route에 잡히지 않는다.
      serviceWorkers: "block",
      acceptDownloads: false,
      locale: "ko-KR",
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(forceOpenShadowRoots);

    let requestCount = 0;
    await context.route("**/*", (route) => {
      requestCount += 1;
      const overLimit = requestCount > limits.maxRequests;
      if (overLimit || BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    context.on("page", (popup) => {
      if (popup !== page) popup.close().catch(() => {});
    });

    await navigate(page, url.href, limits, proxy);
    await settle(page, limits, warnings);
    const frames = await collectFrames(page, limits, extractLimits, warnings);
    const { nodes, dropped } = normalizeNodes(frames, { maxContents: extractLimits.maxContents });

    if (proxy.stats.overBudget) warnings.push("byte-budget-exceeded");
    if (requestCount > limits.maxRequests) warnings.push("request-limit-exceeded");
    if (frames.some((frame) => frame.truncated)) warnings.push("visited-node-limit");
    if (dropped) warnings.push(`contents-dropped:${dropped}`);
    if (nodes.length === 0) throw errors.emptyContent();

    return {
      nodes,
      finalUrl: page.url(),
      warnings,
      stats: {
        frames: frames.length,
        visited: frames.reduce((sum, frame) => sum + frame.visited, 0),
        requests: proxy.stats.requests,
        bytes: proxy.stats.bytes,
        blockedTargets: proxy.stats.blocked.length,
      },
    };
  } finally {
    await context?.close().catch(() => {});
    await proxy.close();
  }
}

export async function extractPage(url, { browserManager, policy = publicInternetPolicy, limits, extractLimits }) {
  await assertAllowedUrl(url, policy);
  const task = browserManager.run((browser) => extractWithBrowser(browser, url, { policy, limits, extractLimits }));
  return withTimeout(task, limits.totalTimeoutMs, () => errors.pageTimeout());
}
