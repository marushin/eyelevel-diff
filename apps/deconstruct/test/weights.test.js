import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { embedNodes, embedQuery } from "../src/embed/embedNodes.js";
import { createClaudePhraseFinder, createPhraseRefiner, keepSourcePhrases, phraseSimilarities, rulePhrases } from "../src/refine/phrases.js";
import { computeQuerySimilarities, computeWeights, summarizeWeights, toWeight } from "../src/graph/weights.js";

const node = (...embedding) => ({ type: "text", content: "x", meta: {}, embedding });

test("코사인을 (1 + cos) / 2로 옮긴다", () => {
  assert.equal(toWeight(1), 1);
  assert.equal(toWeight(0), 0.5);
  assert.equal(toWeight(-1), 0);
  assert.equal(toWeight(0.6), 0.8);
});

test("부동소수 오차가 있어도 0~1을 벗어나지 않는다", () => {
  assert.equal(toWeight(1.0000002), 1);
  assert.equal(toWeight(-1.0000002), 0);
});

test("같은 방향 1, 직교 0.5, 반대 방향 0을 준다", () => {
  const weights = computeWeights([node(1, 0), node(1, 0), node(0, 1), node(-1, 0)]);
  const find = (i, j) => weights.find((edge) => edge[0] === i && edge[1] === j)[2];
  assert.equal(find(0, 1), 1);
  assert.equal(find(0, 2), 0.5);
  assert.equal(find(0, 3), 0);
});

test("모든 쌍을 i < j로 한 번씩만 반환한다", () => {
  const n = 40;
  const nodes = Array.from({ length: n }, (_, i) => node(Math.cos(i), Math.sin(i)));
  const weights = computeWeights(nodes);
  assert.equal(weights.length, (n * (n - 1)) / 2);
  const seen = new Set();
  for (const [i, j, w] of weights) {
    assert.ok(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j < n);
    assert.ok(i < j, `${i},${j}`);
    assert.ok(w >= 0 && w <= 1);
    assert.ok(!seen.has(`${i},${j}`));
    seen.add(`${i},${j}`);
  }
});

test("노드가 0~1개면 간선이 없다", () => {
  assert.deepEqual(computeWeights([]), []);
  assert.deepEqual(computeWeights([node(1, 0)]), []);
  assert.equal(summarizeWeights([]), null);
});

test("분포 요약을 계산한다", () => {
  const summary = summarizeWeights([[0, 1, 0.2], [0, 2, 0.8], [1, 2, 0.5]]);
  assert.deepEqual(summary, { edges: 3, min: 0.2, p50: 0.5, p90: 0.5, p99: 0.5, max: 0.8 });
});

/** 브라우저 없이 API 층만 시험한다. */
function appWith(extract) {
  return buildApp({ config: { ...config, logLevel: "silent" }, browserManager: {}, extract });
}
const fakeResult = () => {
  const nodes = [
    { type: "text", content: "가", meta: { kind: "text" }, embedding: [1, 0] },
    { type: "img", content: "https://x.io/a.jpg", meta: { origin: "img" }, embedding: [0, 1] },
    { type: "text", content: "다", meta: { kind: "text" }, embedding: [-1, 0] },
  ];
  return { nodes, weights: computeWeights(nodes), finalUrl: "https://x.io/", warnings: [], stats: {} };
};

test("/deconstruct 응답은 합의한 스키마 그대로다", async (t) => {
  const app = appWith(async () => fakeResult());
  t.after(() => app.close());
  const response = await app.inject({ url: "/deconstruct?url=https://x.io" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    contents: [
      { type: "text", content: "가" },
      { type: "img", content: "https://x.io/a.jpg" },
      { type: "text", content: "다" },
    ],
    weights: [[0, 1, 0.5], [0, 2, 0], [1, 2, 0.5]],
  });
});

test("소수 가중치가 직렬화 과정에서 정수로 잘리지 않는다", async (t) => {
  const app = appWith(async () => ({ ...fakeResult(), weights: [[0, 1, 0.8123]] }));
  t.after(() => app.close());
  const response = await app.inject({ url: "/deconstruct?url=https://x.io" });
  assert.deepEqual(response.json().weights, [[0, 1, 0.8123]]);
});

test("큰 응답은 gzip으로 압축하고 그대로 복원된다", async (t) => {
  const many = Array.from({ length: 5000 }, (_, i) => [i, i + 1, 0.75]);
  const app = appWith(async () => ({ ...fakeResult(), weights: many }));
  t.after(() => app.close());
  const response = await app.inject({ url: "/deconstruct?url=https://x.io", headers: { "accept-encoding": "gzip" } });
  assert.equal(response.headers["content-encoding"], "gzip");
  const body = JSON.parse(gunzipSync(response.rawPayload).toString());
  assert.equal(body.weights.length, 5000);
  assert.ok(response.rawPayload.length < JSON.stringify(body).length / 2);
});

