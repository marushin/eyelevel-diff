/** 클라이언트에 그대로 보여 줘도 되는 오류. 내부 정보는 message에 넣지 않는다. */
export class AppError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const errors = {
  invalidUrl: (why) => new AppError("INVALID_URL", 400, `올바르지 않은 URL입니다: ${why}`),
  blockedUrl: () => new AppError("BLOCKED_URL", 403, "접근이 허용되지 않은 주소입니다."),
  dnsFailed: () => new AppError("DNS_FAILED", 502, "도메인을 찾을 수 없습니다."),
  fetchFailed: () => new AppError("FETCH_FAILED", 502, "페이지에 연결하지 못했습니다."),
  upstreamStatus: (status) => new AppError("UPSTREAM_STATUS", 502, `페이지가 HTTP ${status}을(를) 반환했습니다.`),
  pageTimeout: () => new AppError("PAGE_TIMEOUT", 504, "페이지 로딩 시간이 초과되었습니다."),
  unsupportedContent: (type) => new AppError("UNSUPPORTED_CONTENT", 415, `HTML 페이지가 아닙니다: ${type}`),
  pageTooLarge: () => new AppError("PAGE_TOO_LARGE", 413, "페이지 크기가 제한을 초과했습니다."),
  emptyContent: () => new AppError("EMPTY_CONTENT", 422, "페이지에서 추출할 수 있는 콘텐츠가 없습니다."),
  embeddingFailed: () => new AppError("EMBEDDING_FAILED", 503, "콘텐츠 임베딩을 계산하지 못했습니다."),
  busy: () => new AppError("BUSY", 503, "요청이 많습니다. 잠시 후 다시 시도해 주세요."),
};
