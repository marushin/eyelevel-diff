/** URL 하나를 처리하는 전체 단계를 잇는다: 추출, 의미 분할, 이미지 설명, 임베딩, 가중치. */
import { createImageDescriber } from "./describe/describeImages.js";
import { embedNodes, embedQuery } from "./embed/embedNodes.js";
import { extractPage } from "./extract/extractPage.js";
import { computeQuerySimilarities, computeWeights, summarizeWeights } from "./graph/weights.js";
import { parseInputUrl, publicInternetPolicy } from "./security/urlPolicy.js";
import { createSegmenter } from "./segment/segmentNodes.js";

export function createPipeline({
  config,
  browserManager,
  policy = publicInternetPolicy,
  finder = null,
  describer = null,
  embedder = null,
  ledger = null,
  imageStore = { data: {}, reload() {}, save() {} },
}) {
  const segment = createSegmenter({
    finder,
    limits: { ...config.segment, maxContents: config.extract.maxContents },
  });
  const describeImages = createImageDescriber({ describer, policy, store: imageStore, limits: config.vision });

  return async function deconstruct(rawUrl, { query = "" } = {}) {
    const extracted = await extractPage(parseInputUrl(rawUrl), {
      browserManager,
      policy,
      limits: config.page,
      extractLimits: config.extract,
    });
    // 이후 단계는 브라우저 자리를 돌려준 뒤 실행되므로 다른 요청의 렌더링을 막지 않는다.
    const segmented = await segment(extracted.nodes);
    const described = await describeImages(segmented.nodes, extracted.finalUrl);
    const embedding = embedder ? await embedNodes(described.nodes, embedder) : null;
    const weights = embedding ? computeWeights(described.nodes) : [];
    const searchTerm = query.trim();
    const querySimilarities = embedding && searchTerm
      ? computeQuerySimilarities(described.nodes, await embedQuery(searchTerm, embedder))
      : undefined;
    return {
      ...extracted,
      nodes: described.nodes,
      weights,
      querySimilarities,
      warnings: [...extracted.warnings, ...segmented.warnings, ...described.warnings],
      stats: {
        ...extracted.stats,
        segment: segmented.stats,
        vision: described.stats,
        embedding,
        weights: summarizeWeights(weights),
        budget: ledger?.summary() ?? null,
      },
    };
  };
}
