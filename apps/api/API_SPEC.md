# HTTP API 명세

## 공통 사항

- 요청 방식: `GET`
- 응답 형식: `application/json`
- 쿼리 파라미터의 값은 URL 인코딩하여 전달한다.
- `/search`는 이 서버가, `/deconstruct`는 `apps/deconstruct` 서버가 처리한다. `pnpm start`와 개발 서버가 `/deconstruct`를 프록시하며, 프록시 없이 단독으로 띄운 검색 서버에서는 `404`를 반환한다.
- `/search`는 별도 인증이 없다. 서버 기동에는 `SERPAPI_API_KEY`와 선택한 LLM 공급자의 API 키가 필요하다.
- `LLM_PROVIDER`는 `anthropic`(기본값) 또는 `openai`다. 생략·공백이면 Claude를 사용하며 다른 값은 서버 기동 오류다.
- Claude 선택 시 `ANTHROPIC_API_KEY`가 필요하며 `ANTHROPIC_MODEL`의 기본값은 `claude-opus-5-5`다.
- OpenAI 선택 시 `OPENAI_API_KEY`가 필요하며 `OPENAI_MODEL`의 기본값은 `gpt-6.1-sol`이다.
- 모델 설정 생략·공백 시 해당 공급자의 기본 모델을 사용한다. 선택하지 않은 공급자의 키·모델 설정은 무시한다. 공급자·키·모델은 서버 설정이며 클라이언트 쿼리 파라미터로 받지 않는다.

## 1. 검색

```http
GET /search?query={query}&awesomeDirection={direction}&awesomeQueryCount=10&awesomeCount=3&goodCount=30
```

원문 Google 검색 결과를 `good`으로 반환한다. 선택한 LLM이 원문과 재해석 방향으로 새로운 검색어를 생성한다. 1위는 원문과 비교적 가까운 새로운 관점으로 시작하고, 뒤로 갈수록 멀어져 마지막은 거의 다른 주제에 도달하도록 구성한다. 각 생성 검색어의 Google 상위 결과는 `awesome`에 검색어별로 반환한다.

### 요청 파라미터

| 이름 | 위치 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- | --- |
| `query` | query | string | 예 | 원문 검색어. 앞뒤 공백을 제거하며 누락·빈 문자열은 `400` |
| `awesomeDirection` | query | string | 아니오 | LLM 재해석 방향. 앞뒤 공백을 제거하며 생략·공백이면 준비된 20개 방향 중 요청마다 하나를 무작위 선택 |
| `awesomeQueryCount` | query | integer | 아니오 | 생성할 검색어 수. 기본값 `10`, 범위 `0~20` |
| `awesomeCount` | query | integer | 아니오 | 생성 검색어 **하나당** 최대 문서 수. 기본값 `3`, 범위 `0~100` |
| `goodCount` | query | integer | 아니오 | 원문 검색의 최대 문서 수. 기본값 `30`, 범위 `0~100` |

재해석 방향을 생략하거나 공백으로 전달하면 생물의 적응, 과거의 관습, 미래의 부재, 인과 역전, 오작동, 감각 전환, 미시·거시 규모, 폐기물, 기반시설, 권력, 교환, 위장, 의례, 우연, 경계, 리듬, 기억, 물질 변형, 주변부 등 20개 방향 중 하나를 요청마다 같은 확률로 무작위 선택한다. 직접 지정한 방향은 앞뒤 공백만 제거해 그대로 사용한다. 무작위 선택이므로 같은 방향이 연속으로 선택될 수 있다.

개수는 10진수 숫자로만 입력한다. 빈 값, 음수, 소수, 범위 밖 값, 공백·문자·지수 표기는 `400`으로 처리하며 LLM과 SerpApi를 호출하지 않는다. 각 파라미터의 기본값은 독립적으로 적용한다.

`awesomeQueryCount=0` 또는 `awesomeCount=0`이면 검색어 생성과 awesome 검색을 생략하고 `awesome: {}`를 반환한다. `goodCount`도 `0`이면 외부 호출 없이 `{ "good": [], "awesome": {} }`를 반환한다.

### 응답 구조와 호환성 변경

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `good` | `RESULT_TYPE[]` | 원문 Google 상위 결과, 최대 `goodCount`개 |
| `awesome` | `Record<string, AWESOME_GROUP>` | 생성 검색어를 키로 하는 객체. 생성 완료 시 요청한 검색어를 모두 포함 |

`awesome`은 기존 배열에서 객체로 바뀌었다. `awesomeCount`는 전체 awesome 결과 수에서 **검색어 하나당 결과 수**로 바뀌었고 기본값은 `30`에서 `3`으로 바뀌었다. 기존 무작위 페이지 탐색은 제거했다.

