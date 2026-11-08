# eyelevel-diff — Art Hackathon Card Stack, 서버 없는 로컬 판

검색 결과를 3D 카드로 쌓고, 고른 페이지를 조각으로 분해하는 웹 작품 [kanghohyeong/art-hackathon](https://github.com/kanghohyeong/art-hackathon)을 **백엔드 서버 없이 Chrome 한 탭 안에서** 돌아가게 바꾼 판입니다.

원본은 서버 세 개(검색 API, 분해 서버, 원격 브라우저 미리보기)와 유료 API 키(SerpApi, Claude 또는 OpenAI)가 있어야 돌아갑니다. 이 판은 그 일을 모두 브라우저가 합니다. 기본 LLM은 **Chrome 내장 Gemini Nano**라 키도 요금도 필요 없고, 원하면 Claude나 OpenAI API로 바꿀 수 있습니다.

작품 자체에 대한 설명(검색 → 카드 스택 → 미리보기 → 분해 → 다시 검색)은 원본 문서 [ORIGINAL_README.md](ORIGINAL_README.md)를 보세요.

---

## ⚠️ 최소 실행 사양

**아무 PC에서나 돌아가지 않습니다.** 기본 경로인 Gemini Nano는 Chrome이 정한 하드웨어 조건을 넘어야 받을 수 있고, 분해는 이 기기에서 임베딩 모델(bge-m3)을 직접 돌립니다. 실행하기 전에 아래 표를 확인하세요.

| 항목 | 기본 (Gemini Nano) | Claude·OpenAI API만 쓸 때 |
|---|---|---|
| 기기 | **데스크톱만.** Windows 10/11, macOS 13(Ventura) 이상, Linux, ChromeOS(Chromebook Plus) | 데스크톱 (Windows, macOS, Linux) |
| 휴대폰·태블릿 | **불가** (Android·iOS Chrome에는 Nano·번역기가 없음) | 불가 (전용 Chrome 프로필을 띄울 수 없음) |
| 브라우저 | 데스크톱 **Google Chrome**. 2026-11 기준 Chrome 156에서 확인. Edge·Firefox·Safari 불가 | 같음 |
| GPU 또는 CPU | **VRAM 4GB 초과 GPU**, 또는 GPU가 없으면 **RAM 16GB 이상 + CPU 4코어 이상** | 제한 없음. 다만 분해의 임베딩 계산이 GPU(WebGPU)에서 훨씬 빠름 |
| 저장 공간 | **Chrome 프로필이 있는 드라이브에 22GB 이상 여유.** Nano 모델 약 4GB, 임베딩 모델 약 0.6~0.7GB가 이 프로젝트 폴더의 `.chrome-profile/`에 쌓임. 여유가 10GB 아래로 내려가면 Chrome이 Nano를 지움 | 약 1GB (임베딩 모델) |
| 네트워크 | 모델을 처음 받을 때 **데이터 무제한 연결** 필요. 검색·분해할 때도 인터넷 필요 | 인터넷 필요 |
| 실행 도구 | **Node.js 22.9 이상** (pnpm은 없어도 됨) | 같음 |
| 비용 | 없음 | API 호출마다 과금 (유료 키 필요) |

- 하드웨어 조건 출처: [Chrome 내장 AI 시작하기](https://developer.chrome.com/docs/ai/get-started) (GPU VRAM "strictly more than 4 GB", CPU "16 GB of RAM or more and 4 CPU cores or more", 저장 공간 "at least 22 GB").
- 조건에 못 미치면 패널의 Gemini Nano 줄이 "이 기기에서 사용 불가"로 나옵니다. 그래도 화면은 돌아가지만 검색어는 미리 준비한 대체 검색어로, 분해는 규칙 분할로 대신합니다. 제대로 쓰려면 Claude나 OpenAI API를 연결하세요.
- 확인한 환경: Windows 11 Pro, AMD Ryzen 9 3950X(16코어), RAM 64GB, NVIDIA RTX 5090, Chrome 156.0.8078.81, Node.js 24.

---

## 원본과 무엇이 다른가

### 한눈에

| | 원본 (art-hackathon) | 이 판 (eyelevel-diff) |
|---|---|---|
| 실행 구성 | 웹 + 검색 API 서버 + 분해 서버(Playwright) + 원격 브라우저 서버 | **웹 페이지 하나** (Vite가 정적 파일만 내줌) |
| 필요한 키 | SerpApi, Claude 또는 OpenAI (필수) | **없음** (Claude·OpenAI는 선택) |
| 검색어 재해석 LLM | Claude Opus 또는 OpenAI | **Gemini Nano (기본)** / Claude / OpenAI 중 선택 |
| 웹 검색 | SerpApi(Google) | Bing 검색 결과 페이지를 직접 읽음, 실패하면 DuckDuckGo |
| 페이지 분해 | 서버의 Playwright Chrome | 같은 탭의 숨은 iframe |
| 이미지 설명·문장 분할·구절 분해 | Claude | 고른 LLM (기본 Nano) |
| 임베딩 (bge-m3) | 서버의 Node transformers.js | 브라우저 Web Worker의 transformers.js (WebGPU 우선) |
| 미리보기 | 원격 Chrome 화면을 스트리밍 (뒤로·앞으로 가능) | iframe, 또는 스크립트를 걷어 낸 정적 사본, 또는 요약 |
| 다른 사이트 읽기 | 서버가 대신 받음 | **CORS를 끈 전용 Chrome 프로필**로 직접 받음 |
| 한국어 검색 | Claude가 한국어로 답함 | Nano는 한국어를 못 하므로 **번역을 거침** (아래 참조) |

### 동작 방식

프론트엔드(`apps/web`의 화면 코드)는 원본 그대로입니다. 원본 프론트엔드는 `/search`, `/deconstruct`, `/deconstruct/phrases`, `/preview`로 서버에 요청을 보냅니다. 이 판은 `window.fetch`를 가로채 **같은 모양의 응답과 같은 오류 코드**(`INVALID_URL`, `UPSTREAM_STATUS` 등)를 브라우저 안에서 만들어 돌려줍니다. 그래서 원본의 응답 파서(`search-api.ts`, `deconstruct-api.ts`, `preview-api.ts`)를 고치지 않고 그대로 통과합니다.

### 원본 백엔드 → 브라우저 대응

| 원본 | 하던 일 | 이 판 (`apps/web/src/local/`) |
|---|---|---|
| `GET /search` – LLM | 20가지 방향으로 검색어 재해석 (Claude Opus / OpenAI) | `queries.ts`: 고른 LLM(`llm.ts`) + JSON 스키마. 한국어는 한국어로만 내보내고, 실패하거나 모자라면 방향별 한국어 대체 검색어 |
| `GET /search` – SerpApi | Google 검색 결과 | `web-search.ts`: Bing 결과 HTML, 실패하면 DuckDuckGo HTML |
| `GET /preview`, `/preview-ws` | 원격 Chrome(CDP)을 캔버스로 스트리밍, 프록시 | `preview.ts`: 프레임 차단 헤더(X-Frame-Options, CSP)를 보고 iframe / 스크립트를 걷어 낸 정적 사본(blob) / 요약 |
| `/deconstruct` – 추출 | Playwright로 렌더링 후 DOM 수집 | `deconstruct/extract.ts`: 문서를 받아 숨은 iframe(srcdoc)에 띄우고 원본 수집 함수(`in-page.js`)를 그대로 실행 |
| `/deconstruct` – 분할 | Claude가 토큰 경계 번호 선택 | `segment.ts` + `llm-finders.ts`: LLM이 경계 번호만 고르고, 자르기는 원본 `rules.js` |
| `/deconstruct` – 이미지 | Claude Vision | `describe.ts`: `createImageBitmap`·OffscreenCanvas로 줄여 LLM에 이미지 입력 |
| `/deconstruct` – 임베딩 | Node의 transformers.js + bge-m3 | `embed.worker.ts`: Web Worker의 transformers.js + 같은 bge-m3 (WebGPU q4f16, 안 되면 WASM q8) |
| `/deconstruct` – 그래프 | 모든 쌍 코사인 유사도 | 원본 `weights.js` 그대로 |
| `/deconstruct/phrases` | Claude Haiku | `phrases.ts`: LLM + 원본의 "원문에 있는 구절만" 검증 |
| 사용량·예산 제한, SSRF 방어 | 공개 서버용 | 필요 없음 (내 브라우저에서만 돌아감) |

### 지운 것

- `apps/api` (검색 API 서버), `apps/deconstruct` (분해 서버), 원격 브라우저 미리보기 서버와 `remote-browser-client.ts`
- 서버 실행 스크립트(`scripts/dev|start|config|deconstruct.mjs`), `.env.example`, 서버 대상 테스트

### 더한 것

- `apps/web/src/local/`: 브라우저 안 백엔드 전체
- 로컬 엔진 패널(화면 왼쪽 아래): 사이트 읽기 가능 여부, Nano·번역·임베딩 모델 상태와 받기 버튼, LLM 연결 선택
- 실행기: `scripts/local.mjs`(`pnpm local`), `start.bat`(Windows), `start.command`(macOS)
- 평소 Chrome에 받아 둔 Gemini Nano 모델을 전용 프로필로 복사하는 기능 (4GB를 다시 받지 않게)
- 배포용 zip 만들기: `scripts/pack.py`
- 실제 Chrome으로 하는 끝단 검사: `tests/e2e-local.mjs`

### 동작이 달라진 점

- 미리보기 안에서 뒤로·앞으로 이동은 안 됩니다. 정적 사본의 링크는 새 탭에서 원문으로 열립니다.
- 분해 제한 시간을 165초에서 600초로 늘렸고, 로딩 화면에 지금 하는 단계를 보여 줍니다.
- Nano로 문장을 나눌 때는 페이지당 6,000자까지만 맡기고(긴 글부터) 나머지는 원본의 규칙 분할을 씁니다. Claude·OpenAI는 원본처럼 24,000자까지 맡깁니다.
- 검색 결과가 Google(SerpApi)이 아니라 Bing이라 결과 구성이 다릅니다.

---

## 실행

**Windows:** `start.bat`을 더블클릭하세요. Node.js 버전을 확인하고, 처음이면 패키지를 설치한 뒤(pnpm이 없으면 `npx`로) 전용 Chrome 창을 엽니다.

**macOS:** `start.command`를 더블클릭하세요. 인터넷에서 받은 파일이라 처음에는 "확인되지 않은 개발자" 경고가 뜰 수 있습니다. 그때는 파일을 Control-클릭해 `열기`를 고르거나, 시스템 설정 → 개인정보 보호 및 보안에서 `그래도 열기`를 누르세요. 터미널에서 `bash start.command`로 실행해도 됩니다.

**직접 실행:**

```bash
pnpm install        # 또는 npx pnpm@11.25.0 install
pnpm local          # Vite 정적 서버 + CORS를 끈 전용 Chrome 프로필로 페이지 열기
```

- `pnpm local:preview`: 빌드한 결과물(`dist/`)로 실행합니다.
- `pnpm local --no-open`: 서버만 띄웁니다.
- `pnpm local --no-copy-model`: 평소 Chrome의 Nano 모델을 복사하지 않습니다.
- Chrome 경로는 `CHROME_PATH`, 프로필 위치는 `CHROME_PROFILE_DIR`, 포트는 `WEB_PORT`(기본 5173)로 바꿀 수 있습니다.
- 서버를 띄운 검은 창(터미널)을 닫으면 서버도 꺼집니다.

### 처음 한 번: 모델 받기

화면 왼쪽 아래 **로컬 엔진** 패널에서 상태를 보고, 필요한 모델을 받습니다. 모델은 전용 프로필(`.chrome-profile/`)에 저장되므로 한 번만 받으면 됩니다.

| 항목 | 용도 | 크기 | 없을 때 |
|---|---|---|---|
| 사이트 읽기 | 검색 결과·대상 페이지·이미지 읽기 | – | 검색과 분해 불가. `start.bat`이나 `pnpm local`로 열었는지 확인 |
| Gemini Nano | 검색어 재해석, 문장 경계, 구절 분해 | 약 4GB (Chrome이 관리) | 방향별 대체 검색어와 규칙 분할 사용 |
| Nano 이미지 | 이미지 설명 | Nano와 같음 | 페이지의 alt·캡션·주변 글자 사용 |
| 번역 한↔영 | **Nano로 한국어 검색할 때 필수** (아래 참조) | 수십 MB | 한국어 검색어는 대체 검색어, 이미지는 alt 문구 사용 |
| 임베딩 모델 | 조각 사이 의미 유사도(bge-m3) | 약 700MB(WebGPU) / 570MB(WASM) | 분해 불가. 처음 분해할 때 자동으로 받음 |

- Gemini Nano와 번역 모델은 Chrome 정책상 **버튼 클릭으로만** 받기 시작할 수 있습니다. 패널의 `받기` 버튼을 누르세요.
- 평소 쓰는 Chrome에 이미 Gemini Nano가 있다면, `pnpm local`이 처음 실행될 때 그 모델 폴더(`OptGuideOnDeviceModel`, 약 4GB)를 전용 프로필로 **복사**합니다. 그러면 다시 받지 않아도 됩니다. 예를 들어 Prompt API를 쓰는 익스텐션을 써 봤다면 이미 받아져 있습니다. 원본 폴더는 읽기만 합니다.

---

## Gemini Nano로 한국어 검색하기: 반드시 번역을 거칩니다

Gemini Nano(Chrome Prompt API)는 **한국어 입출력을 지원하지 않습니다.** Chrome 156 기준 지원 언어는 영어·스페인어·일본어·독일어·프랑스어뿐이고, 세션을 한국어로 열면 거절됩니다. 그래서 처음에는 "원래 검색어와 같은 언어로 답하라"고 지시했는데, 「고구마」 검색에 `土器`, `炭焼き` 같은 일본어 검색어가 섞여 나왔습니다.

한국어 검색어는 한국어로 이어져야 하므로, Nano로 한국어 검색을 할 때는 **Chrome 내장 번역기(Translator API)를 앞뒤로 거칩니다.**

```
한국어 검색어 「고구마」 + 재해석 방향(한국어 문장)
   │  ① 한→영 번역 (번역기가 있으면. 없으면 한국어 원문을 그대로 넘김)
   ▼
"sweet potato" + 영어 방향
   │  ② Gemini Nano에게 "검색어를 영어로" 생성 지시
   ▼
pottery / charcoal / bone tools / excavation
   │  ③ 영→한 번역 (필수)
   ▼
토기 / 숯 / 골각기 / 발굴 조사
   │  ④ 검사: 한글이 없거나 일본어 가나가 섞인 검색어는 버림 → 모자란 개수는 그 방향의 한국어 대체 검색어로 채움
   ▼
웹 검색
```

- **영→한 번역기가 없으면** Nano로는 한국어 검색어를 만들 수 없으므로 Nano를 부르지 않고 **한국어 대체 검색어**(재해석 방향마다 4개씩 미리 준비)를 씁니다. 패널의 `번역 한↔영` 줄이 "한국어 검색에 필요"로 표시되면 `받기`를 누르세요.
- **이미지 설명**도 같은 경로입니다. Nano에게 영어로 설명하게 한 뒤 영→한으로 옮깁니다. 번역기가 없으면 Nano 이미지 설명을 건너뛰고 페이지의 alt·캡션을 씁니다. 이미지 설명은 그 이미지를 눌렀을 때 다시 검색하는 검색어로도 쓰이기 때문입니다.
- **문장 분할과 구절 분해**는 번역하지 않습니다. 이 둘은 원문의 위치(토큰 번호)나 원문에 실제로 있는 부분 문자열만 받아들이므로, 결과는 항상 원문 언어 그대로입니다.
- 검색 로그(개발자 도구 콘솔의 `[local] 재해석 검색어(...)`)에 어떤 경로를 탔는지 나옵니다.
  - `gemini-nano+translate`: 위 번역 경로를 탔습니다.
  - `+fallback`: 일부를 대체 검색어로 채웠습니다.
  - `fallback`: 전부 대체 검색어입니다.
- 번역은 기계 번역이라 어색할 때가 있습니다(예: "pipeline" → "석유 따위의 관로").
- **Claude·OpenAI API**는 한국어로 바로 답하므로 번역을 거치지 않습니다. ④번 검사(한글만 통과)는 똑같이 적용합니다.

---

## LLM 연결 고르기 (선택)

기본은 Chrome 내장 Gemini Nano입니다. 로컬 엔진 패널의 **LLM 연결**에서 바꿀 수 있고, 고른 모델이 검색어 재해석·문장 분할·이미지 설명·구절 분해를 모두 맡습니다.

| 연결 | 넣을 값 | 비용 | 참고 |
|---|---|---|---|
| Gemini Nano (기본) | 없음 | 없음 | 위의 최소 사양과 모델 받기 필요. 한국어는 번역 경로 |
| Claude API | API 키, 모델(기본 `claude-opus-5-5`) | 호출마다 과금 | 공식 SDK로 브라우저에서 바로 호출. 안전 분류기가 거절하면 서버 쪽 대체 모델(`fallbacks: "default"`)로 다시 돌림 |
| OpenAI API | API 키, 모델(키를 넣고 `목록` 버튼으로 고름) | 호출마다 과금 | Chat Completions + JSON 스키마 |

- `연결 테스트`는 아주 짧은 요청 하나를 보내 확인합니다(소액 과금).
- **API 키는 기본적으로 지금 탭에만** 있다가 탭을 닫으면 사라집니다.
- '이 기기에 API 키 기억'을 켜면 키를 저장합니다. 다만 분해할 때 대상 웹페이지의 스크립트가 이 앱과 같은 출처에서 돌기 때문에, 그 스크립트가 저장된 키를 읽을 수 있습니다.
- 유료 API 키는 이 작품 전용으로 만들고, 콘솔에서 월 사용 한도를 걸어 두세요.
- Claude 구독(Pro·Max)과 API는 따로 결제됩니다. API는 콘솔(console.anthropic.com)에서 크레딧을 충전해야 호출됩니다.

---

## 측정값

2026-11-08, 위키백과 「고구마」 문서(조각 499개), 위 확인 환경 기준입니다.

| 단계 | Gemini Nano |
|---|---|
| 검색 한 번 (재해석 검색어 4개 생성·번역 + 웹 검색 5번) | 약 13초 |
| 분해 전체 | 33~40초 |
| └ 추출 | 3초 |
| └ Nano 문장 분할 (호출 6번) | 18초 |
| └ Nano 이미지 설명 (2장) | 9초 |
| └ 임베딩 (WebGPU) | 3초 |

- 처음 분해할 때는 임베딩 모델을 받는 시간(약 25초)이 더해집니다.
- Nano가 없으면 분할·이미지 단계가 빠져 분해가 약 7초로 줄지만, 문장이 규칙으로만 잘립니다.

---

## 주의

- **전용 프로필은 CORS(`--disable-web-security`)를 끈 상태입니다.** 서버 없이 다른 사이트를 읽기 위한 설정입니다. 이 창에서는 다른 사이트에 로그인하지 마세요. 평소 쓰는 Chrome 프로필과는 완전히 분리되어 있습니다.
- 분해할 때 대상 페이지의 스크립트가 이 앱과 같은 출처의 숨은 iframe에서 돕니다. sandbox로 최상위 이동·팝업·대화상자는 막지만, 혼자 로컬에서 쓰는 것을 전제로 한 구조입니다.
- 검색 결과는 Bing·DuckDuckGo 결과 페이지를 직접 읽어 얻습니다. 두 사이트의 페이지 구조가 바뀌면 파서(`web-search.ts`)를 고쳐야 합니다.
- Gemini Nano는 원본이 쓰던 모델보다 훨씬 작아서, 검색어가 "점점 멀어지는" 흐름이 약할 수 있습니다. 더 나은 결과가 필요하면 Claude나 OpenAI API로 바꾸세요.
- Claude·OpenAI 연결은 실제 유효한 키로는 호출해 보지 않았습니다.
  - 요청 모양은 가짜 응답으로 검사했습니다.
  - 실제 서버 접속과 잘못된 키 처리는 가짜 키(401 응답)로 확인했습니다.

---

## 구조

```
apps/web/                  카드 스택과 분해 화면 (원본)
  src/local/               브라우저 안 백엔드 (이 판에서 더함)
    install.ts             fetch 가로채기: /search, /deconstruct, /deconstruct/phrases, /preview
    llm.ts                 LLM 연결: Gemini Nano / Claude(공식 SDK) / OpenAI
    llm-settings-panel.ts  패널의 LLM 연결 설정 화면
    nano.ts                Gemini Nano(Prompt API) 래퍼: 세션 복제, 직렬 큐, JSON 스키마
    translate.ts           Translator API: 한→영(선택), 영→한(Nano 한국어 경로 필수)
    queries.ts             검색어 재해석 + 한국어 경로 + 대체 검색어
    directions.ts, web-search.ts, preview.ts, remote-fetch.ts
    status-panel.ts        로컬 엔진 패널
    deconstruct/           추출 · 분할 · 이미지 · 임베딩 · 그래프 · 구절
packages/graph-contract/   그래프 계약과 시뮬레이터 (원본)
packages/lab-kit/          실험 패널과 공용 도구 (원본)
scripts/local.mjs          실행기,  scripts/chrome-flags.mjs  Chrome 인자,  scripts/pack.py  배포 zip
start.bat, start.command   Windows·macOS 더블클릭 실행
tests/e2e-local.mjs        실제 Chrome으로 하는 끝단 검사
```

## 검사

```bash
pnpm check        # TypeScript
pnpm test         # 단위·통합 테스트 (vitest)
pnpm test:e2e     # 실제 Chrome + 네트워크로 /search, /preview, /deconstruct, /phrases, LLM 연결, 화면 흐름 확인
                  #   --profile 전용 프로필(받아 둔 Nano 사용), --headed 창 띄우기,
                  #   --download-nano 모델 받기까지, E2E_ONLY=이름 일부 단계만
                  #   LLM 연결 화면은 가짜 OpenAI 서버로 확인(실제 키·요금 없음)
```

## 출처와 라이선스

- 원본: [kanghohyeong/art-hackathon](https://github.com/kanghohyeong/art-hackathon) (2026 오픈 프롬프트 커뮤니티 예술 해커톤). 첫 커밋(`48915db`)이 원본 저장소의 main을 그대로 가져온 것이고 그 뒤 커밋들이 이 판의 변경입니다. 원본과의 전체 차이는 `git diff 48915db HEAD`로 볼 수 있습니다.
- `deconstruct/in-page.js`, `normalize.js`, `rules.js`, `weights.js`는 원본 `apps/deconstruct`에서 그대로 가져왔습니다. 나머지 `local/` 모듈은 원본 서버 코드를 브라우저용으로 옮겨 쓴 것입니다.
- 원본 저장소에는 라이선스 파일이 없습니다. 원본 코드와 작품의 권리는 원작자에게 있습니다.
