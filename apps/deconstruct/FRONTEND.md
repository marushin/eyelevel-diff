# 프론트엔드 연동 가이드

URL을 넣으면 웹페이지를 텍스트와 이미지 노드로 분해하고, 모든 노드 쌍의 의미 유사도를 돌려주는 API입니다.

## 실행

Node 22 이상이 필요합니다. 저장소 루트에서 실행하세요.

```bash
pnpm install
```

```bash
pnpm setup:deconstruct
```

```bash
pnpm dev
```

`pnpm dev`가 이 서버를 `http://127.0.0.1:3001`에 함께 띄우고, 화면은 같은 주소의 `/deconstruct` 프록시로 호출합니다. 포트는 `DECONSTRUCT_PORT`로 바꾸고, `DECONSTRUCT_ENABLED=false`면 띄우지 않습니다.

**첫 실행 때 임베딩 모델 약 560MB를 내려받습니다.** 네트워크에 따라 몇 분 걸리고, 그동안 첫 요청이 대기합니다. Node 프로세스는 메모리를 1.2~1.8GB 사용합니다.

### API 키와 비용

키는 저장소 루트 `.env`의 `ANTHROPIC_API_KEY`를 함께 씁니다. `.env`는 다른 사람에게 전달하거나 git에 올리지 마세요.

- `/deconstruct`를 호출할 때마다 페이지당 약 $0.01~0.05가 듭니다. 이미지 설명은 파일에 캐시되고, 의미 분할 캐시는 서버를 끄면 사라집니다.
- 지출 한도(기본 $100)는 **실행하는 컴퓨터별로** `apps/deconstruct/data/usage.json`에 따로 기록됩니다. 다른 컴퓨터의 사용액과 `/search`의 LLM 비용은 합산되지 않습니다.
- 화면 작업만 할 때는 비용이 들지 않게 LLM을 끌 수 있습니다. 루트 `.env`에 아래 두 줄을 넣고 서버를 재시작하세요. 분할 품질은 낮아지지만 응답 형식은 같습니다.

```text
SEGMENT_MODE=rule
VISION_MAX_PER_PAGE=0
```

## 결과를 눈으로 보기

<http://127.0.0.1:3001/> 에 개발용 확인 페이지가 있습니다. URL을 넣으면 노드 카드, 힘 기반 **그래프**, 임계값별 간선 수, 실제 API 응답을 볼 수 있습니다. 코드는 `src/viewer/graph.js`를 참고하세요.

## API

```http
GET /deconstruct?url={URL 인코딩된 주소}&query={검색어, 선택, 최대 200자}
```