예를 들어 `awesomeQueryCount=5&awesomeCount=3`이면 검색어 5개를 생성하고, 각 검색어에 최대 3개씩 전체 최대 15개 문서를 반환한다.

### AWESOME_GROUP과 두 종류의 순위

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `rank` | integer | **검색어 순위**. 원문에서 점진적으로 멀어지는 탐색 순서로 `1~N`. 서버가 LLM 반환 배열 순서대로 부여 |
| `results` | `RESULT_TYPE[]` | 해당 검색어의 Google 검색 결과. 결과가 없으면 `[]` |

검색어 순위는 LLM이 구성한 탐색 거리의 상대 순위다. 1위는 원문과 비교적 가까우면서도 새로운 관점이고, 중간 순위는 개념적 거리를 점점 넓히며, 마지막은 희미한 연상만 남긴 거의 다른 주제를 목표로 한다. 문서 품질이나 수치화된 유사도 점수가 아니며, 검색어 순위에는 중복이나 누락이 없다. `awesome[검색어].rank`와 `awesome[검색어].results[i].rank`는 독립적이다. 클라이언트는 객체 키 순서 대신 명시적인 검색어 `rank`를 기준으로 정렬할 수 있다.

### LLM 검색어 생성 정책

- 원문 상위 검색과 LLM 검색어 생성을 병렬로 시작한다. 생성이 완료되면 모든 생성 검색어를 SerpApi로 검색한다.
- 요청당 선택된 공급자를 한 번 호출한다. Claude는 Messages API의 구조화된 출력, OpenAI는 Responses API의 Structured Outputs를 사용한다. 입력은 원문, 재해석 방향, 검색어 수이며 `{ "queries": string[] }`을 받는다.
- 각 검색어는 단어 또는 짧은 명사구로 생성하며 보통 1~4어절을 목표로 한다. 완전한 문장·질문·설명·관계절 대신 핵심 개념명이나 최소한의 검색 키워드로 압축한다. 이는 생성 지침이며 어절 수를 서버에서 강제로 제한하지 않는다.
- 대담하고 뜻밖의 발견을 우선한다. 재해석 방향은 탐색의 출발점이며, 모든 검색어를 원래 주제 안에 묶어두는 경계로 사용하지 않는다.
- 검색어 전체가 원문에서 점진적으로 멀어지도록 구성한다. 첫 검색어부터 단순한 바꿔 쓰기를 넘어 새로운 관점을 제시하고, 다음 검색어마다 눈에 띄는 도약을 하며, 마지막은 거의 다른 주제를 목표로 한다.
- 중간 검색어는 분야·메커니즘·재료·스케일·시대·전제를 바꾸거나 뜻밖의 유추와 역전을 활용한다. 뒤쪽 검색어는 원문 단어·개체·의도·분야를 유지할 필요가 없지만 희미하고 뜻밖의 연상 연결은 남긴다.
- 추상적인 말장난이나 구호보다 구체적으로 검색 가능한 개념·현상·재료·방법·사례를 우선한다. 검색어를 1개만 요청하면 대담하고 뜻밖의 도약을 우선한다.
- 의미가 비교적 가까운 검색어부터 거의 다른 주제까지 순서대로 반환하도록 지시한다. 서버는 이 순서를 유지해 `1`부터 순위를 부여한다. 임베딩이나 별도의 평가 호출은 사용하지 않는다.
- 검색어 언어를 원문 언어로 고정하지 않는다.
- 공백 제거 후 검색어 수가 요청과 정확히 같아야 하고, 빈 검색어·중복 검색어·원문과 같은 검색어가 있으면 실패로 처리한다.
- 생성 실패나 유효하지 않은 응답은 `502`다. 자동 재생성이나 다른 공급자·기존 탐색으로 대체하지 않는다. 수집한 문서를 LLM으로 재평가하거나 재정렬하지 않는다.

### 검색 및 수집 정책

