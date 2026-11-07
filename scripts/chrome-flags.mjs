/** pnpm local과 E2E 테스트가 함께 쓰는 Chrome 실행 인자. */
export const CHROME_FLAGS = [
  // 서버 없이 다른 사이트의 문서·이미지·검색 결과를 읽기 위해 CORS를 끈다. 전용 프로필에서만 쓴다.
  '--disable-web-security',
  '--no-first-run',
  '--no-default-browser-check',
  // Gemini Nano(Prompt API, 이미지 입력 포함). 이미 기본으로 켜진 버전에서는 아무 영향이 없다.
  '--enable-features=PromptAPIForGeminiNano,PromptAPIForGeminiNanoMultimodalInput,OptimizationGuideOnDeviceModel:BypassPerfRequirement/true',
];