```typescript
type ContentType = { type: "text" | "img"; content: string; label?: string };
type WeightType = [number, number, number]; // [i, j, weight]
type DeconstructResponse = { contents: ContentType[]; weights: WeightType[]; querySimilarities?: number[] };

const res = await fetch(`http://127.0.0.1:3000/deconstruct?url=${encodeURIComponent(url)}`);
const body = await res.json();
if (!res.ok) throw new Error(body.error.code);
```

CORS는 기본으로 모든 출처를 허용하고, 응답은 gzip으로 압축되며 브라우저가 자동으로 풉니다.

## `weights` 규칙

- 모든 쌍을 반환합니다. **임계값은 프론트에서 적용합니다.**
- `i < j`인 쌍만 한 번씩 있습니다. 노드가 $n$개이면 길이는 $n(n-1)/2$입니다. 노드 500개면 124,750개입니다.
- `i`, `j`는 `contents`의 0-based 인덱스입니다.
- 값은 소수 넷째 자리까지의 0~1 실수입니다. `0`과 `1`은 JSON에서 소수점 없이 나옵니다.

$$
w_{ij} = \frac{1 + \cos(e_i, e_j)}{2}
$$

### 임계값 정하기

실제 코사인이 대부분 양수라서 값은 0~1 전체가 아니라 **약 0.53~1에 모입니다.** 3개 사이트 실측 분포입니다.

| 사이트 | 최소 | 중앙값 | 상위 10% | 상위 1% | 0.80 이상 간선 비율 |
| --- | --- | --- | --- | --- | --- |
| 국립현대미술관 | 0.56 | 0.69 | 0.74 | 0.82 | 1.6% |
| 네이버 | 0.53 | 0.67 | 0.73 | 0.80 | 1.0% |
| 위키백과 | 0.55 | 0.68 | 0.75 | 0.84 | 3.2% |

- **0.8 부근에서 시작하세요.** 0.5처럼 낮추면 거의 모든 선이 남습니다.
- 선 굵기나 투명도는 0~1 그대로 쓰면 차이가 잘 보이지 않습니다. 임계값~1 구간을 다시 펼쳐 매핑하세요.
- 분포가 사이트마다 다르므로, 고정값 대신 응답 값의 상위 1%처럼 백분위로 정하는 방법도 있습니다.

## 검색어 유사도와 이미지 라벨

- `query`를 넘기면 `querySimilarities`가 함께 옵니다. `contents`와 순서와 길이가 같고, 값은 `weights`와 같은 $(1 + \cos) / 2$ 척도의 0~1 실수입니다. 임베딩은 서버 안에서 계산하므로 추가 비용이 없습니다.
- 이미지는 픽셀이 아니라 설명 글자로 비교합니다. 값도 설명 글자의 유사도입니다.
- 이미지의 `label`은 임베딩에 쓴 설명(alt, 캡션, Vision 또는 앞뒤 글자)입니다. 파일명으로 근사한 이미지에는 없습니다.

## 조각 재분해

```http
GET /deconstruct/phrases?text={조각 글, 최대 1000자}&query={검색어, 선택}
```

```typescript
type PhraseResult = { phrases: string[]; source: "llm" | "rule"; querySimilarities?: number[] };
```

조각 하나를 원문 순서대로 서로 겹치지 않는 구절로 나눕니다. `query`를 넘기면 구절별 검색어 유사도가 `/deconstruct`와 같은 척도로 함께 옵니다. `REFINE_MODEL`(기본 `claude-haiku-5-5`)을 쓰고 비용은 `LLM_BUDGET_USD` 한도에 합산됩니다. 원문에 없는 구절은 버립니다. LLM을 쓸 수 없으면 `source: "rule"`로 문장 부호와 낱말 기준으로 나누며, 이 경우에도 응답은 실패하지 않습니다.

## 오류

실패하면 `{ "error": { "code", "message" } }`를 반환합니다.

| code | HTTP | 상황 |
| --- | --- | --- |
| `INVALID_URL` | 400 | 파라미터 누락, 형식 오류 |
| `INVALID_TEXT` | 400 | `/deconstruct/phrases`의 `text` 누락, 1000자 초과 |
| `BLOCKED_URL` | 403 | 내부 주소, 허용되지 않은 포트 |
| `PAGE_TOO_LARGE` | 413 | 페이지가 크기 제한 초과 |
| `UNSUPPORTED_CONTENT` | 415 | PDF 등 HTML이 아닌 응답 |
| `EMPTY_CONTENT` | 422 | 추출할 콘텐츠 없음 |
| `DNS_FAILED`, `FETCH_FAILED`, `UPSTREAM_STATUS` | 502 | 대상 사이트 접속 실패, 4xx/5xx 응답 |
| `BUSY`, `EMBEDDING_FAILED` | 503 | 요청 과다, 임베딩 실패 |
| `PAGE_TIMEOUT` | 504 | 시간 초과 |

## 화면을 만들 때 주의할 점

- **응답 시간:** 8~21초 걸렸고, 노드가 많으면 더 걸릴 수 있습니다. 아직 결과 캐시가 없어 같은 URL도 매번 다시 처리하므로 로딩 화면이 필요합니다.
- **결과 변동:** 광고와 동적 콘텐츠 때문에 같은 URL도 노드 수가 달라집니다.
- **노드 수:** 페이지당 최대 500개입니다. 많은 노드와 간선을 DOM으로 그리면 느릴 수 있어 Canvas나 WebGL을 권합니다.
- **이미지 CORS:** `<img>`로 표시하는 데는 문제가 없었지만, **WebGL 텍스처로 쓰면 막히는 사이트가 많습니다.** CORS 허용 비율은 위키백과 19/19, 애플 12/25, 네이버 42/101, 국립현대미술관 0/34였습니다. 텍스처가 필요하면 백엔드에 이미지 프록시를 요청하세요.
- **외부 글자:** `content`는 외부 사이트의 글입니다. HTML로 삽입하지 말고 텍스트로 출력하세요.

## 아직 남은 일

- 결과 캐시, 요청 빈도 제한, 서버 배포
- 설명 없는 이미지가 나란히 있으면 앞뒤 글자가 같아 가중치가 근거 없이 1이 되는 문제
- 접혀 있는 메뉴(예: 네이버 블로그의 숨은 사전 메뉴)가 노드로 나오는 문제
- 웹페이지 속 링크 따라가기: 응답에 링크 주소가 없어 스키마 추가를 합의해야 합니다
