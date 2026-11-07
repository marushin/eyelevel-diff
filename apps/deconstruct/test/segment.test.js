import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeBoundaryFinder } from "../src/segment/claudeBoundaryFinder.js";
import { applyBreaks, ruleBreaks, tokenize } from "../src/segment/rules.js";
import { createSegmenter } from "../src/segment/segmentNodes.js";

const limits = {
  minChars: 60, minPieceChars: 8, maxSentenceChars: 100, maxBatchChars: 200, maxLlmCharsPerPage: 1000, llmConcurrency: 2, maxContents: 500,
};
const ruleOptions = { minChars: limits.minPieceChars, maxSentenceChars: limits.maxSentenceChars };
const noSpaces = (text) => text.replace(/\s+/g, "");
const node = (content, kind = "text") => ({ type: "text", content, meta: { kind, tag: "p", region: "main" } });

const KO = "예술은 사람들을 결합시키고 감정이나 사상을 전달하는 수단이 된다. 과학도 같은 구실을 하기는 하나 과학은 주로 개념으로 설명한다. 그러나 아름다움만으로는 부족하다.";

test("규칙 분할은 문장으로 나누고 글자를 바꾸지 않는다", () => {
  const pieces = applyBreaks(KO, ruleBreaks(KO, ruleOptions), { minChars: 8 });
  assert.equal(pieces.length, 3);
  assert.equal(pieces[1], "과학도 같은 구실을 하기는 하나 과학은 주로 개념으로 설명한다.");
  assert.equal(noSpaces(pieces.join("")), noSpaces(KO));
});

test("약어나 짧은 조각은 이웃에 붙는다", () => {
  const text = "Dr. Kim said art connects people across cultures. Yes. It also moves them deeply over time.";
  const pieces = applyBreaks(text, ruleBreaks(text, ruleOptions), { minChars: 8 });
  assert.ok(pieces.every((piece) => piece.length >= 8), JSON.stringify(pieces));
  assert.ok(pieces[0].startsWith("Dr. Kim"));
  assert.equal(noSpaces(pieces.join("")), noSpaces(text));
});

test("구분 기호와 지나치게 긴 문장의 절에서 나눈다", () => {
  const legal = "애플코리아 유한회사 | 대표이사: Mark Lee | 주소: 서울특별시 강남구 영동대로 517";
  assert.equal(applyBreaks(legal, ruleBreaks(legal, ruleOptions), { minChars: 8 }).length, 3);
  const long = `${"가나다라마 ".repeat(15)}, ${"바사아자차 ".repeat(15)}`;
  assert.equal(applyBreaks(long, ruleBreaks(long, ruleOptions), { minChars: 8 }).length, 2);
});

test("토큰 위치로 원문을 복원할 수 있고, 띄어쓰기 없는 언어도 잘게 나눈다", () => {
  const text = "  예술은   사람을 잇는다 ";
  for (const token of tokenize(text)) assert.equal(text.slice(token.start, token.start + token.text.length), token.text);
  assert.ok(tokenize("今日は天気がとても良いので公園へ散歩に行きました").length > 3);
});

/** 형식만 맞춘 가짜 Claude. 받은 요청을 기록하고 정해진 답을 돌려준다. */
function fakeClient(respond) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        async create(body, options) {
          requests.push({ body, options });
          return respond(body);
        },
      },
    },
  };
}
const okResponse = (results) => ({
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ results }) }],
  usage: { input_tokens: 100, output_tokens: 20 },
});

test("Claude 요청에 구조화 출력과 폴백을 넣고, 응답에서 경계를 읽는다", async () => {
  const client = fakeClient(() => okResponse([{ id: 7, breaks: [2] }]));
  const finder = createClaudeBoundaryFinder({ client, model: "claude-opus-5-5", effort: "low", timeoutMs: 1000 });
  const { breaks, usage } = await finder.find([{ id: 7, tokens: ["가", "나", "다"] }]);

  const { body, options } = client.requests[0];
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(body.messages[0].content, '<text id="7">0:가 1:나 2:다</text>');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(breaks.get(7), [2]);
  assert.equal(usage.inputTokens, 100);
});

test("Haiku에는 지원되지 않는 서버 폴백을 보내지 않는다", async () => {
  const client = fakeClient(() => okResponse([]));
  const finder = createClaudeBoundaryFinder({ client, model: "claude-haiku-5-5", effort: "low", timeoutMs: 1000 });
  await finder.find([{ id: 0, tokens: ["가"] }]);
  assert.equal(client.requests[0].body.fallbacks, undefined);
  assert.equal(client.requests[0].body.betas, undefined);
});

