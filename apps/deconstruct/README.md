# Deconstruct API

URL을 받아 웹페이지를 텍스트와 이미지 노드로 분해하고, 모든 노드 쌍의 의미 유사도를 돌려줍니다. 확인 페이지에서는 노드별 최근접 이웃과 임계값별 간선 수를 볼 수 있습니다.

## 실행

Node 22 이상이 필요합니다. `Promise.withResolvers`와 `--env-file-if-exists`를 사용합니다. 저장소 루트에서 실행하면 카드스택과 함께 켜지고, 환경 설정은 루트 `.env`를 씁니다.

```bash
pnpm install
```

```bash
pnpm setup:deconstruct
```

```bash
pnpm dev
```

```bash
curl "http://127.0.0.1:3001/deconstruct?url=https://example.com"
```

서버를 켠 뒤 <http://127.0.0.1:3001/> 를 열면 추출 결과를 카드로, **그래프** 탭에서 임계값에 따른 노드 연결을 볼 수 있습니다. 이미지마다 로드 성공 여부와 CORS 허용 여부(WebGL 텍스처로 쓸 수 있는지)를 실제로 시험합니다. 이 페이지와 `GET /debug/extract`는 `NODE_ENV=production`이면 등록되지 않습니다.

터미널에서 내부 메타데이터까지 보려면 추출 도구를 사용합니다. 전체 결과는 `output/`에 저장됩니다.

```bash
pnpm --filter @akl/deconstruct-api extract https://example.com
```

```bash
pnpm test:deconstruct
```

## API

`GET /deconstruct?url={url}`의 성공 응답은 프론트엔드와 합의한 `DeconstructResponse`입니다. `src/app.js`의 직렬화 스키마가 그 외 필드를 걸러 냅니다.

### `weights` 계약 (프론트엔드 요청 반영)

- **모든 쌍을 반환합니다.** 낮은 값을 버리는 임계값은 프론트엔드가 적용하므로 서버에서 Top-K나 임계값으로 자르지 않습니다.
- 값은 코사인 유사도를 아래 식으로 옮긴 0 이상 1 이하의 실수이며, 소수 넷째 자리까지 반환합니다. 코사인 0이 가중치 0.5입니다. JSON에는 정수와 실수의 구분이 없어 `0`과 `1`은 소수점 없이 직렬화됩니다.

$$
w_{ij} = \frac{1 + \cos(e_i, e_j)}{2}
$$

- 무향 그래프이므로 항상 `i < j`인 쌍만, 쌍마다 한 번씩 반환합니다. 노드가 $n$개이면 길이는 $n(n-1)/2$입니다.
- `i`, `j`는 `contents`의 0-based 인덱스입니다. 응답은 `Accept-Encoding: gzip`을 보내면 압축되며, 브라우저는 자동으로 처리합니다.

실패 응답은 `{"error": {"code", "message"}}` 형식입니다.

| code | HTTP | 상황 |
| --- | --- | --- |
| `INVALID_URL` | 400 | 파라미터 누락, 형식 오류, http(s) 외 스킴 |
| `BLOCKED_URL` | 403 | 내부 주소, 허용되지 않은 포트, 내부로 향하는 리다이렉트 |
| `UNSUPPORTED_CONTENT` | 415 | PDF, JSON 등 HTML이 아닌 응답 |
| `PAGE_TOO_LARGE` | 413 | 메인 문서가 바이트 예산 초과 |
| `EMPTY_CONTENT` | 422 | 추출할 콘텐츠 없음 (canvas 전용 페이지 등) |
| `DNS_FAILED`, `FETCH_FAILED`, `UPSTREAM_STATUS` | 502 | 대상 사이트 접속 실패, 4xx/5xx 응답 |
| `BUSY` | 503 | 동시 처리와 대기열이 모두 찬 경우 |
| `PAGE_TIMEOUT` | 504 | 제한 시간 초과 |