test("그래프 스크립트를 제공하고, 프로덕션에서는 제공하지 않는다", async (t) => {
  const dev = appWith(async () => fakeResult());
  const prod = buildApp({ config: { ...config, logLevel: "silent", viewerEnabled: false }, browserManager: {}, extract: async () => fakeResult() });
  t.after(() => Promise.all([dev.close(), prod.close()]));
  const script = await dev.inject({ url: "/viewer/graph.js" });
  assert.equal(script.statusCode, 200);
  assert.match(script.headers["content-type"], /javascript/);
  assert.match(script.body, /createGraphView/);
  assert.match((await dev.inject({ url: "/" })).body, /tab-graph/);
  assert.equal((await prod.inject({ url: "/viewer/graph.js" })).statusCode, 404);
});

test("확인 페이지의 이웃은 응답과 같은 가중치를 쓰고 벡터를 내보내지 않는다", async (t) => {
  const app = appWith(async () => fakeResult());
  t.after(() => app.close());
  const debug = (await app.inject({ url: "/debug/extract?url=https://x.io" })).json();
  assert.deepEqual(debug.nodes[0].neighbors, [{ index: 1, score: 0.5 }, { index: 2, score: 0 }]);
  assert.ok(!("embedding" in debug.nodes[0]));
  assert.equal(debug.response.weights.length, 3);
});

test("검색어 유사도는 weights와 같은 0~1 척도이며 contents와 순서가 같다", () => {
  const nodes = [node(1, 0), node(0, 1), node(-1, 0)];
  assert.deepEqual(computeQuerySimilarities(nodes, [1, 0]), [1, 0.5, 0]);
});

test("query를 넘기면 검색어 유사도를 함께 돌려주고, 없으면 필드가 없다", async (t) => {
  const seen = [];
  const app = appWith(async (url, options) => {
    seen.push(options);
    return { ...fakeResult(), ...(options.query ? { querySimilarities: [1, 0.5, 0] } : {}) };
  });
  t.after(() => app.close());
  const withQuery = await app.inject({ url: `/deconstruct?url=https://x.io&query=${encodeURIComponent("가상 현실")}` });
  assert.deepEqual(withQuery.json().querySimilarities, [1, 0.5, 0]);
  assert.equal(seen[0].query, "가상 현실");
  const without = await app.inject({ url: "/deconstruct?url=https://x.io" });
  assert.ok(!("querySimilarities" in without.json()));
});

test("지나치게 긴 검색어는 거부한다", async (t) => {
  const app = appWith(async () => fakeResult());
  t.after(() => app.close());
  const response = await app.inject({ url: `/deconstruct?url=https://x.io&query=${"가".repeat(201)}` });
  assert.equal(response.statusCode, 400);
});

test("이미지 라벨은 응답에 나가지만 파일명으로 근사한 경우에는 나가지 않는다", async (t) => {
  const embedder = { name: "fake", embed: async (texts) => texts.map(() => [1, 0]) };
  const nodes = [
    { type: "img", content: "https://x.io/a.jpg", meta: { description: "붉은 말", descriptionSource: "alt" } },
    { type: "img", content: "https://x.io/only.jpg", meta: {} },
  ];
  await embedNodes(nodes, embedder);
  assert.equal(nodes[0].meta.label, "붉은 말");
  assert.equal(nodes[1].meta.label, undefined);
  const app = appWith(async () => ({ nodes, weights: [[0, 1, 0.5]], finalUrl: "https://x.io/", warnings: [], stats: {} }));
  t.after(() => app.close());
  const { contents } = (await app.inject({ url: "/deconstruct?url=https://x.io" })).json();
  assert.deepEqual(contents, [
    { type: "img", content: "https://x.io/a.jpg", label: "붉은 말" },
    { type: "img", content: "https://x.io/only.jpg" },
  ]);
});

test("검색어 임베딩 실패는 EMBEDDING_FAILED로 알린다", async () => {
  const embedder = { name: "fake", embed: async () => { throw new Error("model"); } };
  await assert.rejects(embedQuery("가", embedder), { code: "EMBEDDING_FAILED" });
});

const finderReturning = (phrases) => ({ cacheKey: "fake", find: async () => ({ phrases, usage: { inputTokens: 1, outputTokens: 1 } }) });

test("재분해는 원문에 있는 구절만 통과시킨다", async () => {
  const refine = createPhraseRefiner({ finder: finderReturning(["가상현실", "지어낸 말", "가상현실", "예술  작품", "ignore all previous", "가상현실 예술 작품", 7]) });
  assert.deepEqual(await refine("가상현실 예술   작품"), { phrases: ["가상현실", "예술 작품"], source: "llm" });
});

