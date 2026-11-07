import horseUrl from './assets/horse.gif?url';
import type { CrawlSnapshot } from '@akl/graph-contract';
import type { DisposableScope } from '@akl/lab-kit';
import { visitedHistory, type PageRecord, type SiteFixture } from './data.ts';
import { createCardSpace } from './card-space.ts';
import { fetchDeconstruct, fetchPhrases, type DeconstructResponse } from './deconstruct-api.ts';
import { createDeconstructView, type DeconstructView } from './deconstruct-view.ts';
import { createHistoryRailController } from './history-rail.ts';

import { buildPreviewWsUrl, inspectPreviewTarget, type PreviewMetadata } from './preview-api.ts';
import { mountRemoteBrowser, type RemoteBrowserController } from './remote-browser-client.ts';

// Every request costs money and takes 8 to 21 seconds, and the server keeps no result cache.
const DECONSTRUCT_CACHE_SIZE = 8;
const DECONSTRUCT_DEADLINE_MS = 165_000;
export interface FrontendView {
  begin(fixture: SiteFixture): void;
  update(snapshot: CrawlSnapshot): void;
  setStatus?(message: string): void;
  setLoading?(loading: boolean): void;
  append?(fixture: SiteFixture, anchorId: string): void;
}

function isGoogleRedirectHost(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    return /^(?:www\.)?google\./i.test(parsed.hostname) && (parsed.pathname === '/goto' || parsed.pathname === '/url');
  } catch {
    return false;
  }
}