## 코드 위치

| 파일 | 역할 |
| --- | --- |
| `src/app.js` | Fastify 라우트, 응답 스키마, 오류 변환 |
| `src/config.js` | 환경 변수로 바꿀 수 있는 제한값 |
| `src/security/urlPolicy.js` | 허용 주소 정책, 입력 URL 검사 |
| `src/security/egressProxy.js` | 브라우저 트래픽이 지나가는 요청별 프록시, SSRF 방어, 바이트 예산 |
| `src/extract/browserManager.js` | Chromium 공유, 동시 실행 제한 |
| `src/extract/extractPage.js` | 렌더링 흐름: 이동, 스크롤, 안정화, 프레임별 수집 |
| `src/extract/inPage.js` | 브라우저 안에서 실행되는 DOM 순회 |
| `src/extract/normalize.js` | 프레임 병합, 중복 제거, 공개 스키마 변환 |
| `src/pipeline.js` | 추출, 분할 등 전체 단계 연결 |
| `src/segment/rules.js` | 토큰화, 규칙 경계, 원문 자르기 |
| `src/segment/segmentNodes.js` | 대상 선정, 배치, 캐시, 규칙 폴백 |
| `src/segment/claudeBoundaryFinder.js` | Claude 호출. 다른 LLM으로 바꿀 때 이 파일만 교체 |
| `src/graph/weights.js` | 전체 쌍 가중치 계산, 분포 요약 |
| `src/viewer/` | 개발 전용 확인 페이지 |
| `scripts/extract.js` | 터미널 확인 도구 |

노드는 내부적으로 `meta`(kind, region, alt, caption 등)를 가집니다. 의미 분할과 이미지 설명 단계에서 쓰는 값이며 API 응답에는 나가지 않습니다.

## 추출 정책

| 대상 | 처리 |
| --- | --- |
| 접힌 메뉴, 드롭다운, 아코디언, `details` | 포함. nav, header, footer와 `menu`, `dropdown`, `gnb`, `lnb` 등의 클래스 이름으로 판별 |
| 그 밖의 `display:none`, `visibility:hidden` | 제외 |
| 1px 화면 낭독기 전용 글자 | 제외 |
| 문단 속 링크 | 문단에 합침 |
| 글자 없이 나란한 링크 | 각각 분리 |
| 전체 문서의 같은 글자, 같은 이미지 URL | 하나로 합치고 `meta.occurrences`에 횟수 기록 |
| 글자나 숫자가 없는 텍스트 (`\|`, `·`) | 제외 |
| 1~2px 이미지, 깨진 이미지, `data:` URL, 스프라이트 시트 | 제외 |
| iframe | 메인 문서 뒤에 이어 붙임. 최대 개수 초과 시 메인 문서가 우선 |

## 의미 분할

링크와 버튼을 제외한 60자 초과 텍스트만 나눕니다. LLM은 토큰 번호 형식의 경계만 돌려주고 실제 자르기는 서버가 하므로, 응답에는 원문에 없는 글자가 들어갈 수 없습니다. 페이지 글에 프롬프트 인젝션이 있어도 영향은 잘못된 위치에서 끊기는 데 그칩니다.

`deconstruct/.env`에 키를 넣으면 LLM 분할이 켜집니다. 키가 없거나 호출이 실패하면 문장과 절 경계를 쓰는 규칙 분할로 이어 가며, 응답 자체는 실패하지 않습니다. 분할 방식은 확인 페이지의 배지와 경고로 알 수 있습니다.

```bash
cp .env.example .env
```

모델은 `SEGMENT_MODEL`로 바꿉니다. 조정 가능한 값은 `.env.example`과 `src/config.js`에 있습니다.

## 이미지 설명과 임베딩