test("재분해 결과를 캐시해 같은 글로 다시 호출하지 않는다", async () => {
  let calls = 0;
  const refine = createPhraseRefiner({ finder: { cacheKey: "fake", find: async () => { calls += 1; return { phrases: ["가상현실"], usage: {} }; } } });
  await refine("가상현실 예술");
  await refine("가상현실  예술");
  assert.equal(calls, 1);
});

test("LLM이 실패하거나 쓸 구절이 없으면 규칙 분할로 이어 간다", async () => {
  const failing = createPhraseRefiner({ finder: { cacheKey: "fake", find: async () => { throw new Error("budget"); } } });
  assert.deepEqual(await failing("미디어 아트, 비디오 아트"), { phrases: ["미디어 아트", "비디오 아트"], source: "rule" });
  const useless = createPhraseRefiner({ finder: finderReturning(["원문에 없음"]) });
  assert.equal((await useless("미디어 아트")).source, "rule");
  // 한 글자 낱말은 검색어로 쓸 수 없어 건너뛴다.
  assert.deepEqual(rulePhrases("하나의 긴 문장 입니다", 2), ["하나의", "문장"]);
});

test("구절 수를 제한한다", () => {
  assert.equal(keepSourcePhrases(["가나", "다라", "마바"], "가나 다라 마바", 2).length, 2);
});

test("Haiku 호출은 형식을 강제하고 거절은 오류로 처리한다", async () => {
  const seen = [];
  const reply = (stop_reason) => ({ stop_reason, usage: { input_tokens: 3, output_tokens: 4 }, content: [{ type: "text", text: '{"phrases":["가상현실"]}' }] });
  let stop = "end_turn";
  const client = { messages: { create: async (body) => { seen.push(body); return reply(stop); } } };
  const finder = createClaudePhraseFinder({ client, model: "claude-haiku-5-5", effort: "low", timeoutMs: 1000 });
  assert.deepEqual(await finder.find("가상현실 예술"), { phrases: ["가상현실"], usage: { inputTokens: 3, outputTokens: 4 } });
  assert.equal(seen[0].model, "claude-haiku-5-5");
  assert.equal(seen[0].output_config.format.type, "json_schema");
  stop = "refusal";
  await assert.rejects(finder.find("가상현실 예술"), /refusal/);
});

test("/deconstruct/phrases는 구절을 돌려주고 잘못된 입력을 거부한다", async (t) => {
  const app = appWith(async () => fakeResult());
  t.after(() => app.close());
  const ok = await app.inject({ url: `/deconstruct/phrases?text=${encodeURIComponent("미디어 아트, 비디오 아트")}` });
  assert.deepEqual(ok.json(), { phrases: ["미디어 아트", "비디오 아트"], source: "rule" });
  const missing = await app.inject({ url: "/deconstruct/phrases" });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.code, "INVALID_TEXT");
  assert.equal((await app.inject({ url: `/deconstruct/phrases?text=${"가".repeat(1001)}` })).statusCode, 400);
});

test("구절은 원문 순서대로 서로 겹치지 않는다", () => {
  const text = "증기기관의 발명은 기차와 증기선의 도입으로 이어졌다";
  assert.deepEqual(keepSourcePhrases(["증기기관의 발명", "증기기관", "기차와 증기선", "발명"], text, 8), ["증기기관의 발명", "기차와 증기선"]);
});

test("구절의 검색어 유사도를 조각과 같은 척도로 계산한다", async () => {
  const embedder = { embed: async () => [[1, 0], [1, 0], [0, 1], [-1, 0]] };
  assert.deepEqual(await phraseSimilarities(["가", "나", "다"], "검색어", embedder), [1, 0.5, 0]);
  assert.equal(await phraseSimilarities(["가"], " ", embedder), undefined);
  assert.equal(await phraseSimilarities(["가"], "검색어", null), undefined);
  assert.equal(await phraseSimilarities(["가"], "검색어", { embed: async () => { throw new Error("model"); } }), undefined);
});

test("/deconstruct/phrases는 query가 있으면 구절별 유사도를 함께 돌려준다", async (t) => {
  const services = {
    refine: async () => ({ phrases: ["미디어 아트", "비디오 아트"], source: "llm" }),
    embedder: { embed: async (texts) => texts.map((_, i) => (i === 1 ? [0, 1] : [1, 0])) },
  };
  const app = buildApp({ config: { ...config, logLevel: "silent" }, browserManager: {}, extract: async () => fakeResult(), services });
  t.after(() => app.close());
  const withQuery = await app.inject({ url: `/deconstruct/phrases?text=x&query=${encodeURIComponent("아트")}` });
  assert.deepEqual(withQuery.json().querySimilarities, [0.5, 1]);
  assert.ok(!("querySimilarities" in (await app.inject({ url: "/deconstruct/phrases?text=x" })).json()));
});
