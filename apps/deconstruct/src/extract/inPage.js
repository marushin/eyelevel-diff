/**
 * 브라우저 안에서 실행되는 코드. Playwright가 함수를 문자열로 직렬화하므로
 * 이 파일의 함수들은 바깥 스코프나 import를 참조할 수 없다.
 */

/** 문서 스크립트보다 먼저 실행되어 closed shadow root를 순회할 수 있게 한다. */
export function forceOpenShadowRoots() {
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) {
    return original.call(this, { ...init, mode: "open" });
  };
}

/** 지연 로딩을 깨우기 위해 끝까지 내렸다가 맨 위로 돌아온다. */
export async function autoScroll({ budgetMs, maxScreens }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + budgetMs;
  const step = Math.max(window.innerHeight * 0.8, 200);
  for (let screen = 0; screen < maxScreens && Date.now() < deadline; screen += 1) {
    window.scrollBy(0, step);
    await sleep(120);
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollTop + window.innerHeight >= root.scrollHeight - 2) {
      await sleep(250); // 끝에 닿은 뒤 내용이 더 붙는지 한 번 더 본다.
      if (root.scrollTop + window.innerHeight >= root.scrollHeight - 2) break;
    }
  }
  window.scrollTo(0, 0);
}

/** DOM 변경이 quietMs 동안 멈추거나 maxMs가 지나면 끝난다. networkidle은 공식 문서에서 권장하지 않는다. */
export function waitForDomQuiet({ quietMs, maxMs }) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(limit);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    });
    const limit = setTimeout(finish, maxMs);
    observer.observe(document, { subtree: true, childList: true, characterData: true });
    timer = setTimeout(finish, quietMs);
  });
}

/**
 * 프레임 하나의 텍스트와 이미지를 문서 순서대로 모은다.
 *
 * 평탄화된 DOM을 한 번만 순회해 각 텍스트 노드를 정확히 한 번씩 방문하므로, 중첩 요소에서
 * textContent를 읽을 때 생기는 중복이 구조적으로 발생하지 않는다.
 */
