/**
 * 원본 apps/deconstruct/src/segment/segmentNodes.js의 브라우저 판.
 * 긴 텍스트만 의미 단위로 나눈다. LLM(Gemini Nano)은 경계의 토큰 번호만 고르고, 실제 자르기는
 * rules.js의 applyBreaks가 하므로 원문에 없는 글자가 생기지 않는다. LLM이 없거나 실패하면 규칙 분할로 이어 간다.
 */
import { normalizeNodes } from './normalize.js';
import { applyBreaks, ruleBreaks, tokenize } from './rules.js';
import type { PageNode } from './extract.ts';

const KEEP_WHOLE_KINDS = new Set(['link', 'button']);
const CACHE_SIZE = 2000;

export interface BoundaryFinder {
  cacheKey: string;
  find(items: { id: number; tokens: string[] }[], signal?: AbortSignal): Promise<{ breaks: Map<number, unknown> }>;
}

export interface SegmentLimits {
  minChars: number;
  minPieceChars: number;
  maxSentenceChars: number;
  maxBatchChars: number;
  maxLlmCharsPerPage: number;
  llmConcurrency: number;
  maxContents: number;
}

interface Item { id: number; text: string; tokens: { text: string; start: number }[]; offsets: number[] | null }

export function createSegmenter({ finder, limits }: { finder: BoundaryFinder | null; limits: SegmentLimits }) {
  const cache = new Map<string, number[]>();
  const cacheKey = (text: string) => `${finder?.cacheKey}\0${text}`;
  const remember = (key: string, breaks: number[]) => {
    cache.set(key, breaks);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  };

  function makeBatches(items: Item[]): Item[][] {
    const batches: Item[][] = [];
    let current: Item[] = [];
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

  async function askLlm(items: Item[], stats: Record<string, number>, signal?: AbortSignal, onProgress?: (message: string) => void) {
    const pending: Item[] = [];
    let budget = limits.maxLlmCharsPerPage;
    // 긴 글부터 LLM에 맡긴다. 짧은 글은 규칙 분할로도 충분히 자연스럽다.
    for (const item of [...items].sort((a, b) => b.text.length - a.text.length)) {
      const cached = cache.get(cacheKey(item.text));
      if (cached) {
        item.offsets = cached.map((index) => item.tokens[index]!.start);
        stats.cacheHits! += 1;
      } else if (item.text.length <= budget && item.text.length <= limits.maxBatchChars) {
        budget -= item.text.length;
        pending.push(item);
      } else {
        stats.overBudget! += 1;
      }
    }
    pending.sort((a, b) => a.id - b.id);
    const queue = makeBatches(pending);
    const total = queue.length;
    const worker = async () => {
      for (let batch = queue.shift(); batch; batch = queue.shift()) {
        if (signal?.aborted) return;
        stats.llmCalls! += 1;
        onProgress?.(`Gemini Nano가 문장을 나누는 중 (${stats.llmCalls}/${total})`);
        try {
          const { breaks } = await finder!.find(batch.map((item) => ({ id: item.id, tokens: item.tokens.map((token) => token.text) })), signal);
          for (const item of batch) {
            const raw = breaks.get(item.id);
            if (!Array.isArray(raw)) {
              stats.llmFailures! += 1;
              continue;
            }
            const valid = raw.filter((index): index is number => Number.isInteger(index) && index > 0 && index < item.tokens.length);
            remember(cacheKey(item.text), valid);
            item.offsets = valid.map((index) => item.tokens[index]!.start);
          }
        } catch (error) {
          if (signal?.aborted) return;
          stats.llmFailures! += batch.length;
          console.warn('[local] 의미 분할 실패, 규칙 분할로 대체', error);
        }
      }
    };
    await Promise.all(Array.from({ length: limits.llmConcurrency }, worker));
  }

  return async function segment(nodes: PageNode[], { signal, onProgress }: { signal?: AbortSignal; onProgress?: (message: string) => void } = {}) {
    const stats: Record<string, number> = { targets: 0, splitSources: 0, llmCalls: 0, llmFailures: 0, cacheHits: 0, overBudget: 0 };
    const items: Item[] = [];
    nodes.forEach((node, id) => {
      if (node.type !== 'text' || KEEP_WHOLE_KINDS.has(node.meta.kind) || node.content.length <= limits.minChars) return;
      items.push({ id, text: node.content, tokens: tokenize(node.content), offsets: null });
    });
    stats.targets = items.length;
    if (finder && items.length) await askLlm(items, stats, signal, onProgress);
    signal?.throwIfAborted();

    const byId = new Map(items.map((item) => [item.id, item]));
    const output: PageNode[] = [];
    nodes.forEach((node, id) => {
      const item = byId.get(id);
      if (!item) {
        output.push(node);
        return;
      }
      const method = item.offsets ? 'llm' : 'rule';
      const offsets = item.offsets ?? ruleBreaks(item.text, limits);
      const pieces = applyBreaks(item.text, offsets, { minChars: limits.minPieceChars });
      if (pieces.length <= 1) {
        output.push(node);
        return;
      }
      stats.splitSources! += 1;
      pieces.forEach((content: string, part: number) => {
        output.push({ type: 'text', content, meta: { ...node.meta, segment: { method, part, parts: pieces.length } } });
      });
    });

    const { nodes: merged, dropped } = normalizeNodes([{ nodes: output }], { maxContents: limits.maxContents });
    const warnings: string[] = [];
    if (stats.llmFailures) warnings.push(`segment-llm-failed:${stats.llmFailures}`);
    if (stats.overBudget) warnings.push(`segment-llm-budget:${stats.overBudget}`);
    if (!finder && items.length) warnings.push('segment-rule-only');
    if (dropped) warnings.push(`contents-dropped:${dropped}`);
    return { nodes: merged as PageNode[], stats, warnings };
  };
}
