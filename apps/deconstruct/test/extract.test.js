/**
 * 실제 Chromium으로 고정 페이지를 추출한다. 페이지 서버는 루프백에 있으므로 테스트 전용 정책으로
 * 그 포트만 허용한다. 카나리아 서버는 어떤 TCP 연결이든 들어오면 기록하므로, 연결 수 0이면
 * 어떤 경로로도 정책을 우회하지 못했다는 뜻이다.
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { BrowserManager } from "../src/extract/browserManager.js";
import { extractPage } from "../src/extract/extractPage.js";
import { BlockedTargetError } from "../src/security/urlPolicy.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
// 10x10 PNG는 만들지 않고 SVG로 대신한다. naturalWidth가 2보다 커야 픽셀로 걸러지지 않는다.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>';

let sitePort;
let canaryPort;
let canaryConnections = 0;
let siteServer;
let canaryServer;
let manager;
let policy;

const PAGES = {
  "/full": () => `<!doctype html><html><head><title>제목 태그</title>
    <style>
      .hero { background-image: url("/bg/hero.svg"); height: 50px; }
      .deco::before { content: ""; background-image: url("/bg/pseudo.svg"); }
      .gone { display: none; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      .flex { display: flex; }
    </style></head><body>
    <header><nav><a href="/1">홈</a> <a href="/2">소개</a> <a href="/3">문의</a>
      <ul class="sub-menu gone"><li><a href="/4">숨은 메뉴</a></li></ul></nav></header>
    <main>
      <div class="sr">화면 낭독기 전용</div>
      <i style="background: url(/bg/offset.svg) -24px -48px; width: 8px; height: 8px; display: block"></i>
      <i style="background: url(/bg/sp_main.svg) 0 0; width: 8px; height: 8px; display: block"></i>
      <div style="background: url(/bg/centered.svg) center / cover; height: 8px"></div>
      <div class="hero deco"></div>
      <h1>큰 <span>제목 <em>입니다</em></span></h1>
      <div><div><div><p>중첩된 <b>문단</b>에 <a href="/x">링크</a>가 섞여 있어도 한 덩어리입니다.</p></div></div></div>
      <button>눌러 보세요</button>
      <input type="submit" value="전송 버튼">
      <ul><li>항목 하나</li><li>항목 둘</li></ul>
      <div class="flex"><span>플렉스 A</span><span>플렉스 B</span></div>
      <p>첫째 줄<br>같은 문단</p>
      <p>위 단락<br><br>아래 단락</p>
      <table><tr><td>셀 1</td><td>셀 2</td></tr></table>
      <div class="gone">모달 안의 숨은 글</div>
      <p>중복 문장</p><p>중복 문장</p>
      <span>|</span>
      <figure><img src="/img/photo.svg" alt="사진 설명"><figcaption>사진 캡션</figcaption></figure>
      <img src="/img/pixel.png">
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/lazy.svg">
      <img src="/img/missing.png">
      <my-card><span slot="title">슬롯 제목</span></my-card>
      <closed-card></closed-card>
      <script>
        class Card extends HTMLElement { connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML = '<div><slot name="title"></slot><p>오픈 섀도우 본문</p></div>';
        } }
        customElements.define("my-card", Card);
        class Closed extends HTMLElement { connectedCallback() {
          this.attachShadow({ mode: "closed" }).innerHTML = "<p>클로즈드 섀도우 본문</p>";
        } }
        customElements.define("closed-card", Closed);
        document.addEventListener("DOMContentLoaded", () => {
          const p = document.createElement("p"); p.textContent = "스크립트가 만든 글"; document.body.append(p);
        });
      </script>
      <iframe src="http://localhost:${sitePort}/frame"></iframe>
      <div id="lazy"></div>
      <div style="height: 3000px"></div>
      <div id="bottom">페이지 바닥</div>
      <script>
        new IntersectionObserver((entries, obs) => {
          if (entries[0].isIntersecting) { document.getElementById("lazy").textContent = "스크롤해야 나오는 글"; obs.disconnect(); }
        }).observe(document.getElementById("bottom"));
      </script>
    </main>
    <footer>푸터 문구</footer>
    </body></html>`,
  "/frame": () => "<!doctype html><p>다른 출처 프레임의 글</p><img src='/img/inframe.svg'>",
  "/ssrf": () => `<!doctype html><p>정상 본문</p>
    <img src="http://127.0.0.1:${canaryPort}/img.png">
    <img src="http://[::1]:${canaryPort}/img6.png">
    <iframe src="http://127.0.0.1:${canaryPort}/frame"></iframe>
    <img src="/redirect-to-canary">
    <script>
      fetch("http://127.0.0.1:${canaryPort}/fetch", { mode: "no-cors" }).catch(() => {});
      fetch("http://localhost:${canaryPort}/fetch2", { mode: "no-cors" }).catch(() => {});
      try { new WebSocket("ws://127.0.0.1:${canaryPort}/ws"); } catch {}
      navigator.sendBeacon?.("http://127.0.0.1:${canaryPort}/beacon");
    </script>`,
  "/empty": () => "<!doctype html><html><body><canvas></canvas></body></html>",
  // load 이후 이미지를 붙여 메인 문서 탐색이 끝난 뒤에 예산을 넘기게 한다.
  "/heavy-image": () => `<!doctype html><p>가벼운 본문</p><script>
    addEventListener("load", () => { const i = new Image(); i.src = "/img/heavy.png"; document.body.append(i); });
  </script>`,
};

function siteHandler(req, res) {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/redirect-to-canary") {
    res.writeHead(302, { location: `http://127.0.0.1:${canaryPort}/redirected` }).end();
  } else if (path === "/not-found") {
    res.writeHead(404).end("nope");
  } else if (path === "/file.pdf") {
    res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4");
  } else if (path === "/data.json") {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  } else if (path === "/huge") {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<!doctype html><p>앞부분 글</p>");
    res.end("<!--" + "x".repeat(2_000_000) + "-->");
  } else if (path === "/img/heavy.png") {
    res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(2_000_000));
  } else if (path === "/img/pixel.png") {
    res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  } else if (path === "/img/missing.png") {
    res.writeHead(404).end();
  } else if (path.endsWith(".svg")) {
    res.writeHead(200, { "content-type": "image/svg+xml" }).end(SVG);
  } else if (PAGES[path]) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGES[path]());
  } else {
    res.writeHead(404).end();
  }
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

before(async () => {
  siteServer = http.createServer(siteHandler);
  sitePort = await listen(siteServer);
  canaryServer = net.createServer((socket) => {
    canaryConnections += 1;
    socket.destroy();
  });
  canaryPort = await listen(canaryServer);
  policy = {
    async resolve(hostname, port) {
      const host = hostname.replace(/^\[|\]$/g, "");
      if (port === sitePort && (host === "127.0.0.1" || host === "localhost")) return "127.0.0.1";
      throw new BlockedTargetError(`${host}:${port}`);
    },
  };
  manager = new BrowserManager(config.browser);
});

after(async () => {
  await manager.close();
  siteServer.closeAllConnections();
  await new Promise((resolve) => siteServer.close(resolve));
  await new Promise((resolve) => canaryServer.close(resolve));
});

const run = (path, overrides = {}) =>
  extractPage(new URL(`http://127.0.0.1:${sitePort}${path}`), {
    browserManager: manager,
    policy,
    limits: { ...config.page, scrollBudgetMs: 3000, ...overrides },
    extractLimits: config.extract,
  });

test("페이지 전체를 추출한다", async (t) => {
  const { nodes } = await run("/full");
  const texts = nodes.filter((n) => n.type === "text").map((n) => n.content);
  const images = nodes.filter((n) => n.type === "img").map((n) => new URL(n.content).pathname);
  const has = (value) => assert.ok(texts.includes(value), `누락: ${value}\n실제: ${JSON.stringify(texts)}`);
  const hasNot = (value) => assert.ok(!texts.some((text) => text.includes(value)), `있으면 안 됨: ${value}`);

  await t.test("메뉴 링크를 각각 분리한다", () => ["홈", "소개", "문의"].forEach(has));
  await t.test("중첩 DOM의 글자를 한 번만 추출한다", () => {
    has("큰 제목 입니다");
    assert.equal(texts.filter((text) => text.includes("제목 입니다")).length, 1);
    has("중첩된 문단에 링크가 섞여 있어도 한 덩어리입니다.");
  });
  await t.test("버튼과 입력 버튼", () => ["눌러 보세요", "전송 버튼"].forEach(has));
  await t.test("리스트, 표, 플렉스 항목을 분리한다", () => ["항목 하나", "항목 둘", "셀 1", "셀 2", "플렉스 A", "플렉스 B"].forEach(has));
  await t.test("단일 br은 잇고 연속 br은 나눈다", () => ["첫째 줄 같은 문단", "위 단락", "아래 단락"].forEach(has));
  await t.test("푸터와 동적 생성 글자", () => ["푸터 문구", "스크립트가 만든 글"].forEach(has));
  await t.test("스크롤로 나타나는 글자", () => has("스크롤해야 나오는 글"));
  await t.test("오픈, 클로즈드 섀도우와 슬롯", () => ["슬롯 제목", "오픈 섀도우 본문", "클로즈드 섀도우 본문"].forEach(has));
  await t.test("다른 출처 iframe", () => {
    has("다른 출처 프레임의 글");
    assert.ok(images.includes("/img/inframe.svg"));
  });
  await t.test("접힌 메뉴는 포함하고 그 밖의 숨김 글자는 제외한다", () => {
    has("숨은 메뉴");
    hasNot("모달 안의 숨은 글");
    hasNot("화면 낭독기 전용");
    hasNot("제목 태그");
  });
  await t.test("중복과 구분자를 제거한다", () => {
    assert.equal(texts.filter((text) => text === "중복 문장").length, 1);
    assert.ok(!texts.includes("|"));
  });
  await t.test("일반 이미지, 배경 이미지, 지연 이미지를 수집한다", () => {
    for (const path of ["/bg/hero.svg", "/bg/pseudo.svg", "/img/photo.svg", "/img/lazy.svg"]) {
      assert.ok(images.includes(path), `누락: ${path}\n실제: ${images}`);
    }
  });
  await t.test("픽셀, 깨진 이미지, data URL을 제외한다", () => {
    assert.ok(!images.includes("/img/pixel.png"));
    assert.ok(!images.includes("/img/missing.png"));
    assert.ok(!nodes.some((n) => n.content.startsWith("data:")));
  });
  await t.test("스프라이트는 제외하고 가운데 정렬 배경은 유지한다", () => {
    assert.ok(!images.includes("/bg/offset.svg"));
    assert.ok(!images.includes("/bg/sp_main.svg"));
    assert.ok(images.includes("/bg/centered.svg"));
  });
  await t.test("뒤 단계가 쓸 이미지 메타데이터를 보존한다", () => {
    const photo = nodes.find((n) => n.content.endsWith("/img/photo.svg"));
    assert.equal(photo.meta.alt, "사진 설명");
    assert.equal(photo.meta.caption, "사진 캡션");
  });
  await t.test("문서 순서를 유지한다", () => {
    assert.ok(texts.indexOf("홈") < texts.indexOf("큰 제목 입니다"));
    assert.ok(texts.indexOf("큰 제목 입니다") < texts.indexOf("푸터 문구"));
  });
});

test("페이지 스크립트가 어떤 경로로도 내부 주소에 닿지 못한다", async () => {
  canaryConnections = 0;
  const result = await run("/ssrf", { settleMaxMs: 1500 });
  assert.ok(result.nodes.some((n) => n.content === "정상 본문"));
  assert.ok(result.stats.blockedTargets >= 1, "프록시가 차단을 기록해야 한다");
  assert.equal(canaryConnections, 0, "내부 서버에 연결이 도달했다");
});

test("리다이렉트 끝이 내부 주소면 거부한다", async () => {
  canaryConnections = 0;
  await assert.rejects(run("/redirect-to-canary"), { code: "BLOCKED_URL" });
  assert.equal(canaryConnections, 0);
});

test("입력 URL이 정책 밖이면 브라우저를 열기 전에 거부한다", async () => {
  await assert.rejects(
    extractPage(new URL(`http://127.0.0.1:${canaryPort}/`), {
      browserManager: manager, policy, limits: config.page, extractLimits: config.extract,
    }),
    { code: "BLOCKED_URL" },
  );
  assert.equal(canaryConnections, 0);
});

test("오류 상황을 구분해서 알린다", async (t) => {
  await t.test("HTTP 404", () => assert.rejects(run("/not-found"), { code: "UPSTREAM_STATUS" }));
  await t.test("PDF", () => assert.rejects(run("/file.pdf"), { code: "UNSUPPORTED_CONTENT" }));
  await t.test("JSON", () => assert.rejects(run("/data.json"), { code: "UNSUPPORTED_CONTENT" }));
  await t.test("빈 페이지", () => assert.rejects(run("/empty"), { code: "EMPTY_CONTENT" }));
});

test("메인 문서가 바이트 예산을 넘으면 타임아웃까지 기다리지 않고 거부한다", async () => {
  const startedAt = Date.now();
  await assert.rejects(run("/huge", { maxBytes: 100_000 }), { code: "PAGE_TOO_LARGE" });
  assert.ok(Date.now() - startedAt < 10_000);
});

test("서브리소스가 바이트 예산을 넘으면 받은 만큼 추출하고 경고한다", async () => {
  const result = await run("/heavy-image", { maxBytes: 100_000 });
  assert.ok(result.nodes.some((n) => n.content === "가벼운 본문"));
  assert.ok(result.warnings.includes("byte-budget-exceeded"));
});

test("요청이 끝나면 브라우저 컨텍스트가 남지 않는다", async () => {
  await run("/frame");
  const browser = await manager.getBrowser();
  assert.equal(browser.contexts().length, 0);
});

test("확인 페이지는 메타데이터를 보여 주고 프로덕션에서는 등록되지 않는다", async (t) => {
  const target = `/debug/extract?url=${encodeURIComponent(`http://127.0.0.1:${sitePort}/frame`)}`;
  const dev = buildApp({ config: { ...config, logLevel: "silent", viewerEnabled: true }, browserManager: manager, policy });
  const prod = buildApp({ config: { ...config, logLevel: "silent", viewerEnabled: false }, browserManager: manager, policy });
  t.after(() => Promise.all([dev.close(), prod.close()]));

  const page = await dev.inject({ url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /text\/html/);

  const debug = (await dev.inject({ url: target })).json();
  assert.ok(debug.nodes[0].meta, "내부 메타데이터가 있어야 한다");
  assert.ok(!("meta" in debug.response.contents[0]), "API 응답 미리보기에는 없어야 한다");
  assert.deepEqual(debug.response.weights, []);

  const blocked = await dev.inject({ url: `/debug/extract?url=${encodeURIComponent(`http://127.0.0.1:${canaryPort}/`)}` });
  assert.equal(blocked.json().error.code, "BLOCKED_URL");

  assert.equal((await prod.inject({ url: "/" })).statusCode, 404);
  assert.equal((await prod.inject({ url: target })).statusCode, 404);
});

test("GET /deconstruct는 합의한 스키마만 반환한다", async (t) => {
  const app = buildApp({ config: { ...config, logLevel: "silent" }, browserManager: manager, policy });
  t.after(() => app.close());

  const ok = await app.inject({ url: `/deconstruct?url=${encodeURIComponent(`http://127.0.0.1:${sitePort}/frame`)}` });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.deepEqual(Object.keys(body).sort(), ["contents", "weights"]);
  assert.deepEqual(body.weights, []);
  for (const item of body.contents) {
    assert.deepEqual(Object.keys(item).sort(), ["content", "type"]);
    assert.ok(item.type === "text" || item.type === "img");
  }

  const missing = await app.inject({ url: "/deconstruct" });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.code, "INVALID_URL");

  const blocked = await app.inject({ url: `/deconstruct?url=${encodeURIComponent(`http://127.0.0.1:${canaryPort}/`)}` });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, "BLOCKED_URL");
});
