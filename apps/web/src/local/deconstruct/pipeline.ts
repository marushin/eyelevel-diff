/**
 * 원본 apps/deconstruct/src/pipeline.js + app.js의 브라우저 판.
 * URL 하나를 추출 → 의미 분할 → 이미지 설명 → 임베딩 → 가중치 순서로 처리해 DeconstructResponse를 만든다.
 * 선택한 LLM(llm.ts)이 준비되어 있지 않으면 분할은 규칙으로, 이미지는 alt·주변 글자로 대신한다.
 */
import { llm } from '../llm.ts';
import { translatorStatus } from '../translate.ts';
import { errors } from '../errors.ts';
import { config } from './config.ts';
import { describeImagesFactory, segmenterFactory } from './stages.ts';
import { embedNodes, embedQuery, embedder, type Embedder } from './embed.ts';
import { extractPage, type PageNode } from './extract.ts';
import { createLlmPhraseFinder } from './llm-finders.ts';
import { createPhraseRefiner, phraseSimilarities, type PhraseResult } from './phrases.ts';
import { computeQuerySimilarities, computeWeights, summarizeWeights } from './weights.js';

export interface DeconstructContent { type: 'text' | 'img'; content: string; label?: string }
export interface DeconstructResponse { contents: DeconstructContent[]; weights: [number, number, number][]; querySimilarities?: number[] }

export function toPublicContents(nodes: PageNode[]): DeconstructContent[] {
  return nodes.map(({ type, content, meta }) => (type === 'img' && meta?.label ? { type, content, label: meta.label } : { type, content }));
}

let active = false;

export async function deconstruct(rawUrl: string, { query = '', signal, onProgress, target = embedder }:
  { query?: string; signal?: AbortSignal; onProgress?: (message: string) => void; target?: Embedder } = {}): Promise<DeconstructResponse> {
  if (active) throw errors.busy();
  active = true;
  try {
    const started = performance.now();
    const textReady = (await llm.status('text')) === 'ready';
    // 이미지 설명은 재검색어(label)로도 쓰여 한국어여야 한다. Nano는 영어로 답하므로 영→한 번역기가 있을 때만 맡긴다.
    const imageReady = textReady && (await llm.status('image')) === 'ready'
      && (!llm.needsTranslation || (await translatorStatus()) === 'ready');
    const profile = textReady ? llm.profile : null;
    // 임베딩 모델은 추출과 동시에 불러 둔다(첫 실행에서만 오래 걸린다).
    const modelLoading = target === embedder ? embedder.load().catch(() => {}) : Promise.resolve();

    const timings: Record<string, number> = {};
    let mark = performance.now();
    const lap = (name: string) => {
      const now = performance.now();
      timings[name] = Math.round(now - mark);
      mark = now;
    };

    const extracted = await extractPage(rawUrl, { signal, onProgress });
    lap('extract');
    const segmented = await segmenterFactory(profile)(extracted.nodes, { signal, onProgress });
    lap('segment');
    const described = await describeImagesFactory(imageReady)(segmented.nodes, { signal, onProgress });
    lap('vision');
    signal?.throwIfAborted();

    onProgress?.(embedder.state.status === 'loading' ? '임베딩 모델을 받는 중' : '조각의 의미를 계산하는 중');
    await modelLoading;
    lap('modelLoad');
    onProgress?.('조각의 의미를 계산하는 중');
    const embedding = await embedNodes(described.nodes, target);
    signal?.throwIfAborted();
    const weights = computeWeights(described.nodes) as [number, number, number][];
    const term = query.trim();
    const querySimilarities = term ? computeQuerySimilarities(described.nodes, await embedQuery(term, target)) as number[] : undefined;
    lap('embed');

    console.info('[local] deconstruct', JSON.stringify({
      url: extracted.finalUrl,
      nodes: described.nodes.length,
      ms: Math.round(performance.now() - started),
      timings,
      device: embedder.state.status === 'ready' ? embedder.state.device : embedder.state.status,
      llm: { provider: llm.cacheTag, profile, text: textReady, image: imageReady },
      segment: segmented.stats,
      vision: described.stats,
      embedding,
      weights: summarizeWeights(weights),
      warnings: [...extracted.warnings, ...segmented.warnings, ...described.warnings],
    }));
    return { contents: toPublicContents(described.nodes), weights, ...(querySimilarities ? { querySimilarities } : {}) };
  } finally {
    active = false;
  }
}

const llmRefine = createPhraseRefiner({ finder: createLlmPhraseFinder({ timeoutMs: config.refine.timeoutMs }), limit: config.refine.maxPhrases });
const ruleRefine = createPhraseRefiner({ limit: config.refine.maxPhrases });

export async function refinePhrases(text: string, query: string, signal?: AbortSignal, target: Embedder = embedder): Promise<PhraseResult & { querySimilarities?: number[] }> {
  const refine = (await llm.status('text')) === 'ready' ? llmRefine : ruleRefine;
  const result = await refine(text, signal);
  const querySimilarities = await phraseSimilarities(result.phrases, query, target);
  return querySimilarities ? { ...result, querySimilarities } : result;
}
