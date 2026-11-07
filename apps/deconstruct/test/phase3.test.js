import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { config } from "../src/config.js";
import { createClaudeImageDescriber } from "../src/describe/claudeImageDescriber.js";
import { createImageDescriber, isMeaningfulText } from "../src/describe/describeImages.js";
import { BLANK_IMAGE, fetchImage, toVisionImage } from "../src/describe/fetchImage.js";
import { embedNodes, embeddingInput } from "../src/embed/embedNodes.js";
import { createLocalEmbedder } from "../src/embed/localEmbedder.js";
import { BlockedTargetError } from "../src/security/urlPolicy.js";
import { createSegmenter } from "../src/segment/segmentNodes.js";
import { BudgetExhaustedError, CostLedger } from "../src/usage/costLedger.js";
import { JsonStore } from "../src/usage/jsonStore.js";

const tempFile = (name) => join(mkdtempSync(join(tmpdir(), "deconstruct-")), name);
const ledgerWith = (limitUsd) => new CostLedger({ store: new JsonStore(tempFile("usage.json")), limitUsd });

let server;
let port;
let canary;
let canaryPort;
let canaryHits = 0;
let photo;
let lastReferer;
let policy;
const visionLimits = {
  maxPerPage: 2, batchSize: 8, maxEdge: 512, minEdge: 64, maxImageBytes: 1_000_000, fetchTimeoutMs: 2000, unknownArea: 90_000,
};

before(async () => {
  // 빈 이미지로 걸러지지 않도록 노이즈를 넣는다.
  photo = await sharp({
    create: { width: 1024, height: 512, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 30 } },
  }).jpeg({ quality: 40 }).toBuffer();
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    lastReferer = req.headers.referer;
    if (path === "/huge.jpg") res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.alloc(2_000_000));
    else if (path === "/to-canary.jpg") res.writeHead(302, { location: `http://127.0.0.1:${canaryPort}/x.jpg` }).end();
    else if (path === "/page.html") res.writeHead(200, { "content-type": "text/html" }).end("<p>x</p>");
    else res.writeHead(200, { "content-type": "image/jpeg" }).end(photo);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  canary = net.createServer((socket) => {
    canaryHits += 1;
    socket.destroy();
  });
  await new Promise((resolve) => canary.listen(0, "127.0.0.1", resolve));
  canaryPort = canary.address().port;
  policy = {
    async resolve(host, target) {
      if (target === port) return "127.0.0.1";
      throw new BlockedTargetError(`${host}:${target}`);
    },
  };
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => canary.close(resolve));
});

const fetchOptions = () => ({ policy, referer: "https://page.example/", timeoutMs: 2000, maxBytes: 1_000_000 });
const imgNode = (name, meta = {}) => ({ type: "img", content: `http://127.0.0.1:${port}/${name}`, meta: { alt: "", caption: "", ariaLabel: "", title: "", ...meta } });

