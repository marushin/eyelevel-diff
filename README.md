# Art Hackathon — Card Stack (로컬 판)

검색 결과를 3D 카드로 쌓고, 고른 페이지를 조각으로 분해하는 웹 작품 [kanghohyeong/art-hackathon](https://github.com/kanghohyeong/art-hackathon)을 **서버 없이** Chrome 한 탭 안에서 돌아가게 옮긴 판입니다.

원본은 검색 API 서버(SerpApi + Claude/OpenAI), 분해 서버(Playwright + Claude + bge-m3), 원격 브라우저 미리보기 서버로 이루어져 있습니다. 이 판에서는 그 일을 모두 브라우저가 합니다. 화면 코드(`apps/web`)는 원본 그대로이고, 프론트엔드가 서버로 보내던 요청을 `window.fetch`에서 가로채 **같은 모양의 응답을 브라우저 안에서** 만듭니다.

작품 자체에 대한 설명(검색 → 카드 스택 → 미리보기 → 분해 → 다시 검색)은 원본 문서 [ORIGINAL_README.md](ORIGINAL_README.md)를 보세요.

## 실행

요구사항: Node.js 22.9 이상, pnpm(`npx pnpm@11.25.0`도 됨), Google Chrome.

**Windows에서는 `start.bat`을 더블클릭**하면 됩니다. Node.js 버전을 확인하고, 처음이면 패키지를 설치한 뒤(pnpm이 없으면 `npx`로) 아래 `pnpm local`과 같은 일을 합니다. 인자도 넘길 수 있습니다(`start.bat --preview`).

**macOS에서는 `start.command`를 더블클릭**하면 터미널이 열리고 같은 일을 합니다. 인터넷에서 받은 파일이라 처음에는 "확인되지 않은 개발자" 경고가 뜰 수 있습니다. 그때는 파일을 Control-클릭해 `열기`를 고르거나, 시스템 설정 → 개인정보 보호 및 보안에서 `그래도 열기`를 누르세요. 터미널에서 `bash start.command`로 실행해도 됩니다.

배포용 zip은 `python scripts/pack.py`로 만듭니다(`release/`에 생김). macOS에서 `start.command`의 실행 권한이 유지되도록 Unix 권한을 담아 압축합니다.

```bash
pnpm install
pnpm local          # Vite 정적 서버 + CORS를 끈 전용 Chrome 프로필로 페이지 열기
```

- `pnpm local:preview`: 빌드한 결과물(`dist/`)로 실행합니다.
- `pnpm local --no-open`: 서버만 띄웁니다.
- Chrome 경로는 `CHROME_PATH`, 프로필 위치는 `CHROME_PROFILE_DIR`, 포트는 `WEB_PORT`(기본 5173)로 바꿀 수 있습니다.

### 처음 한 번: 모델 받기

화면 왼쪽 아래 **로컬 엔진** 패널에서 상태를 확인하고, 필요한 모델을 받습니다. 모델은 전용 프로필(`.chrome-profile/`)에 저장되므로 한 번만 받으면 됩니다.

| 항목 | 용도 | 크기 | 없을 때 |
|---|---|---|---|
| 사이트 읽기 | 검색 결과·대상 페이지·이미지 읽기 | – | 검색과 분해 불가. `pnpm local`로 열었는지 확인 |
| Gemini Nano | 검색어 비틀기, 문장 경계, 구절 분해 | 수 GB (Chrome이 관리) | 방향별 대체 검색어와 규칙 분할 사용 |
| Nano 이미지 | 이미지 설명 | Nano와 같음 | alt·캡션·주변 글자 사용 |
| 번역 영→한 | Nano의 영어 출력을 한국어로 | 수십 MB | 영어 그대로 사용 |
| 임베딩 모델 | 조각 사이 의미 유사도(bge-m3) | 약 700MB(WebGPU) / 570MB(WASM) | 분해 불가. 분해할 때 자동으로 받음 |

Gemini Nano와 번역 모델은 Chrome 정책상 **버튼 클릭으로만** 받기 시작할 수 있습니다. 패널의 `받기` 버튼을 누르세요.

평소 쓰는 Chrome에 이미 Gemini Nano가 있다면(예: Prompt API 익스텐션을 써 본 경우) `pnpm local`이 처음 실행할 때 그 모델 폴더(`OptGuideOnDeviceModel`, 약 4GB)를 전용 프로필로 **복사**하므로 다시 받지 않아도 됩니다. 원본 폴더는 읽기만 합니다. 복사하지 않으려면 `pnpm local --no-copy-model`로 실행하세요.

### LLM 연결 고르기 (선택)

기본은 Chrome 내장 Gemini Nano입니다. 로컬 엔진 패널의 **LLM 연결**에서 다른 모델로 바꿀 수 있고, 고른 모델이 검색어 생성·문장 분할·이미지 설명·구절 분해를 모두 맡습니다.

| 연결 | 넣을 값 | 비용 | 참고 |
|---|---|---|---|
| Gemini Nano (기본) | 없음 | 없음 | 위 표의 모델 받기 필요 |
| Claude API | API 키, 모델(기본 `claude-opus-5-5`) | 호출마다 과금 | 공식 SDK로 브라우저에서 바로 호출. 거절 시 서버 쪽 대체 모델(`fallbacks: "default"`) 사용 |
| OpenAI API | API 키, 모델(키를 넣고 `목록` 버튼으로 고름) | 호출마다 과금 | Chat Completions + JSON 스키마 |

- `연결 테스트`로 아주 짧은 요청 하나를 보내 확인합니다(소액 과금).
- API를 쓰면 한국어로 바로 답하므로 번역 단계를 건너뛰고, 문장 분할도 원본 서버처럼 페이지당 24,000자까지 맡깁니다.
- **API 키는 기본적으로 이 탭에만** 있다가 닫으면 사라집니다. '이 기기에 API 키 기억'을 켜면 저장하지만, 분해할 때 대상 웹페이지 스크립트가 이 앱과 같은 출처에서 돌기 때문에 그 스크립트가 저장된 키를 읽을 수 있습니다. 유료 API 키는 이 작품 전용으로 만들고 콘솔에서 월 사용 한도를 걸어 두세요.

## 원본 백엔드 → 브라우저 대응

| 원본 | 하던 일 | 이 판 (`apps/web/src/local/`) |
|---|---|---|
| `GET /search` – LLM | 20가지 방향으로 검색어 생성 (Claude Opus / OpenAI) | `queries.ts`: 고른 LLM(기본 Gemini Nano, `llm.ts`) + JSON 스키마 제약. 실패하면 방향별 대체 검색어 |
| `GET /search` – SerpApi | Google 검색 결과 | `web-search.ts`: Bing 검색 결과 HTML, 안 되면 DuckDuckGo HTML |
| `GET /preview`, `/preview-ws` | 원격 Chrome(CDP)을 캔버스로 스트리밍, 프록시 | `preview.ts`: 프레임 차단 헤더를 보고 iframe 또는 스크립트를 걷어 낸 정적 사본(blob) 또는 요약 |
| `/deconstruct` – 추출 | Playwright로 렌더링 후 DOM 수집 | `deconstruct/extract.ts`: 문서를 받아 숨은 iframe(srcdoc)에 띄우고 원본 수집 함수(`in-page.js`)를 그대로 실행 |
| `/deconstruct` – 분할 | Claude가 토큰 경계 번호 선택 | `segment.ts` + `llm-finders.ts`: LLM이 경계 번호만 고르고 자르기는 원본 `rules.js` |
| `/deconstruct` – 이미지 | Claude Vision | `describe.ts`: `createImageBitmap`·OffscreenCanvas로 줄이고 LLM 이미지 입력 |
| `/deconstruct` – 임베딩 | Node의 transformers.js + bge-m3 | `embed.worker.ts`: Web Worker의 transformers.js + 같은 bge-m3 (WebGPU q4f16 → WASM q8) |
| `/deconstruct` – 그래프 | 모든 쌍 코사인 유사도 | 원본 `weights.js` 그대로 |
| `/deconstruct/phrases` | Claude Haiku | `phrases.ts`: LLM + 원본의 "원문에 있는 구절만" 검증 |
| 사용량·예산, SSRF 방어, 서버 | – | 필요 없음 (내 브라우저에서만 돌아감) |

응답 형식은 원본 API와 같으므로 프론트엔드의 파서(`search-api.ts`, `deconstruct-api.ts`, `preview-api.ts`)는 그대로 통과합니다. 오류 코드(`INVALID_URL`, `UPSTREAM_STATUS` 등)도 원본과 같습니다.

### 바뀐 점

- 원격 브라우저 미리보기가 없어 미리보기 안에서 뒤로·앞으로 이동은 안 됩니다. 정적 사본의 링크는 새 탭에서 원문으로 열립니다.
- 분해는 이 기기에서 계산합니다. 첫 실행에는 임베딩 모델을 받는 시간(약 25초)이 더해집니다. 측정값(2026-11-07, 위키백과 「고구마」 문서, 조각 499개, WebGPU, Nano 사용): 추출 3초, Nano 문장 분할 18초(호출 6번), Nano 이미지 설명 9초(2장), 임베딩 3초, **합계 33초**. Nano가 없으면 분할·이미지 단계가 빠져 약 7초입니다.
- Nano 문장 분할은 페이지당 6,000자까지만 맡기고(긴 글부터), 나머지는 원본의 규칙 분할을 씁니다. 원본은 24,000자였습니다.
- 분해 제한 시간을 165초에서 600초로 늘렸고, 로딩 화면에 지금 하는 단계를 보여 줍니다.
- Prompt API가 받는 언어(Chrome 156 기준 de, en, es, fr, ja)에 한국어가 없어 영어로 선언하고, 한국어가 필요한 출력은 Translator API로 옮깁니다.

## 주의

- **전용 프로필은 CORS(`--disable-web-security`)를 끈 상태입니다.** 서버 없이 다른 사이트를 읽기 위한 설정이므로 이 창에서는 다른 사이트에 로그인하지 마세요. 평소 쓰는 Chrome 프로필과는 완전히 분리되어 있습니다.
- 분해할 때 대상 페이지의 스크립트가 이 앱과 같은 출처의 숨은 iframe에서 돕니다. sandbox로 최상위 이동·팝업·대화상자는 막지만, 로컬 개인 용도를 전제로 한 구조입니다.
- 검색 결과는 Bing/DuckDuckGo 결과 페이지를 읽어 얻습니다. 페이지 구조가 바뀌면 파서(`web-search.ts`)를 고쳐야 합니다.
- Gemini Nano는 원본이 쓰던 모델보다 훨씬 작아 검색어가 "점점 멀어지는" 흐름이 약할 수 있습니다. 더 나은 결과가 필요하면 LLM 연결을 Claude나 OpenAI API로 바꾸세요.
- Claude·OpenAI 연결은 실제 키로 호출해 보지 않았습니다. 요청 모양은 가짜 응답으로, 실제 서버 접속과 잘못된 키 처리는 가짜 키(401)로 확인했습니다.

## 구조

```
apps/web/                  카드 스택과 분해 화면 (원본)
  src/local/               브라우저 안 백엔드
    install.ts             fetch 가로채기: /search, /deconstruct, /deconstruct/phrases, /preview
    llm.ts                 LLM 연결 고르기: Gemini Nano / Claude(SDK) / OpenAI
    llm-settings-panel.ts  패널의 LLM 연결 설정 화면
    nano.ts                Gemini Nano(Prompt API) 래퍼: 세션 복제, 직렬 큐, JSON 스키마
    translate.ts           Translator API(영→한)
    queries.ts, directions.ts, web-search.ts, preview.ts, remote-fetch.ts
    status-panel.ts        로컬 엔진 진단 패널
    deconstruct/           추출 · 분할 · 이미지 · 임베딩 · 그래프 · 구절
packages/graph-contract/   그래프 계약과 시뮬레이터 (원본)
packages/lab-kit/          실험 패널과 공용 도구 (원본)
scripts/local.mjs          실행기,  scripts/chrome-flags.mjs  Chrome 인자
tests/e2e-local.mjs        실제 Chrome으로 하는 끝단 검증
```

## 검사

```bash
pnpm check        # TypeScript
pnpm test         # 단위·통합 테스트 (vitest)
pnpm test:e2e     # 실제 Chrome + 네트워크로 /search, /preview, /deconstruct, /phrases, 화면 흐름 확인
                  #   --headed 창 띄우기, --download-nano 모델 받기까지, E2E_ONLY=이름 일부 단계만
                  #   LLM 연결 화면은 가짜 OpenAI 서버로 확인(실제 키·요금 없음)
```

## 출처

원본: [kanghohyeong/art-hackathon](https://github.com/kanghohyeong/art-hackathon) (2026 오픈 프롬프트 커뮤니티 예술 해커톤). `deconstruct/in-page.js`, `normalize.js`, `rules.js`, `weights.js`는 원본 `apps/deconstruct`에서 그대로 가져왔고, 나머지 `local/` 모듈은 원본 서버 코드를 브라우저용으로 옮긴 것입니다.