export function collectFrameNodes({ maxVisited, maxTextChars }) {
  const SKIP = new Set([
    "head", "script", "style", "noscript", "template", "textarea", "select", "datalist", "object", "embed",
    "canvas", "audio", "iframe", "frame", "frameset", "map", "defs", "desc", "metadata", "title",
  ]);
  const INLINE = new Set(["inline", "contents", "ruby", "ruby-text", "ruby-base", "ruby-base-container", "ruby-text-container"]);
  // 닫혀 있어도 사용자가 펼칠 수 있는 영역. 그 밖의 display:none(모달, 오류 문구 등)은 제외한다.
  const REVEALABLE =
    'nav, header, footer, details, menu, [role="navigation"], [role="menu"], [role="menubar"], [role="tabpanel"],' +
    '[class*="menu" i], [class*="dropdown" i], [class*="gnb" i], [class*="lnb" i], [class*="accordion" i]';
  const LANDMARKS = {
    nav: "nav", header: "header", footer: "footer", main: "main", aside: "aside", article: "article",
    navigation: "nav", banner: "header", contentinfo: "footer", complementary: "aside",
  };
  const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url"];
  const LINE_BREAK = " ";

  const nodes = [];
  let visited = 0;
  let truncated = false;
  let buffer = [];

  const absoluteUrl = (value) => {
    if (!value) return null;
    try {
      const url = new URL(value.trim(), document.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const href = url.href;
      return href.length <= 2048 ? href : null;
    } catch {
      return null;
    }
  };

  const pushImage = (src, meta) => {
    const url = absoluteUrl(src);
    if (url) nodes.push({ type: "img", content: url, meta });
  };

  const pushText = (raw, ctx, bare) => {
    const cleaned = raw.replace(/[​-‍⁠﻿]/g, "");
    for (const segment of cleaned.split(new RegExp(`${LINE_BREAK}(?:\\s*${LINE_BREAK})+`))) {
      const content = segment.replace(/\s+/g, " ").trim();
      if (!content) continue;
      const kind = ctx.heading ? "heading" : ctx.button ? "button" : !bare && ctx.link ? "link" : ctx.listItem ? "listItem" : "text";
      nodes.push({
        type: "text",
        content: content.slice(0, maxTextChars),
        meta: { kind, tag: ctx.block, region: ctx.region },
      });
    }
  };

  /**
   * 인라인 흐름을 내보낸다. 일반 글자 없이 링크만 여러 개 나란한 경우(메뉴)는 링크별로 나누고,
   * 글자와 섞인 링크(문단 속 링크)는 문장이 끊기지 않도록 합친다.
   */
  const flush = () => {
    const parts = buffer;
    buffer = [];
    const solid = parts.filter((part) => part.text.trim() && part.text !== LINE_BREAK);
    if (solid.length === 0) return;
    const bare = solid.some((part) => !part.ctx.link);
    const links = new Set(solid.map((part) => part.ctx.link));
    if (!bare && links.size > 1) {
      for (const link of links) {
        const own = parts.filter((part) => part.ctx.link === link);
        pushText(own.map((part) => part.text).join(""), own[0].ctx, false);
      }
      return;
    }
    pushText(parts.map((part) => part.text).join(""), solid[0].ctx, bare);
  };

  const collectImages = (el, name, style) => {
    const describe = (origin, width = 0, height = 0) => ({
      origin,
      alt: el.getAttribute("alt") ?? "",
      title: el.getAttribute("title") ?? "",
      ariaLabel: el.getAttribute("aria-label") ?? "",
      caption: el.closest("figure")?.querySelector("figcaption")?.textContent?.trim().slice(0, 300) ?? "",
      width,
      height,
    });

    if (name === "img") {
      const current = el.currentSrc || el.getAttribute("src");
      const lazy = LAZY_ATTRS.map((attr) => el.getAttribute(attr)).find(Boolean);
      const usable = current && !current.startsWith("data:");
      const broken = el.complete && el.naturalWidth === 0;
      const pixel = el.complete && el.naturalWidth > 0 && el.naturalWidth <= 2 && el.naturalHeight <= 2;
      if (usable && !broken && !pixel) pushImage(current, describe("img", el.naturalWidth, el.naturalHeight));
      else if (lazy) pushImage(lazy, describe("img-lazy"));
    } else if (name === "video") {
      pushImage(el.getAttribute("poster"), describe("video-poster"));
    } else if (name === "image") {
      pushImage(el.href?.baseVal ?? el.getAttribute("href"), describe("svg-image"));
    } else if (name === "input" && el.type === "image") {
      pushImage(el.getAttribute("src"), describe("input-image"));
    }

    const backgrounds = [[style, "css-background"]];
    for (const pseudo of ["::before", "::after"]) {
      const pseudoStyle = getComputedStyle(el, pseudo);
      if (pseudoStyle.content !== "none") backgrounds.push([pseudoStyle, "css-pseudo-background"]);
    }
    for (const [source, origin] of backgrounds) {
      const value = source.backgroundImage;
      if (!value || value === "none") continue;
      // 음수 오프셋은 스프라이트의 특징이다. 시트 전체는 페이지 콘텐츠로서 의미가 없다.
      if (/-\d/.test(source.backgroundPosition)) continue;
      for (const match of value.matchAll(/url\((["']?)(.*?)\1\)/g)) {
        const fileName = match[2].split(/[?#]/)[0].split("/").pop();
        if (!/sprite|^sp_/i.test(fileName)) pushImage(match[2], describe(origin));
      }
    }
  };

  const childrenOf = (el, name) => {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (name === "slot") {
      const assigned = el.assignedNodes({ flatten: true });
      return assigned.length ? assigned : el.childNodes;
    }
    return el.childNodes;
  };

  const isScreenReaderOnly = (el, style) => {
    if (style.position !== "absolute" && style.position !== "fixed") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.width <= 1 && rect.height <= 1;
  };

  const walk = (node, parent) => {
    if (truncated) return;
    if ((visited += 1) > maxVisited) {
      truncated = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (parent.visible) buffer.push({ text: node.nodeValue.replace(LINE_BREAK, " ").replace(/\n/g, " "), ctx: parent });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node;
    const name = el.localName;
    if (SKIP.has(name)) return;
    if (name === "br") {
      if (parent.visible) buffer.push({ text: LINE_BREAK, ctx: parent });
      return;
    }

    const style = getComputedStyle(el);
    const isRoot = name === "html" || name === "body";
    const revealable = parent.revealable || (!isRoot && el.matches(REVEALABLE));
    if (style.display === "none" && !revealable) return;
    if (isScreenReaderOnly(el, style)) return;

    const visible = revealable || style.visibility === "visible";
    if (visible) collectImages(el, name, style);

    const role = el.getAttribute("role");
    const isButton = name === "button" || name === "summary" || role === "button";
    const inline = INLINE.has(style.display) && !isButton;

    if (name === "input") {
      if (["button", "submit", "reset"].includes(el.type) && el.value && visible) {
        flush();
        pushText(el.value, { ...parent, button: true, block: "input" }, false);
      }
      return;
    }

    if (!inline) flush();
    const ctx = {
      visible,
      revealable,
      link: parent.link || ((name === "a" && el.hasAttribute("href")) || role === "link" ? el : null),
      button: parent.button || isButton,
      heading: parent.heading || /^h[1-6]$/.test(name) || role === "heading",
      listItem: parent.listItem || name === "li",
      block: inline ? parent.block : name,
      region: LANDMARKS[name] ?? LANDMARKS[role] ?? parent.region,
    };
    for (const child of childrenOf(el, name)) walk(child, ctx);
    if (!inline) flush();
  };

  const rootContext = {
    visible: true, revealable: false, link: null, button: false, heading: false, listItem: false,
    block: "html", region: null,
  };
  walk(document.documentElement, rootContext);
  flush();
  return { nodes, truncated, visited };
}