test("거절이나 잘린 응답은 예외가 되어 규칙 분할로 넘어간다", async () => {
  for (const stop_reason of ["refusal", "max_tokens"]) {
    const client = fakeClient(() => ({ stop_reason, content: [], usage: { input_tokens: 0, output_tokens: 0 } }));
    const finder = createClaudeBoundaryFinder({ client, model: "claude-opus-5-5", effort: "low", timeoutMs: 1000 });
    const { nodes, stats, warnings } = await createSegmenter({ finder, limits })([node(KO)]);
    assert.equal(nodes.length, 3);
    assert.ok(nodes.every((n) => n.meta.segment.method === "rule"));
    assert.equal(stats.llmFailures, 1);
    assert.ok(warnings.includes("segment-llm-failed:1"));
  }
});

const scriptedFinder = (reply) => {
  const calls = [];
  return {
    calls,
    cacheKey: "test",
    async find(items) {
      calls.push(items);
      return { breaks: new Map(items.map((item) => [item.id, reply(item)])), usage: { inputTokens: 10, outputTokens: 1 } };
    },
  };
};

test("긴 텍스트만 LLM에 보내고 문서 순서와 메타데이터를 유지한다", async () => {
  const finder = scriptedFinder(() => [5]);
  const segment = createSegmenter({ finder, limits });
  const longLink = "링크 글자는 아무리 길어도 눌러야 하는 하나의 단위이므로 절대로 나누지 않고 원래 모습 그대로 유지합니다 끝.";
  const { nodes, stats } = await segment([node("짧은 메뉴"), node(KO), node(longLink, "link"), node("푸터 문구")]);

  assert.equal(finder.calls.length, 1);
  assert.equal(finder.calls[0].length, 1);
  assert.equal(stats.targets, 1);
  assert.equal(nodes[0].content, "짧은 메뉴");
  assert.deepEqual(nodes[1].meta.segment, { method: "llm", part: 0, parts: 2 });
  assert.equal(nodes[1].meta.region, "main");
  assert.equal(noSpaces(nodes[1].content + nodes[2].content), noSpaces(KO));
  assert.equal(nodes[3].content, longLink);
  assert.equal(nodes[4].content, "푸터 문구");
});

test("LLM이 어떤 번호를 돌려줘도 응답은 원문 조각뿐이다", async () => {
  const attacks = [
    [-1, 0, 1.5, 9999, "x", null],
    [1, 1, 1],
    [],
  ];
  for (const breaks of attacks) {
    const { nodes } = await createSegmenter({ finder: scriptedFinder(() => breaks), limits })([node(KO)]);
    assert.equal(noSpaces(nodes.map((n) => n.content).join("")), noSpaces(KO), JSON.stringify(breaks));
  }
});

test("같은 텍스트는 캐시하고, 빈 경계도 다시 묻지 않는다", async () => {
  const finder = scriptedFinder(() => []);
  const segment = createSegmenter({ finder, limits });
  await segment([node(KO)]);
  const { nodes, stats } = await segment([node(KO)]);
  assert.equal(finder.calls.length, 1);
  assert.equal(stats.cacheHits, 1);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].content, KO);
});

test("긴 입력은 배치로 나누고, 예산을 넘으면 규칙 분할로 처리한다", async () => {
  const finder = scriptedFinder(() => [3]);
  const segment = createSegmenter({ finder, limits: { ...limits, maxBatchChars: 100, maxLlmCharsPerPage: 200 } });
  const texts = Array.from({ length: 4 }, (_, i) => node(`${i}번 ${KO}`));
  const { stats, warnings } = await segment(texts);
  assert.ok(finder.calls.length >= 2);
  assert.ok(finder.calls.every((batch) => batch.length === 1));
  assert.ok(stats.overBudget > 0);
  assert.ok(warnings.some((warning) => warning.startsWith("segment-llm-budget")));
});

test("LLM 없이도 동작하고 그 사실을 알린다", async () => {
  const { nodes, stats, warnings } = await createSegmenter({ finder: null, limits })([node(KO)]);
  assert.equal(nodes.length, 3);
  assert.equal(stats.mode, "rule");
  assert.ok(warnings.includes("segment-rule-only"));
});
