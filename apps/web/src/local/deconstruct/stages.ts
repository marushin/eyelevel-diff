/**
 * LLM이 있을 때와 없을 때의 분할기·이미지 설명기. 같은 객체를 계속 쓰므로 캐시가 요청 사이에 유지된다.
 * LLM 분할기는 연결(llm.profile: Nano는 small, API는 large)에 따라 한 페이지에서 맡기는 분량과 동시 호출 수가 다르다.
 */
import type { LlmProfile } from '../llm.ts';
import { config } from './config.ts';
import { createImageDescriber } from './describe.ts';
import { createLlmBoundaryFinder, createLlmImageDescriber } from './llm-finders.ts';
import { createSegmenter } from './segment.ts';

const finder = createLlmBoundaryFinder({ timeoutMs: config.segment.batchTimeoutMs });
const limitsFor = (profile: LlmProfile) => ({ ...config.segment, ...config.segmentProfiles[profile], maxContents: config.extract.maxContents });
const llmSegmenters: Record<LlmProfile, ReturnType<typeof createSegmenter>> = {
  small: createSegmenter({ finder, limits: limitsFor('small') }),
  large: createSegmenter({ finder, limits: limitsFor('large') }),
};
const ruleSegmenter = createSegmenter({ finder: null, limits: limitsFor('small') });

const visionDescriber = createImageDescriber({
  describer: createLlmImageDescriber({ timeoutMs: config.vision.timeoutMs, language: config.vision.language }),
  limits: config.vision,
});
const declaredOnly = createImageDescriber({ describer: null, limits: config.vision });

/** profile이 null이면 LLM 없이 규칙으로만 나눈다. */
export const segmenterFactory = (profile: LlmProfile | null) => (profile ? llmSegmenters[profile] : ruleSegmenter);
export const describeImagesFactory = (useVision: boolean) => (useVision ? visionDescriber : declaredOnly);
