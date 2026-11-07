/**
 * Nano가 있을 때와 없을 때의 분할기·이미지 설명기. 같은 객체를 계속 쓰므로 캐시가 요청 사이에 유지된다.
 */
import { config } from './config.ts';
import { createImageDescriber } from './describe.ts';
import { createNanoBoundaryFinder, createNanoImageDescriber } from './nano-finders.ts';
import { createSegmenter } from './segment.ts';

const segmentLimits = { ...config.segment, maxContents: config.extract.maxContents };
const llmSegmenter = createSegmenter({ finder: createNanoBoundaryFinder({ timeoutMs: config.segment.batchTimeoutMs }), limits: segmentLimits });
const ruleSegmenter = createSegmenter({ finder: null, limits: segmentLimits });

const visionDescriber = createImageDescriber({
  describer: createNanoImageDescriber({ timeoutMs: config.vision.timeoutMs, language: config.vision.language }),
  limits: config.vision,
});
const declaredOnly = createImageDescriber({ describer: null, limits: config.vision });

export const segmenterFactory = (useLlm: boolean) => (useLlm ? llmSegmenter : ruleSegmenter);
export const describeImagesFactory = (useVision: boolean) => (useVision ? visionDescriber : declaredOnly);