export function createFrontend(
  container: HTMLElement,
  scope: DisposableScope,
  onSearch: (query: string) => void,
  initialQuery = '',
  onContinue?: (nodeId: string) => void,
  onReturnToSearch?: () => void,
  apiEndpoint = '',
  deconstructEndpoint = '/deconstruct',
): FrontendView {
  container.innerHTML = `<main class="stack-app" data-phase="entry">
    <button type="button" class="return-to-search" aria-label="검색어 입력 화면으로 돌아가기"><span aria-hidden="true"></span></button>
    <div class="relevance-legend" aria-label="검색어 연관도 색상표">
      <div><span class="relevance-dot" data-level="4" aria-hidden="true"></span> : 검색어 연관 4순위</div>
      <div><span class="relevance-dot" data-level="3" aria-hidden="true"></span> : 검색어 연관 3순위</div>
      <div><span class="relevance-dot" data-level="2" aria-hidden="true"></span> : 검색어 연관 2순위</div>
      <div><span class="relevance-dot" data-level="1" aria-hidden="true"></span> : 검색어 연관 1순위</div>
    </div>
    <section class="stack-stage" aria-label="카드스택">
      <form class="stack-query"><label>검색어: <input aria-label="검색어" maxlength="100" required /></label> <button type="button" class="query-history-toggle" aria-label="검색어 기록 펼치기" aria-expanded="false">▾</button><ol class="query-history" aria-label="검색어 기록" hidden></ol><output class="search-status" role="status"></output></form>
      <section class="page-preview" hidden aria-label="선택한 웹사이트">
        <div class="preview-bar" role="toolbar" aria-label="웹페이지 탐색 도구">
          <button type="button" class="preview-nav-back" disabled aria-label="이전 페이지" title="이전 페이지">←</button>
          <button type="button" class="preview-nav-forward" disabled aria-label="다음 페이지" title="다음 페이지">→</button>
          <button type="button" class="preview-nav-reload" aria-label="새로고침" title="새로고침">↻</button>
          <span class="preview-address" aria-live="polite"></span>
        </div>
        <div class="preview-frame"></div>
      </section>
      <section class="stack-detail" hidden><p></p><button type="button" class="back">되돌아가기</button> <button type="button" class="decompose">분해</button> <button type="button" class="continue-search">검색 이어가기</button><span class="decompose-status" role="status" hidden></span></section>
    </section>
    <aside class="history" aria-label="탐색 히스토리"><div class="history-rail"><div class="history-scene"><ol class="history-list" aria-label="방문 페이지 최신순"><li class="history-title">history</li></ol></div></div></aside>
    <div class="search-loading" hidden role="status" aria-label="검색 중입니다">
      <img class="loading-horse" src="${horseUrl}" alt="" />
      <div class="loading-bar" role="progressbar" aria-label="검색 응답 대기"><span></span></div>
      <p aria-hidden="true"><span class="loading-label">검색중입니다</span><span class="loading-dots">..</span></p>
      <button type="button" class="loading-cancel" hidden>취소</button>
    </div>
  </main>`;

  const app = container.querySelector<HTMLElement>('.stack-app')!;
  const loadingOverlay = container.querySelector<HTMLElement>('.search-loading')!;
  const loadingDots = loadingOverlay.querySelector<HTMLElement>('.loading-dots')!;
  let loadingElapsed = 0;

  const stage = container.querySelector<HTMLElement>('.stack-stage')!;
  const form = container.querySelector<HTMLFormElement>('form')!;
  const input = form.querySelector('input')!;
  input.value = initialQuery;
  const detail = container.querySelector<HTMLElement>('.stack-detail')!;
  const preview = container.querySelector<HTMLElement>('.page-preview')!;
  const previewBar = preview.querySelector<HTMLElement>('.preview-bar')!;
  const navBackBtn = preview.querySelector<HTMLButtonElement>('.preview-nav-back')!;
  const navForwardBtn = preview.querySelector<HTMLButtonElement>('.preview-nav-forward')!;
  const navReloadBtn = preview.querySelector<HTMLButtonElement>('.preview-nav-reload')!;
  const previewAddress = preview.querySelector<HTMLElement>('.preview-address')!;
  const frameHost = preview.querySelector<HTMLElement>('.preview-frame')!;

  let previewAbort: AbortController | null = null;
  let activeRemoteBrowser: RemoteBrowserController | null = null;

  function showOverlay(loading: boolean, label = '검색중입니다', cancellable = false) {
    // The deconstruct page makes the overlay inert too, and its cancel button must work the next time.
    loadingOverlay.inert = false;
    loadingOverlay.hidden = !loading; loadingElapsed = 0; loadingDots.textContent = '..';
    loadingOverlay.querySelector('.loading-label')!.textContent = label;
    loadingOverlay.setAttribute('aria-label', `${label.replace('중입니다', ' 중입니다')}`);
    loadingOverlay.querySelector<HTMLButtonElement>('.loading-cancel')!.hidden = !cancellable;
    app.setAttribute('aria-busy', String(loading));
    for (const child of Array.from(app.children)) {
      if (child !== loadingOverlay) (child as HTMLElement).inert = loading;
    }
  }
  function setLoading(loading: boolean) {
    if (loading) closeFlow();
    showOverlay(loading);
    if (loading) { closePreview(); setQueryHistoryOpen(false); }
  }
  /** One card's trip through the deconstruct page and back. Only one runs at a time. */
  interface DecomposeFlow { controller: AbortController; view: DeconstructView | null; assembling: boolean }
  let flow: DecomposeFlow | null = null;
  /** The phrase behind the cards on screen: what the user typed, or the last continued search. */
  let activeQuery = '';
  const deconstructCache = new Map<string, DeconstructResponse>();
  function setDecomposeStatus(message: string) {
    const status = detail.querySelector<HTMLElement>('.decompose-status')!;
    status.textContent = message; status.hidden = !message;
  }
  function endFlow(message = '') {
    flow = null;
    showOverlay(false);
    setDecomposeStatus(message);
  }
  /** Immediate teardown for anything that replaces the current page, such as a new search. */
  function closeFlow() {
    if (!flow) return;
    flow.controller.abort(); flow.view?.dispose();
    endFlow();
  }
  scope.add(closeFlow);
  async function loadDeconstruct(href: string, query: string, signal: AbortSignal): Promise<DeconstructResponse> {
    const key = `${href}\0${query}`;
    const cached = deconstructCache.get(key);
    if (cached) return cached;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), DECONSTRUCT_DEADLINE_MS);
    try {
      const result = await fetchDeconstruct(deconstructEndpoint, href, query, AbortSignal.any([signal, deadline.signal]));
      if (deconstructCache.size >= DECONSTRUCT_CACHE_SIZE) deconstructCache.delete(deconstructCache.keys().next().value!);
      deconstructCache.set(key, result);
      return result;
    } catch (error) {
      throw deadline.signal.aborted ? new Error('분해 시간이 너무 오래 걸려 중단했습니다.') : error;
    } finally { clearTimeout(timer); }
  }
  async function startDecompose(page: SiteFixture['pages'][number]) {
    if (flow || !deconstructEndpoint) return;
    const current: DecomposeFlow = { controller: new AbortController(), view: null, assembling: false };
    flow = current;
    setDecomposeStatus('');
    showOverlay(true, '분해중입니다', true);
    const query = activeQuery;
    let result: DeconstructResponse;
    try {
      result = await loadDeconstruct(page.href, query, current.controller.signal);
    } catch (error) {
      if (flow !== current) return;
      endFlow(current.controller.signal.aborted ? '' : error instanceof Error ? error.message : '분해에 실패했습니다.');
      return;
    }
    if (flow !== current) return;
    current.view = createDeconstructView(app, {
      title: page.node.content?.title ?? page.node.domain, query, result,
      onAssemble: () => { void assemble(current); },
      onResearch: (term) => {
        closeFlow(); closePreview(); detail.hidden = true; selectedId = null;
        input.value = term; onSearch(term);
      },
      loadPhrases: (text, signal) => fetchPhrases(deconstructEndpoint, text, query, signal),
    });
    showOverlay(false);
    const viewElement = app.querySelector('.deconstruct-view');
    for (const child of Array.from(app.children)) (child as HTMLElement).inert = child !== viewElement;
    current.view.enter();
  }
  async function assemble(current: DecomposeFlow) {
    if (flow !== current || current.assembling || !current.view) return;
    current.assembling = true;
    await current.view.assemble();
    if (flow !== current) return;
    current.view.dispose();
    endFlow();
  }

  function closePreview() {
    previewAbort?.abort();
    previewAbort = null;
    activeRemoteBrowser?.dispose();
    activeRemoteBrowser = null;
    const frame = frameHost.querySelector('iframe');
    if (frame) {
      frame.src = 'about:blank';
      frame.remove();
    }
    frameHost.replaceChildren();
    navBackBtn.disabled = true;
    navForwardBtn.disabled = true;
    navReloadBtn.disabled = true;
    previewBar.dataset.loading = 'false';
    previewAddress.textContent = '';
    preview.hidden = true;
  }

  function renderInAppSummary(page: PageRecord, targetUrl: string, meta?: PreviewMetadata) {
    const card = document.createElement('article');
    card.className = 'preview-fallback';
    const header = document.createElement('header');
    header.className = 'preview-fallback-header';
    let hostLabel = page.node.domain;
    try {
      hostLabel = new URL(targetUrl).hostname || hostLabel;
    } catch {
      /* keep node domain */
    }
    const domainEl = document.createElement('span');
    domainEl.className = 'preview-fallback-domain';
    domainEl.textContent = meta?.siteName ? `${meta.siteName} · ${hostLabel}` : hostLabel;
    const noticeEl = document.createElement('span');
    noticeEl.className = 'preview-fallback-notice';
    noticeEl.textContent = '앱 내 문서 요약 보기';
    header.append(domainEl, noticeEl);

    const body = document.createElement('div');
    body.className = 'preview-fallback-body';
    const imageUrl = meta?.image || page.node.content?.imageUrl || '';
    if (imageUrl) {
      const media = document.createElement('div');
      media.className = 'preview-fallback-media';
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => media.remove(), { once: true });
      media.append(img);
      body.append(media);
    }
    const copyWrap = document.createElement('div');
    copyWrap.className = 'preview-fallback-copy';
    const heading = document.createElement('h2');
    heading.textContent = meta?.title || page.node.content?.title || hostLabel;
    const descText = meta?.description || page.node.content?.snippet || '';
    const desc = document.createElement('p');
    desc.textContent = descText || '제공된 본문 요약이 없습니다.';
    const urlLine = document.createElement('p');
    urlLine.className = 'preview-fallback-url';
    urlLine.textContent = targetUrl;
    copyWrap.append(heading, desc, urlLine);
    body.append(copyWrap);
    card.append(header, body);
    frameHost.replaceChildren(card);
  }

  function mountIframe(src: string, titleText: string, sandbox: string) {
    const frame = document.createElement('iframe');
    frame.title = titleText;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', sandbox);
    frame.src = src;
    navReloadBtn.disabled = false;
    frameHost.replaceChildren(frame);
  }

  function syncCardFaceUrl(cardId: string, page: PageRecord, resolvedUrl: string) {
    if (!resolvedUrl || isGoogleRedirectHost(resolvedUrl)) return;
    page.href = resolvedUrl;
    const cardUrl = stage.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(cardId)}"] .stack-card-url`);
    if (cardUrl) {
      cardUrl.textContent = resolvedUrl;
      cardUrl.title = resolvedUrl;
    }
  }

  function mountHttpFallbackPreview(cardId: string, page: PageRecord, titleText: string, controller: AbortController) {
    void inspectPreviewTarget(apiEndpoint, page.href, controller.signal)
      .then((inspection) => {
        if (controller.signal.aborted || previewAbort !== controller) return;
        const resolvedHref = inspection.finalUrl || page.href;
        syncCardFaceUrl(cardId, page, resolvedHref);
        previewAddress.textContent = resolvedHref;
        previewAddress.title = resolvedHref;
        previewBar.dataset.loading = 'false';
        if (inspection.mode === 'iframe' && inspection.embedUrl) {
          mountIframe(inspection.embedUrl, titleText, 'allow-scripts allow-same-origin allow-forms');
        } else if (inspection.mode === 'proxy' && inspection.embedUrl) {
          mountIframe(inspection.embedUrl, titleText, 'allow-same-origin');
        } else {
          renderInAppSummary(page, resolvedHref, inspection.meta);
        }
      })
      .catch(() => {
        if (controller.signal.aborted || previewAbort !== controller) return;
        previewBar.dataset.loading = 'false';
        renderInAppSummary(page, page.href);
      });
  }

  scope.add(closePreview);

  scope.trackListener(navBackBtn, 'click', () => {
    activeRemoteBrowser?.goBack();
  });
  scope.trackListener(navForwardBtn, 'click', () => {
    activeRemoteBrowser?.goForward();
  });
  scope.trackListener(navReloadBtn, 'click', () => {
    if (activeRemoteBrowser) {
      activeRemoteBrowser.reload();
      return;
    }
    const frame = frameHost.querySelector('iframe');
    if (frame?.src) {
      const currentSrc = frame.src;
      frame.src = currentSrc;
    }
  });

  const list = container.querySelector<HTMLOListElement>('.history-list')!;
  const historyTitle = list.querySelector<HTMLElement>('.history-title')!;
  const queryHistory = form.querySelector<HTMLOListElement>('.query-history')!;
  const queryToggle = form.querySelector<HTMLButtonElement>('.query-history-toggle')!;

  function setQueryHistoryOpen(open: boolean) {
    queryHistory.hidden = !open;
    queryToggle.setAttribute('aria-expanded', String(open));
    queryToggle.setAttribute('aria-label', open ? '검색어 기록 접기' : '검색어 기록 펼치기');
    queryToggle.textContent = open ? '▴' : '▾';
  }

  const queryStops: { query: string; pageIds: string[] }[] = [];
  function addQuery(query: string, pageIds: string[]) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = query;
    button.dataset.stopIndex = String(queryStops.length);
    queryStops.push({ query, pageIds });
    item.append(button);
    queryHistory.append(item);
  }

  scope.trackListener(queryHistory, 'click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-stop-index]');
    if (!button) return;
    const stop = queryStops[Number(button.dataset.stopIndex)];
    if (!stop) return;
    closePreview();
    detail.hidden = true;
    selectedId = null;
    input.value = stop.query;
    activeQuery = stop.query;
    space.visitStack(stop.pageIds);
    setQueryHistoryOpen(false);
  });
  scope.trackListener(queryToggle, 'click', () => setQueryHistoryOpen(queryHistory.hidden));

  let fixture: SiteFixture | null = null;
  let selectedId: string | null = null;
  const seen = new Set<string>();

  function openPagePreview(id: string) {
    const page = fixture?.pages.find((item) => item.node.id === id);
    if (!page || flow) return;
    setDecomposeStatus('');
    selectedId = id;
    space.focus(id);
    const titleText = page.node.content?.title ?? page.node.domain;
    detail.querySelector('p')!.textContent = titleText;
    closePreview();
    previewAddress.textContent = isGoogleRedirectHost(page.href) ? '원문 주소 연결 중…' : page.href;
    previewAddress.title = isGoogleRedirectHost(page.href) ? '' : page.href;
    preview.hidden = false;
    detail.hidden = false;

    if (!apiEndpoint.trim()) {
      previewBar.dataset.loading = 'false';
      if (isGoogleRedirectHost(page.href)) {
        renderInAppSummary(page, page.href);
      } else {
        mountIframe(page.href, titleText, 'allow-scripts allow-same-origin allow-forms');
      }
      return;
    }

    const controller = new AbortController();
    previewAbort = controller;
    previewBar.dataset.loading = 'true';
    navReloadBtn.disabled = false;

    let initialUrlSynced = false;
    activeRemoteBrowser = mountRemoteBrowser(
      frameHost,
      (width, height, dpr) => buildPreviewWsUrl(apiEndpoint, page.href, width, height, dpr),
      {
        onState(state) {
          if (controller.signal.aborted || previewAbort !== controller) return;
          navBackBtn.disabled = !state.canGoBack;
          navForwardBtn.disabled = !state.canGoForward;
          previewBar.dataset.loading = String(state.loading);
          if (state.url) {
            if (isGoogleRedirectHost(state.url)) {
              previewAddress.textContent = '원문 주소 연결 중…';
              previewAddress.title = '';
            } else {
              previewAddress.textContent = state.url;
              previewAddress.title = state.url;
              if (!initialUrlSynced) {
                initialUrlSynced = true;
                syncCardFaceUrl(id, page, state.url);
              }
            }
          }
          if (state.title && state.canGoBack) {
            detail.querySelector('p')!.textContent = state.title;
          } else if (!state.canGoBack) {
            detail.querySelector('p')!.textContent = titleText;
          }
        },
        onUnavailable() {
          if (controller.signal.aborted || previewAbort !== controller) return;
          activeRemoteBrowser?.dispose();
          activeRemoteBrowser = null;
          mountHttpFallbackPreview(id, page, titleText, controller);
        },
      },
    );
  }

  const space = createCardSpace(stage, scope, openPagePreview);
  const historyRail = createHistoryRailController(
    app,
    list,
    scope,
    openPagePreview,
    () => !preview.hidden,
  );

  // Capture before card handlers so an outside click closes rather than reopening a card.
  scope.trackListener(app, 'click', (event) => {
    const target = event.target as Element;
    // The deconstruct page and its loading screen sit over the live preview, which must survive their clicks.
    if (flow || preview.hidden || preview.contains(target) || detail.contains(target)) return;
    closePreview(); detail.hidden = true; selectedId = null; space.back();
    if (target.closest('[data-page-id]')) {
      event.preventDefault(); event.stopPropagation();
    }
  }, { capture: true });
  scope.trackListener(container.querySelector('.return-to-search')!, 'click', () => {
    closeFlow();
    onReturnToSearch?.();
    setLoading(false);
    closePreview();
    space.reset();
    activeQuery = '';
    fixture = null;
    selectedId = null;
    seen.clear();
    list.replaceChildren(historyTitle);
    historyRail.reset();
    detail.hidden = true;
    app.dataset.phase = 'entry';
    input.value = '';
    queryHistory.replaceChildren();
    queryStops.length = 0;
    setQueryHistoryOpen(false);
    container.querySelector('output')!.textContent = '';
    input.focus();
  });

  scope.trackListener(form, 'submit', (event) => {
    event.preventDefault();
    if (input.value.trim()) {
      input.blur();
      onSearch(input.value.trim());
    }
  });
  scope.trackListener(detail, 'click', (event) => {
    // Decomposing keeps the page alive, so assembling brings it straight back without reloading.
    if ((event.target as Element).closest('button:not(.decompose)')) closePreview();
  });
  scope.trackListener(detail.querySelector('.continue-search')!, 'click', () => {
    if (selectedId && onContinue) {
      detail.hidden = true;
      space.back();
      onContinue(selectedId);
    }
  });
  scope.trackListener(detail.querySelector('.back')!, 'click', () => {
    detail.hidden = true;
    space.back();
  });
  const decompose = detail.querySelector<HTMLButtonElement>('.decompose')!;
  if (!deconstructEndpoint) { decompose.disabled = true; decompose.textContent = '분해 (사용 불가)'; }
  scope.trackListener(decompose, 'click', () => {
    const page = fixture?.pages.find((item) => item.node.id === selectedId);
    if (page) void startDecompose(page);
  });
  scope.trackListener(loadingOverlay.querySelector('.loading-cancel')!, 'click', () => { flow?.controller.abort(); });
  scope.trackRaf((_time, _wrapped, dt) => {
    if (!loadingOverlay.hidden) {
      loadingElapsed += dt;
      loadingDots.textContent = '.'.repeat([2, 3, 4, 3, 2][Math.floor(loadingElapsed / 0.35) % 5]!);
    }
  });

  return {
    setLoading,
    setStatus(message) {
      container.querySelector('output')!.textContent = message;
    },
    append(next, anchorId) {
      closeFlow();
      closePreview();
      const previousIds = new Set(fixture?.pages.map((page) => page.node.id));
      addQuery(
        next.query,
        next.pages.filter((page) => !previousIds.has(page.node.id)).map((page) => page.node.id),
      );
      fixture = next;
      activeQuery = next.query;
      input.value = next.query;
      detail.hidden = true;
      space.append(next, anchorId);
    },
    begin(next) {
      closeFlow();
      closePreview();
      fixture = next;
      activeQuery = next.query;
      seen.clear();
      list.replaceChildren(historyTitle);
      detail.hidden = true;
      queryHistory.replaceChildren();
      queryStops.length = 0;
      addQuery(next.query, next.pages.map((page) => page.node.id));
      setQueryHistoryOpen(false);
      input.value = next.query;
      app.dataset.phase = 'map';
      historyRail.reset();
      space.begin(next);
    },
    update(snapshot) {
      if (!fixture) return;
      space.update(snapshot);
      const previousFirstCard = list.querySelector<HTMLElement>('.history-page');
      const previousFirstTop = previousFirstCard?.offsetTop ?? 0;
      let added = false;
      for (const entry of visitedHistory(snapshot).reverse()) {
        if (seen.has(entry.id)) continue;
        const node = snapshot.nodeMap.get(entry.nodeId!);
        if (!node) continue;
        seen.add(entry.id);
        const item = document.createElement('li');
        item.className = 'history-page';
        item.dataset.nodeId = entry.nodeId!;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'history-page-link';
        trigger.textContent = node.content?.title ?? node.domain;
        const text = document.createElement('p');
        text.textContent = node.content?.snippet ?? '';
        item.append(trigger, text);
        historyTitle.after(item);
        added = true;
      }
      if (added) {
        historyRail.syncAfterPrepend(previousFirstCard, previousFirstTop);
      }
    },
  };
}