이미지는 `alt`, 캡션, `aria-label`, `title`이 있으면 그 글자로 임베딩합니다. `2611_RM` 같은 관리 코드, 파일명, "image" 같은 일반 단어는 없는 것으로 취급합니다(규칙 기반 판별). 없는 이미지는 큰 것부터 페이지당 최대 12개를 서버가 내려받아 512px로 줄인 뒤 Vision으로 설명합니다. SVG, 64px 미만, 개수 제한을 넘은 이미지는 앞뒤 텍스트로 대신합니다. 한 가지 색뿐인 이미지는 노드에서 뺍니다. 이 설명은 재검색어로 쓸 수 있도록 응답의 `label`로 나갑니다. 파일명으로 근사한 경우에는 나가지 않습니다.

임베딩은 서버 안에서 돌리는 `Xenova/bge-m3`(1024차원, q8)을 씁니다. API 비용과 키가 필요 없고, 모델 파일 약 560MB를 처음 실행할 때 `.cache/models/`에 내려받습니다. Node 프로세스 메모리는 약 1.2~1.8GB입니다. 이미지 시각 정보를 직접 비교하지 않고 설명 글자로 근사합니다.

교체 지점은 `src/embed/localEmbedder.js`와 `src/describe/claudeImageDescriber.js`입니다.

## 조각 재분해

`GET /deconstruct/phrases?text=&query=`는 조각 하나를 Claude Haiku로 서로 겹치지 않는 구절로 나눕니다. 응답에서 원문에 있는 부분만 통과시키므로 페이지 글의 프롬프트 인젝션이 성공해도 나갈 수 있는 것은 원문의 일부뿐입니다. 호출 실패, 한도 초과, `SEGMENT_MODE=rule`에서는 규칙 분할로 이어 갑니다. 코드는 `src/refine/phrases.js`에 있습니다.

## 비용 한도

Claude 호출 비용을 `data/usage.json`에 누적하고 `LLM_BUDGET_USD`(기본 100달러)에 닿으면 호출을 멈춥니다. 이후에는 규칙 분할과 앞뒤 텍스트로 이어 가며 `llm-budget-exhausted` 경고를 남깁니다. 토큰 수에 문서상 가격을 곱한 추정값이고, 이미 진행 중인 호출은 막지 못해 조금 넘을 수 있습니다. 실제 청구액은 Console에서 확인하세요. `data/`를 지우면 누적액도 사라집니다.

## 알려진 한계

- 추출하지 않는 것: canvas와 WebGL 내용, 인라인 SVG 그림, `::before`의 글자, `select`의 옵션, `textarea`, `placeholder`, `aria-label`.
- 클릭해야 나오는 콘텐츠("더보기", 넘겨야 하는 슬라이드), 내부 스크롤 컨테이너의 지연 로딩은 깨우지 못합니다.
- 숨김 영역 판별은 휴리스틱입니다. 표시 전환이 `display:none`이 아닌 팝업은 포함되고, 메뉴 클래스가 없는 드롭다운은 빠집니다.
- 차단이나 CAPTCHA 페이지가 HTTP 200으로 오면 그 안내 문구가 콘텐츠로 추출됩니다. 감지하거나 우회하지 않습니다.
- closed shadow root를 읽기 위해 `attachShadow`를 패치하므로 드물게 페이지 동작이 달라질 수 있습니다.
- 스프라이트 판별은 음수 오프셋과 파일 이름으로만 합니다.

## 배포 시 주의

Playwright 공식 Docker 문서는 신뢰할 수 없는 사이트를 열 때 별도 사용자와 seccomp 프로파일을 함께 쓰도록 권장합니다. root로 실행하면 Chromium 샌드박스가 꺼집니다. 이미지 태그는 설치된 `playwright` 버전과 맞춰야 합니다.

아직 없는 것: 결과 캐시, 요청 빈도 제한, Dockerfile. Phase 5에서 추가합니다. 공개 배포 전에 `CORS_ORIGIN`을 프론트엔드 주소로 지정하세요.
