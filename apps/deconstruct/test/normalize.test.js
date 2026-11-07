import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeNodes, toPublicContents } from "../src/extract/normalize.js";

const text = (content) => ({ type: "text", content, meta: { kind: "text" } });
const img = (content) => ({ type: "img", content, meta: { origin: "img" } });

test("중복을 합치고 등장 횟수를 남긴다", () => {
  const { nodes } = normalizeNodes(
    [{ url: "a", nodes: [text("더보기"), text("더보기"), text("MORE"), text("more"), img("https://x.io/a.png#1"), img("https://x.io/a.png#2")] }],
    { maxContents: 10 },
  );
  assert.deepEqual(nodes.map((n) => n.content), ["더보기", "MORE", "https://x.io/a.png#1"]);
  assert.equal(nodes[0].meta.occurrences, 2);
  assert.equal(nodes[2].meta.occurrences, 2);
});

test("NFD 한글을 NFC로 맞춰 같은 글자로 합친다", () => {
  const { nodes } = normalizeNodes([{ url: "a", nodes: [text("예술".normalize("NFD")), text("예술")] }], { maxContents: 10 });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].content, "예술");
});

test("글자나 숫자가 없는 구분자를 버린다", () => {
  const { nodes } = normalizeNodes([{ url: "a", nodes: [text("|"), text("·"), text("→"), text("1"), text("가")] }], { maxContents: 10 });
  assert.deepEqual(nodes.map((n) => n.content), ["1", "가"]);
});

test("최대 개수를 넘으면 잘라내고 개수를 알린다", () => {
  const { nodes, dropped } = normalizeNodes([{ url: "a", nodes: [text("a"), text("b"), text("c")] }], { maxContents: 2 });
  assert.equal(nodes.length, 2);
  assert.equal(dropped, 1);
});

test("공개 응답에는 meta가 포함되지 않는다", () => {
  assert.deepEqual(toPublicContents([{ type: "text", content: "가", meta: { kind: "text" } }]), [{ type: "text", content: "가" }]);
});
