/**
 * 원래 서버가 JSON으로 돌려주던 오류를 브라우저 안에서도 같은 코드로 만든다.
 * 프론트엔드는 code만 보고 한국어 문구를 고르므로 code는 원본 API와 같아야 한다.
 */
export class LocalApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'LocalApiError';
  }
}

export const errors = {
  invalidUrl: () => new LocalApiError(400, 'INVALID_URL', 'url 쿼리 파라미터가 필요합니다.'),
  invalidText: () => new LocalApiError(400, 'INVALID_TEXT', 'text는 1~1000자여야 합니다.'),
  pageTooLarge: () => new LocalApiError(413, 'PAGE_TOO_LARGE', '페이지가 너무 큽니다.'),
  unsupportedContent: (type = '') => new LocalApiError(415, 'UNSUPPORTED_CONTENT', `웹페이지가 아닙니다. ${type}`.trim()),
  emptyContent: () => new LocalApiError(422, 'EMPTY_CONTENT', '꺼낼 콘텐츠가 없습니다.'),
  fetchFailed: () => new LocalApiError(502, 'FETCH_FAILED', '사이트에 접속하지 못했습니다.'),
  upstreamStatus: (status: number) => new LocalApiError(502, 'UPSTREAM_STATUS', `사이트 응답 ${status}`),
  embeddingFailed: () => new LocalApiError(503, 'EMBEDDING_FAILED', '임베딩 계산에 실패했습니다.'),
  busy: () => new LocalApiError(503, 'BUSY', '분해 요청이 밀려 있습니다.'),
  pageTimeout: () => new LocalApiError(504, 'PAGE_TIMEOUT', '페이지를 여는 데 시간이 너무 오래 걸렸습니다.'),
};