- Google 검색은 SerpApi를 사용한다. 한국어·한국 설정(`hl=ko`, `gl=kr`)을 적용한다. 첫 페이지에는 `start`를 보내지 않으며, 이후에는 `start=(페이지-1)*10`을 사용한다.
- `good`은 원문으로 첫 페이지부터 순차 수집하며 최대 상위 `ceil(goodCount/10)`페이지를 조회한다. 기본값에서는 최대 1~3페이지다.
- 각 생성 검색어는 첫 페이지부터 순차 수집하며 최대 상위 `ceil(awesomeCount/10)`페이지를 조회한다. 기본값에서는 검색어마다 1페이지다. 문서가 더 필요할 때만 다음 페이지를 요청하며, 요청 개수를 채우거나 빈 페이지를 만나면 중단한다. 각 배열은 요청 개수까지 제한하며, 개수가 부족해도 이 페이지 범위 밖으로 보충하지 않는다.
- SerpApi 동시 요청은 good과 awesome을 합쳐 최대 5개다. 각 배열은 페이지 순서대로 합치고, 페이지 내부는 SerpApi 응답 순서를 유지한다. 완료 순서에 따라 검색어·문서 순위가 바뀌지 않는다.
- 각 페이지의 전체 `organic_results`를 수집 대상으로 사용하며 페이지당 10개로 제한하지 않는다.
- URL 문자열이 같은 항목은 각 문서 배열 내부에서만 한 번 반환한다. 서로 다른 awesome 검색어와 good 사이에는 같은 URL을 허용한다. URL이 없거나 공백인 항목은 제외한다.
- `title`, `description`, `image`가 누락되거나 문자열이 아니면 빈 문자열로 반환한다. 개별 웹사이트를 방문해 이미지를 추출하지 않는다.
- 문서 중복 제거 후에도 원래 문서 순위를 다시 매기지 않는다. 검색어의 결과가 비어도 검색어와 검색어 순위를 유지한다.
- 클라이언트 페이지네이션과 별도 캐시는 제공하지 않는다. 검색어의 단어를 유지하는 Verbatim 모드(`tbs=li:1`)를 사용하고, `no_cache=true`로 이전 응답을 재사용하지 않고 새 결과를 요청한다. 페이지네이션 링크를 따라 탐색하지 않는다.

### 호출 한도와 시간 초과

| 조건 | 처리 |
| --- | --- |
| 일반 요청 | LLM 최대 1회. SerpApi 최대 `ceil(goodCount/10) + awesomeQueryCount * ceil(awesomeCount/10)`회 |
| 기본값 | LLM 1회, SerpApi 최대 13회. good 최대 30개, awesome은 검색어 10개에 최대 3개씩 |
| 모든 개수의 최댓값 | LLM 1회, SerpApi 최대 210회. good 최대 100개, awesome 최대 2,000개 |
| awesome 비활성화 | LLM·awesome 검색 생략. good에 필요한 SerpApi 호출만 수행 |
| 전체 요청 120초 경과 | 진행 중인 LLM·SerpApi 요청과 대기 중인 검색을 취소하고 완료된 페이지의 결과를 `200`으로 반환 |

시간 제한은 LLM 호출을 포함한다. 검색어 생성 전에 중단되면 `awesome: {}`를 반환하고, 생성 후라면 모든 검색어의 순위와 수집된 문서 배열을 반환한다. 완료된 good·awesome 페이지는 페이지 순서대로 수집하며 아직 완료되지 않은 페이지의 결과는 포함하지 않는다. 시간 초과 응답은 요청한 문서 수보다 적거나 빈 배열일 수 있다.

### RESULT_TYPE

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `url` | string | SerpApi `link`: 결과 페이지 URL |
| `title` | string | SerpApi `title`: 제목. 없으면 `""` |
| `description` | string | SerpApi `snippet`: 설명. 없으면 `""` |
| `image` | string | SerpApi `thumbnail`: 이미지 URL. 없으면 `""` |
| `rank` | integer | **문서 순위**. 해당 검색어에서 1부터 시작하는 Google 순위: `(페이지-1)*10 + position`. `position`이 양의 정수가 아니면 페이지 내 배열 순서(1부터)를 사용 |

### 응답 예시

아래는 `awesomeQueryCount=2` 요청의 예시이며, 가독성을 위해 문서 수는 축약했다. 첫 검색어의 순위는 `1`이고 그 안의 문서는 Google 순위 `2`다.

```json
{
  "good": [
    {
      "url": "https://example.com/interactive-art",
      "title": "인터랙티브 아트 소개",
      "description": "관객 참여로 변화하는 작품",
      "image": "",
      "rank": 1
    }
  ],
  "awesome": {
    "키네틱 아트": {
      "rank": 1,
      "results": [
        {
          "url": "https://example.com/movement-installation",
          "title": "움직임에 반응하는 설치",
          "description": "관객의 움직임을 작품의 재료로 활용한다",
          "image": "",
          "rank": 2
        }
      ]
    },
    "점균 경로탐색": {
      "rank": 2,
      "results": [
        {
          "url": "https://example.com/slime-mold-pathfinding",
          "title": "점균의 경로 형성 실험",
          "description": "영양분의 분포에 따라 변화하는 점균의 이동 경로",
          "image": "",
          "rank": 1
        }
      ]
    }
  }
}
```

### 오류 응답

오류는 `{ "error": "설명" }` 형식의 JSON으로 반환한다.

