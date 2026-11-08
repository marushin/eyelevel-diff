/**
 * 원본 apps/deconstruct/src/config.js의 값을 브라우저와 Gemini Nano에 맞게 고쳤다.
 * Nano는 입력 한도가 작고 한 번에 하나씩 처리하므로 배치 크기와 페이지당 LLM 분량을 크게 줄였다.
 * API나 로컬 LLM을 연결하면 segmentProfiles 값으로 덮어쓴다.
 */
export const config = {
  page: {
    fetchTimeoutMs: 20_000,
    loadWaitMs: 8_000,
    scrollBudgetMs: 6_000,
    maxScrollScreens: 30,
    settleQuietMs: 400,
    settleMaxMs: 2_500,
    maxBytes: 20 * 1024 * 1024,
    viewport: { width: 1440, height: 900 },
  },
  extract: {
    maxContents: 500,
    maxVisitedNodes: 150_000,
    maxTextChars: 20_000,
  },
  segment: {
    minChars: 60,
    minPieceChars: 8,
    maxSentenceChars: 100,
    maxBatchChars: 1_200,
    maxLlmCharsPerPage: 6_000,
    llmConcurrency: 1,
    batchTimeoutMs: 40_000,
  },
  /**
   * 연결한 모델 크기별 분할 분량. small은 위 segment 값(Gemini Nano) 그대로다.
   * large(Claude·OpenAI)는 원본 서버처럼 페이지당 24,000자까지 맡기고 동시에 보낸다.
   * medium(로컬 LLM)은 한 번에 하나씩 처리하는 경우가 많아 동시 호출 없이 분량만 늘린다.
   */
  segmentProfiles: {
    small: {},
    medium: { maxBatchChars: 2_000, maxLlmCharsPerPage: 12_000, llmConcurrency: 1 },
    large: { maxBatchChars: 4_000, maxLlmCharsPerPage: 24_000, llmConcurrency: 4 },
  },
  refine: {
    maxPhrases: 8,
    timeoutMs: 20_000,
  },
  vision: {
    language: 'Korean',
    maxPerPage: 6,
    maxEdge: 512,
    minEdge: 64,
    maxImageBytes: 15 * 1024 * 1024,
    fetchTimeoutMs: 8_000,
    timeoutMs: 30_000,
    unknownArea: 90_000,
  },
  embed: {
    modelId: 'Xenova/bge-m3',
    // WebGPU에서 q8은 정수 행렬곱이 CPU로 떨어져 500조각에 2분 넘게 걸렸다. f16 셰이더가 있으면 q4f16(약 700MB)을,
    // 없으면 원본 서버와 같은 WASM q8(약 570MB)을 쓴다.
    dtype: { webgpu: 'q4f16', wasm: 'q8' },
    pooling: 'cls',
    batchSize: 16,
  },
} as const;
