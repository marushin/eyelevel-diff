/**
 * 추출된 노드 중 긴 텍스트만 의미 단위로 나눈다. 메뉴, 버튼처럼 짧거나 눌러야 하는 글자는 그대로 둔다.
 * LLM이 없거나 실패하면 규칙 분할로 이어 가므로 이 단계는 요청을 실패시키지 않는다.
 */
import { createHash } from "node:crypto";
import { normalizeNodes } from "../extract/normalize.js";
import { applyBreaks, ruleBreaks, tokenize } from "./rules.js";

const KEEP_WHOLE_KINDS = new Set(["link", "button"]);
const CACHE_SIZE = 5000;

export function createSegmenter({ finder, limits }) {
  const cache = new Map();
  const cacheKey = (text) => createHash("sha256").update(`${finder?.cacheKey}\0${text}`).digest("base64");

  const remember = (key, breaks) => {
    cache.set(key, breaks);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  };

  /** 입력 글자 수 기준으로 호출 단위를 묶는다. */
  function makeBatches(items) {
    const batches = [];
    let current = [];
    let chars = 0;
    for (const item of items) {
      if (current.length && chars + item.text.length > limits.maxBatchChars) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += item.text.length;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  /** 항목별 글자 위치 경계를 채운다. 실패한 항목은 비워 두어 규칙 분할로 넘어가게 한다. */
  async function askLlm(items, stats) {
    const pending = [];
    let budget = limits.maxLlmCharsPerPage;
    for (const item of items) {
      const cached = cache.get(cacheKey(item.text));
      if (cached) {
        item.offsets = cached.map((index) => item.tokens[index].start);
        stats.cacheHits += 1;
      } else if (item.text.length <= budget) {
        budget -= item.text.length;
        pending.push(item);
      } else {
        stats.overBudget += 1;
      }
    }

    const queue = makeBatches(pending);
    const worker = async () => {
      for (let batch = queue.shift(); batch; batch = queue.shift()) {
        stats.llmCalls += 1;
        try {
          const { breaks, usage } = await finder.find(
            batch.map((item) => ({ id: item.id, tokens: item.tokens.map((token) => token.text) })),
          );
          stats.inputTokens += usage.inputTokens;
          stats.outputTokens += usage.outputTokens;
          for (const item of batch) {
            const raw = breaks.get(item.id);
            if (!Array.isArray(raw)) {
              stats.llmFailures += 1;
              continue;
            }
            const valid = raw.filter((index) => Number.isInteger(index) && index > 0 && index < item.tokens.length);
            remember(cacheKey(item.text), valid);
            item.offsets = valid.map((index) => item.tokens[index].start);
          }
        } catch (error) {
          stats.llmFailures += batch.length;
          stats.lastError = error?.constructor?.name ?? "Error";
        }
      }
    };
    await Promise.all(Array.from({ length: limits.llmConcurrency }, worker));
  }

  return async function segment(nodes) {
    const stats = {
      mode: finder ? "llm" : "rule",
      targets: 0, splitSources: 0, llmCalls: 0, llmFailures: 0, cacheHits: 0, overBudget: 0, inputTokens: 0, outputTokens: 0,
    };
    const items = [];
    nodes.forEach((node, id) => {
      if (node.type !== "text" || KEEP_WHOLE_KINDS.has(node.meta.kind) || node.content.length <= limits.minChars) return;
      items.push({ id, text: node.content, tokens: tokenize(node.content), offsets: null });
    });
    stats.targets = items.length;
    if (finder && items.length) await askLlm(items, stats);

    const byId = new Map(items.map((item) => [item.id, item]));
    const output = [];
    nodes.forEach((node, id) => {
      const item = byId.get(id);
      if (!item) {
        output.push(node);
        return;
      }
      const method = item.offsets ? "llm" : "rule";
      const offsets = item.offsets ?? ruleBreaks(item.text, limits);
      const pieces = applyBreaks(item.text, offsets, { minChars: limits.minPieceChars });
      if (pieces.length <= 1) {
        output.push(node);
        return;
      }
      stats.splitSources += 1;
      pieces.forEach((content, part) => {
        output.push({
          type: "text",
          content,
          meta: { ...node.meta, segment: { method, part, parts: pieces.length } },
        });
      });
    });

    const { nodes: merged, dropped } = normalizeNodes([{ nodes: output }], { maxContents: limits.maxContents });
    const warnings = [];
    if (stats.lastError === "BudgetExhaustedError") warnings.push("llm-budget-exhausted");
    else if (stats.llmFailures) warnings.push(`segment-llm-failed:${stats.llmFailures}`);
    if (stats.overBudget) warnings.push(`segment-llm-budget:${stats.overBudget}`);
    if (!finder && items.length) warnings.push("segment-rule-only");
    if (dropped) warnings.push(`contents-dropped:${dropped}`);
    return { nodes: merged, stats, warnings };
  };
}