test("비용을 누적해 파일에 남기고, 재시작 후에도 이어 간다", () => {
  const path = tempFile("usage.json");
  const ledger = new CostLedger({ store: new JsonStore(path), limitUsd: 100 });
  assert.equal(ledger.record("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 }), 6);
  const reopened = new CostLedger({ store: new JsonStore(path), limitUsd: 100 });
  assert.equal(reopened.spentUsd, 6);
  assert.equal(reopened.store.data.byModel["claude-opus-5-5"].inputTokens, 1_000_000);
});

test("서버와 터미널 도구가 함께 써도 비용이 합산되고 한도가 지켜진다", async () => {
  const path = tempFile("usage.json");
  const server = new CostLedger({ store: new JsonStore(path), limitUsd: 10 });
  const script = new CostLedger({ store: new JsonStore(path), limitUsd: 10 });
  server.record("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0 });
  script.record("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0 });
  server.record("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(new JsonStore(path).data.spentUsd, 12);
  const guarded = script.guard({ find: async () => assert.fail("호출되면 안 됨") }, "claude-opus-5-5");
  await assert.rejects(guarded.find([]), BudgetExhaustedError);
});

test("가격을 모르는 모델은 가장 비싼 값으로 계산한다", () => {
  assert.equal(ledgerWith(100).record("claude-future-9", { inputTokens: 1_000_000, outputTokens: 0 }), 10);
});

test("한도에 닿으면 실제 호출 없이 막고, 호출 비용은 한도에 반영한다", async () => {
  const ledger = ledgerWith(1);
  let calls = 0;
  const guarded = ledger.guard(
    { cacheKey: "k", find: async () => ((calls += 1), { usage: { inputTokens: 250_000, outputTokens: 0 }, value: 1 }) },
    "claude-opus-5-5",
  );
  assert.equal((await guarded.find([])).value, 1);
  assert.equal(ledger.exhausted, true);
  await assert.rejects(guarded.find([]), BudgetExhaustedError);
  assert.equal(calls, 1);
});

test("한도를 넘으면 의미 분할은 규칙으로 이어지고 경고한다", async () => {
  const ledger = ledgerWith(0);
  const finder = ledger.guard({ cacheKey: "k", find: async () => assert.fail("호출되면 안 됨") }, "claude-opus-5-5");
  const limits = { minChars: 10, minPieceChars: 2, maxSentenceChars: 100, maxBatchChars: 100, maxLlmCharsPerPage: 100, llmConcurrency: 1, maxContents: 10 };
  const { nodes, warnings } = await createSegmenter({ finder, limits })([
    { type: "text", content: "첫 문장은 여기서 끝납니다. 둘째 문장도 여기서 끝납니다.", meta: { kind: "text" } },
  ]);
  assert.equal(nodes[0].meta.segment.method, "rule");
  assert.ok(warnings.includes("llm-budget-exhausted"), warnings.join());
});

test("이미지를 받을 때 페이지 주소를 밝히고 크기 제한을 지킨다", async () => {
  await fetchImage(`http://127.0.0.1:${port}/a.jpg`, fetchOptions());
  assert.equal(lastReferer, "https://page.example/");
  await assert.rejects(fetchImage(`http://127.0.0.1:${port}/huge.jpg`, fetchOptions()), /too large/);
});

test("이미지 URL이 내부 주소로 리다이렉트되어도 연결하지 않는다", async () => {
  canaryHits = 0;
  await assert.rejects(fetchImage(`http://127.0.0.1:${port}/to-canary.jpg`, fetchOptions()), BlockedTargetError);
  await assert.rejects(fetchImage(`http://127.0.0.1:${canaryPort}/x.jpg`, fetchOptions()), BlockedTargetError);
  assert.equal(canaryHits, 0);
});

test("큰 이미지는 줄이고, 아이콘과 SVG는 제외한다", async () => {
  const small = await toVisionImage(photo, { maxEdge: 512, minEdge: 64 });
  const { width, height } = await sharp(Buffer.from(small, "base64")).metadata();
  assert.deepEqual([width, height], [512, 256]);
  const icon = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#000" } }).png().toBuffer();
  assert.equal(await toVisionImage(icon, { maxEdge: 512, minEdge: 64 }), null);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"/>');
  assert.equal(await toVisionImage(svg, { maxEdge: 512, minEdge: 64 }), null);
});

test("내용 없는 한 가지 색 이미지는 Vision 없이 노드에서 뺀다", async () => {
  const describer = fakeDescriber();
  const blank = await sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  assert.equal(await toVisionImage(blank, { maxEdge: 512, minEdge: 64 }), BLANK_IMAGE);

  const blankServer = http.createServer((req, res) => res.writeHead(200, { "content-type": "image/png" }).end(blank));
  await new Promise((resolve) => blankServer.listen(0, "127.0.0.1", resolve));
  const blankPort = blankServer.address().port;
  const allowBoth = { resolve: async () => "127.0.0.1" };
  const blankNode = { type: "img", content: `http://127.0.0.1:${blankPort}/mask.png`, meta: {} };
  const keep = imgNode("photo.jpg");
  const { nodes, stats } = await createImageDescriber({ describer, policy: allowBoth, store: new JsonStore(tempFile("i.json")), limits: visionLimits })([blankNode, keep], "https://p/");
  blankServer.closeAllConnections();
  await new Promise((resolve) => blankServer.close(resolve));

  assert.deepEqual(nodes.map((node) => node.content), [keep.content]);
  assert.equal(stats.blank, 1);
  assert.equal(describer.calls[0].length, 1);
});

test("이미지 요청에 User-Agent를 보낸다", async () => {
  let agent;
  const uaServer = http.createServer((req, res) => {
    agent = req.headers["user-agent"];
    res.writeHead(200, { "content-type": "image/jpeg" }).end(photo);
  });
  await new Promise((resolve) => uaServer.listen(0, "127.0.0.1", resolve));
  await fetchImage(`http://127.0.0.1:${uaServer.address().port}/a.jpg`, { ...fetchOptions(), policy: { resolve: async () => "127.0.0.1" } });
  uaServer.closeAllConnections();
  await new Promise((resolve) => uaServer.close(resolve));
  assert.match(agent, /DeconstructAPI/);
});

function fakeDescriber() {
  const calls = [];
  return {
    calls,
    cacheKey: "fake",
    async find(images) {
      calls.push(images.map((image) => image.id));
      return { descriptions: new Map(images.map(({ id }) => [id, `설명 ${id}`])), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

test("alt가 있으면 Vision을 쓰지 않고, 큰 이미지부터 개수 제한까지만 설명한다", async () => {
  const describer = fakeDescriber();
  const store = new JsonStore(tempFile("images.json"));
  const describe = createImageDescriber({ describer, policy, store, limits: visionLimits });
  const nodes = [
    imgNode("alt.jpg", { alt: "사진 설명" }),
    imgNode("small.jpg", { width: 100, height: 100 }),
    imgNode("large.jpg", { width: 1000, height: 1000 }),
    imgNode("medium.jpg", { width: 400, height: 400 }),
    imgNode("logo.svg"),
  ];
  const { stats, warnings } = await describe(nodes, "https://page.example/");
  assert.equal(nodes[0].meta.description, "사진 설명");
  assert.equal(nodes[1].meta.description, undefined);
  assert.equal(nodes[2].meta.descriptionSource, "vision");
  assert.equal(nodes[3].meta.descriptionSource, "vision");
  assert.equal(nodes[4].meta.description, undefined);
  assert.deepEqual([stats.declared, stats.vision, stats.skipped], [1, 2, 1]);
  assert.ok(warnings.includes("vision-skipped:1"));
});

test("alt가 이미지를 설명하는지 판별한다", () => {
  const meaningless = [
    "2611_RM", "2611_node", "2610_DA(P)", "2611_infosec", "2610_HERO", "IMG_1234", "IMG_1234.jpg", "photo.png", "hero-banner-01", "main-banner",
    "a1b2c3d4e5", "image", "Image1", "banner_03", "이미지", "이미지 2", "사진", "메인_배너", "https://x.io/a.jpg", "2611", "--", "", "  ", "a",
  ];
  const meaningful = [
    "Toss Blog", "Toss X", "서도호", "쉬운 찾기", "사진 설명", "iPhone 17 Pro", "iPad", "M4", "제1전시실", "Apple", "3D 프린팅 작품",
    "덕수궁관 페이지로 이동", "A photo of a lighthouse.",
  ];
  for (const text of meaningless) assert.equal(isMeaningfulText(text), false, `의미 없음이어야 함: ${text}`);
  for (const text of meaningful) assert.equal(isMeaningfulText(text), true, `의미 있음이어야 함: ${text}`);
});

test("코드 같은 alt는 무시하고 Vision으로 설명하며, 의미 있는 캡션은 살린다", async () => {
  const describer = fakeDescriber();
  const describe = createImageDescriber({ describer, policy, store: new JsonStore(tempFile("images.json")), limits: visionLimits });
  const coded = imgNode("coded.jpg", { alt: "2611_RM", width: 786, height: 160 });
  const captioned = imgNode("captioned.jpg", { alt: "IMG_0001.jpg", caption: "덕수궁 전경" });
  const { stats } = await describe([coded, captioned], "https://p/");
  assert.equal(coded.meta.descriptionSource, "vision");
  assert.equal(coded.meta.description, "설명 0");
  assert.equal(captioned.meta.descriptionSource, "declared");
  assert.equal(captioned.meta.description, "덕수궁 전경");
  assert.deepEqual([stats.declared, stats.vision], [1, 1]);
});

test("같은 이미지는 다시 비용을 쓰지 않고 파일 캐시에서 읽는다", async () => {
  const describer = fakeDescriber();
  const path = tempFile("images.json");
  await createImageDescriber({ describer, policy, store: new JsonStore(path), limits: visionLimits })([imgNode("a.jpg")], "https://p/");
  assert.equal(describer.calls.length, 1);
  const again = [imgNode("a.jpg")];
  const { stats } = await createImageDescriber({ describer, policy, store: new JsonStore(path), limits: visionLimits })(again, "https://p/");
  assert.equal(describer.calls.length, 1);
  assert.equal(stats.cached, 1);
  assert.equal(again[0].meta.description, "설명 0");
});

test("이미지를 못 받거나 Vision이 실패해도 요청은 계속된다", async () => {
  const broken = { cacheKey: "x", find: async () => { throw new Error("api down"); } };
  const nodes = [imgNode("a.jpg"), { type: "img", content: `http://127.0.0.1:${canaryPort}/x.jpg`, meta: {} }];
  const { stats, warnings } = await createImageDescriber({ describer: broken, policy, store: new JsonStore(tempFile("i.json")), limits: visionLimits })(nodes, "https://p/");
  assert.equal(stats.failed, 2);
  assert.ok(warnings.includes("vision-failed:2"));
  assert.equal(nodes[0].meta.description, undefined);
});

test("Claude 이미지 요청에 base64 이미지와 구조화 출력을 넣는다", async () => {
  const requests = [];
  const client = {
    beta: {
      messages: {
        create: async (body) => {
          requests.push(body);
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify({ results: [{ id: 3, description: "그림" }] }) }],
            usage: { input_tokens: 5, output_tokens: 2 },
          };
        },
      },
    },
  };
  const finder = createClaudeImageDescriber({ client, model: "claude-opus-5-5", effort: "low", timeoutMs: 1000, language: "Korean" });
  const { descriptions, usage } = await finder.find([{ id: 3, base64: "QUJD" }]);
  const blocks = requests[0].messages[0].content;
  assert.deepEqual(blocks[2].source, { type: "base64", media_type: "image/jpeg", data: "QUJD" });
  assert.equal(requests[0].output_config.format.type, "json_schema");
  assert.equal(requests[0].fallbacks, "default");
  assert.equal(descriptions.get(3), "그림");
  assert.equal(usage.outputTokens, 2);
});

test("임베딩 입력은 설명, 주변 글자, 파일 이름 순으로 고른다", () => {
  const nodes = [
    { type: "text", content: "앞 문단", meta: {} },
    { type: "img", content: "https://x.io/a.jpg", meta: { description: "사진 설명", descriptionSource: "vision" } },
    { type: "img", content: "https://x.io/b.jpg", meta: {} },
    { type: "text", content: "뒤 문단", meta: {} },
  ];
  assert.deepEqual(embeddingInput(nodes, 0), { text: "앞 문단", source: "text" });
  assert.deepEqual(embeddingInput(nodes, 1), { text: "사진 설명", source: "vision" });
  assert.deepEqual(embeddingInput(nodes, 2), { text: "앞 문단 뒤 문단", source: "nearby" });
  const alone = [{ type: "img", content: "https://x.io/%ED%95%9C.jpg", meta: {} }];
  assert.deepEqual(embeddingInput(alone, 0), { text: "한.jpg", source: "filename" });
});

test("임베딩이 실패하면 구분되는 오류로 알린다", async () => {
  await assert.rejects(embedNodes([{ type: "text", content: "가", meta: {} }], { name: "x", embed: async () => { throw new Error("oom"); } }), {
    code: "EMBEDDING_FAILED",
  });
});

const cacheDir = config.embed.cacheDir;

test("저장 경로에 URL 인코딩이 남지 않는다 (한글 폴더 회귀 방지)", () => {
  assert.ok(existsSync(config.dataDir.replace(/data$/, "package.json")), config.dataDir);
  assert.ok(!config.dataDir.includes("%"));
  assert.ok(!config.embed.cacheDir.includes("%"));
});

test("실제 bge-m3로 관련 문장이 더 가깝게 나온다", { skip: !existsSync(join(cacheDir, "Xenova/bge-m3")) }, async () => {
  const embedder = createLocalEmbedder({ modelId: "Xenova/bge-m3", dtype: "q8", pooling: "cls", cacheDir, batchSize: 32 });
  const nodes = [
    { type: "text", content: "미술관 전시 안내", meta: {} },
    { type: "img", content: "https://x.io/a.jpg", meta: { description: "갤러리에 전시된 회화 작품 사진", descriptionSource: "vision" } },
    { type: "text", content: "노트북 배터리 교체", meta: {} },
  ];
  const { dim } = await embedNodes(nodes, embedder);
  assert.equal(dim, 1024);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  assert.ok(Math.abs(dot(nodes[0].embedding, nodes[0].embedding) - 1) < 1e-3, "정규화되어야 한다");
  assert.ok(dot(nodes[0].embedding, nodes[1].embedding) > dot(nodes[0].embedding, nodes[2].embedding), "텍스트-이미지 관계");
});
