import { fileURLToPath } from "node:url";

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

// URL.pathname은 한글을 %XX로 인코딩하므로 반드시 fileURLToPath로 변환한다.
const projectPath = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

export const config = {
  dataDir: process.env.DATA_DIR ?? projectPath("data"),
  // 이번 해커톤의 Claude API 지출 한도. 넘으면 유료 호출을 멈추고 무료 대체 경로로 이어 간다.
  llmBudgetUsd: Number(process.env.LLM_BUDGET_USD ?? 100),
  port: int("PORT", 3000),
  host: process.env.HOST ?? "127.0.0.1",
  logLevel: process.env.LOG_LEVEL ?? "info",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  // 내부 메타데이터를 노출하는 확인 페이지. 프로덕션에서는 켜지지 않는다.
  viewerEnabled: process.env.NODE_ENV !== "production",

  browser: {
    maxConcurrent: int("MAX_CONCURRENT_PAGES", 2),
    maxQueued: int("MAX_QUEUED_REQUESTS", 8),
    // Playwright의 기본값은 false다. 신뢰할 수 없는 페이지를 여는 서비스이므로 켠다.
    sandbox: process.env.CHROMIUM_SANDBOX !== "false",
  },

  page: {
    totalTimeoutMs: int("PAGE_TOTAL_TIMEOUT_MS", 45_000),
    navigationTimeoutMs: int("PAGE_NAV_TIMEOUT_MS", 20_000),
    loadWaitMs: int("PAGE_LOAD_WAIT_MS", 5_000),
    scrollBudgetMs: int("PAGE_SCROLL_BUDGET_MS", 8_000),
    maxScrollScreens: int("PAGE_MAX_SCROLL_SCREENS", 30),
    settleQuietMs: 400,
    settleMaxMs: 2_500,
    frameTimeoutMs: 5_000,
    maxFrames: int("PAGE_MAX_FRAMES", 15),
    maxBytes: int("PAGE_MAX_BYTES", 50 * 1024 * 1024),
    maxRequests: int("PAGE_MAX_REQUESTS", 600),
  },

  segment: {
    // auto: 자격 증명이 있으면 LLM, 없으면 규칙. rule: 항상 규칙.
    mode: process.env.SEGMENT_MODE ?? "auto",
    model: process.env.SEGMENT_MODEL ?? "claude-opus-5-5",
    effort: process.env.SEGMENT_EFFORT ?? "low",
    minChars: int("SEGMENT_MIN_CHARS", 60),
    minPieceChars: int("SEGMENT_MIN_PIECE_CHARS", 8),
    maxSentenceChars: int("SEGMENT_MAX_SENTENCE_CHARS", 100),
    maxBatchChars: int("SEGMENT_MAX_BATCH_CHARS", 8_000),
    maxLlmCharsPerPage: int("SEGMENT_MAX_LLM_CHARS_PER_PAGE", 24_000),
    llmConcurrency: int("SEGMENT_LLM_CONCURRENCY", 3),
    batchTimeoutMs: int("SEGMENT_BATCH_TIMEOUT_MS", 30_000),
  },

  // 조각 하나를 검색어 구절로 다시 나누는 가벼운 호출. 페이지 분해와 달리 사람이 누를 때만 일어난다.
  refine: {
    model: process.env.REFINE_MODEL ?? "claude-haiku-5-5",
    effort: process.env.REFINE_EFFORT ?? "low",
    timeoutMs: int("REFINE_TIMEOUT_MS", 15_000),
    maxPhrases: int("REFINE_MAX_PHRASES", 8),
  },

  vision: {
    model: process.env.VISION_MODEL ?? "claude-opus-5-5",
    effort: process.env.VISION_EFFORT ?? "low",
    language: process.env.VISION_LANGUAGE ?? "Korean",
    // 0이면 Vision을 쓰지 않는다.
    maxPerPage: int("VISION_MAX_PER_PAGE", 12),
    batchSize: int("VISION_BATCH_SIZE", 6),
    // 512px이면 이미지당 약 340토큰이다. 작은 값이 비용을 줄이지만 세부 묘사는 약해진다.
    maxEdge: int("VISION_MAX_EDGE", 512),
    minEdge: int("VISION_MIN_EDGE", 64),
    maxImageBytes: int("VISION_MAX_IMAGE_BYTES", 15 * 1024 * 1024),
    fetchTimeoutMs: int("VISION_FETCH_TIMEOUT_MS", 8_000),
    batchTimeoutMs: int("VISION_BATCH_TIMEOUT_MS", 45_000),
    // 크기를 모르는 이미지(지연 로딩, CSS 배경)의 우선순위를 300x300으로 친다.
    unknownArea: 90_000,
  },

  embed: {
    modelId: process.env.EMBED_MODEL ?? "Xenova/bge-m3",
    dtype: process.env.EMBED_DTYPE ?? "q8",
    pooling: process.env.EMBED_POOLING ?? "cls",
    cacheDir: process.env.EMBED_CACHE_DIR ?? projectPath(".cache/models"),
    batchSize: int("EMBED_BATCH_SIZE", 32),
  },

  extract: {
    maxContents: int("EXTRACT_MAX_CONTENTS", 500),
    maxVisitedNodes: int("EXTRACT_MAX_VISITED_NODES", 150_000),
    maxTextChars: int("EXTRACT_MAX_TEXT_CHARS", 20_000),
  },
};