| HTTP 상태 | 조건 | `error` |
| --- | --- | --- |
| `400` | 검색어 누락 또는 공백만 입력 | `query is required` |
| `400` | `goodCount`가 유효한 0~100 정수가 아님 | `goodCount must be an integer from 0 to 100` |
| `400` | `awesomeCount`가 유효한 0~100 정수가 아님 | `awesomeCount must be an integer from 0 to 100` |
| `400` | `awesomeQueryCount`가 유효한 0~20 정수가 아님 | `awesomeQueryCount must be an integer from 0 to 20` |
| `404` | 미지원 경로 | `Not found` |
| `405` | `/search`에 GET 이외 메서드 사용 | `Method not allowed` (`Allow: GET` 헤더 포함) |
| `502` | 선택된 LLM 호출 실패, 거절·미완료·잘못된 응답 또는 검색어 검증 실패 | `LLM query generation failed` |
| `502` | SerpApi HTTP·인증·검색 오류, 통신 실패, 잘못된 JSON·응답 구조 | `SerpApi search failed` |

SerpApi가 정상 빈 결과(`search_metadata.status: "Success"`, `organic_results_state: "Fully empty"`, `error: "Google hasn't returned any results for this query."`)를 반환하면 `502`로 처리하지 않고 빈 페이지로 취급한다. 실제 외부 오류는 일부 수집 결과 대신 `502`를 반환하며 다른 진행 중인 호출을 취소한다. 외부 오류 메시지나 API 키를 노출하지 않는다.

## 2. 콘텐츠 분해

```http
GET /deconstruct?url={url}&query={query}
```

대상 URL의 콘텐츠를 텍스트와 이미지로 분해하고, 콘텐츠 간 가중치를 반환한다. 가중치와 오류 코드의 상세 규칙은 [분해 API 연동 가이드](../deconstruct/FRONTEND.md)를 따른다.

### 요청 파라미터

| 이름 | 위치 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- | --- |
| `url` | query | string | 예 | 분해할 페이지 URL |
| `query` | query | string | 아니오 | 유사도를 계산할 검색어. 최대 200자 |

### 응답 구조

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `contents` | `CONTENT_TYPE[]` | 분해된 콘텐츠 목록 |
| `weights` | `WEIGHT_TYPE[]` | 콘텐츠 쌍의 가중치 목록 |
| `querySimilarities` | `number[]` | `query`가 있을 때만 포함. `contents`와 같은 순서의 검색어 유사도(0~1) |

### CONTENT_TYPE

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `type` | `"text" \| "img"` | 콘텐츠 종류 |
| `content` | string | `text`이면 어구, `img`이면 이미지 URL |
| `label` | string | `img`의 설명 글자. 파일명으로 근사한 이미지에는 없음 |

### WEIGHT_TYPE

`WEIGHT_TYPE`은 다음 순서의 값 3개를 담은 배열(튜플)이다.

```text
[CONTENT_IDX_1, CONTENT_IDX_2, WEIGHT]
```

| 위치 | 이름 | 타입 | 설명 |
| --- | --- | --- | --- |
| 0 | `CONTENT_IDX_1` | integer | 첫 번째 콘텐츠의 `contents` 배열 인덱스 |
| 1 | `CONTENT_IDX_2` | integer | 두 번째 콘텐츠의 `contents` 배열 인덱스 |
| 2 | `WEIGHT` | number | 두 콘텐츠 사이의 가중치 |

콘텐츠 인덱스는 `0`부터 시작한다고 가정한다. 예를 들어 `[0, 1, 0.8]`은 `contents[0]`과 `contents[1]` 사이의 가중치가 `0.8`임을 나타낸다. 값은 0~1 실수이며, 모든 쌍을 인덱스가 작은 쪽을 앞에 두어 한 번씩 반환한다.

### 응답 예시

```json
{
  "contents": [
    {
      "type": "text",
      "content": "새로운 영감을 발견하세요"
    },
    {
      "type": "img",
      "content": "https://example.com/images/hero.jpg"
    },
    {
      "type": "text",
      "content": "아이디어를 작품으로 연결합니다"
    }
  ],
  "weights": [
    [0, 1, 0.8],
    [0, 2, 0.6]
  ]
}
```

### 조각 재분해

```http
GET /deconstruct/phrases?text={text}&query={query}
```

조각 글(최대 1000자)을 구절로 나눈다. 응답은 `{ "phrases": string[], "source": "llm" | "rule", "querySimilarities"?: number[] }`이며, 구절은 원문 순서대로 서로 겹치지 않는 원문의 일부다. `querySimilarities`는 `query`가 있을 때만 포함한다.

## 콘텐츠 분해의 작성 가정 및 미정 사항

### 작성 가정

- `/deconstruct`는 `GET` 메서드를 사용하고 JSON을 반환한다.
- `url` 요청 파라미터는 필수다.
- URL과 텍스트 필드는 문자열, `WEIGHT`는 숫자로 표현한다.
- `CONTENT_IDX_1`, `CONTENT_IDX_2`는 0부터 시작하는 정수 인덱스다.

### 미정 사항

- `/deconstruct`의 인증 방식과 요청 빈도 제한
