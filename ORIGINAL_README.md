# Art Hackathon — Card Stack

### 검색 결과를 3D 카드로 쌓고, 고른 페이지를 조각으로 분해하는 웹 작품

**검색어 하나가 카드 스택이 되고, 고른 페이지는 조각이 되고, 고른 조각은 다시 검색어가 됩니다.**

<img src="docs/readme/demo_search.webp" width="100%" alt="실제 앱 화면 녹화: 검색어 칸에 미디어 아트를 입력 → 말이 달리는 로딩 화면 → 파란 aligned 탭 카드와 주황 01~04 skewed 탭 카드 18장이 3D 공간에 하나씩 나타나고 빨간 화살표로 이어짐, 오른쪽에 기울어진 history 띠 → 전체를 보여 준 뒤 휠로 확대하자 카드 제목과 탭 글자가 읽힘">

<sub>실제 화면 · 실제 검색(미디어 아트), 카드 18장 · 입력 구간은 크게 잘라 냄 · 대기 5.3초를 약 1초로 줄이고 카드 등장은 2.2배속 · 끝의 확대는 같은 화면을 이어 녹화 · 커서는 녹화용으로 덧그림</sub>

<img src="docs/readme/at_a_glance.png" width="100%" alt="검색어 하나에서 다시 검색까지 다섯 단계: 1 검색어(한 줄을 입력한다) → 2 카드 스택(그대로 찾은 결과와 비틀어 찾은 결과) → 3 원문 미리보기(카드를 고르면 실제 페이지가 그 자리에서 열린다) → 4 분해(페이지가 글과 이미지 조각으로 흩어진다) → 5 다시 검색(고른 조각이 새 검색어가 된다). 5에서 1로 돌아가는 빨간 선에 새 검색으로 처음부터, 이전 카드는 지워진다고 적혀 있음. 고양이와 분해 그림의 단어는 예시">

<sub>2026 오픈 프롬프트 커뮤니티 예술 해커톤 · 주제: 휴먼 인 더 루프(Human in the Loop), AI의 답에 인간의 질문을 더하기 · 2026년 11월 5–7일, 아트코리아랩 6층 아고라</sub>

[1 검색](#1-검색-한-검색어-두-갈래) · [2 카드 스택](#2-카드-스택) · [3 미리보기](#3-원문-미리보기) · [4 분해](#4-분해) · [5 보기](#5-세-가지-보기) · [6 조각](#6-조각-다루기) · [7 계산](#7-계산) · [8 구조와 API](#8-구조와-api) · [9 실행](#9-실행) · [10 한계와 문서](#10-한계와-문서) · [11 작업 과정](#11-작업-과정)

---

## 1. 검색: 한 검색어, 두 갈래

<img src="docs/readme/motion_concept.webp" width="100%" alt="설명용 모션: 고양이를 입력하면 파란 aligned 카드가 쌓임(검색어 그대로, Google 상위 결과) → LLM이 만든 새 검색어 넷(톡소포자충 행동 조작, 고양이 Fel d 1 알레르겐 단백질, 삼색 고양이 X염색체 불활성화, 비타민 B12 리보스위치)이 가까이에서 멀리로 놓이고 각각 01~04 skewed 주황 카드가 붙으며 빨간 화살표가 그려짐 → 카드 하나를 고르면 되돌아가기, 분해, 검색 이어가기 버튼이 나오고 그 제목으로 검색을 이어감 → 고른 카드에서 굵은 검은 선이 새 스택으로 이어지고, 지나온 카드는 그대로 남음">

<sub>설명용 모션 · 코드로 그린 개념도이며 실제 화면이 아님 · 검색어와 제목은 녹화된 고양이 검색 응답 예시에서 옮김 · good 10장 중 5장만 그리고, 좌우로 퍼지는 awesome 카드를 한 축에 모아 단순화</sub>

<img src="docs/readme/search_counts.png" width="100%" alt="한 번의 검색이 부르는 것: good 줄은 검색어 그대로 Google 검색(goodCount=10), 파란 탭 카드 10장, 카드 표시 aligned. awesome 줄은 LLM이 새 검색어 4개를 만들고 각각 Google 검색(awesomeQueryCount=4, awesomeCount=2), 01부터 04 skewed까지 주황이 옅어지는 카드 2장씩, 01은 비교적 가깝지만 새로운 각도, 04는 거의 다른 주제. 합계: 카드 최대 18장(10 + 4 × 2), LLM 호출 1번, SerpApi 호출 최대 5번(1 + 4)">

<sub>awesome 1–4순위는 LLM이 정한 탐색 순서입니다. 측정한 점수가 아니고, Google 문서 순위와도 별개입니다.</sub>

<details>
<summary>검색 동작 자세히</summary>

- good은 입력한 검색어 그대로의 Google 결과입니다.
- awesome은 LLM이 검색어와 재해석 방향으로 새 검색어를 만들고, 그 검색어로 다시 찾은 결과입니다. 재해석 방향은 준비된 20개 중 요청마다 하나를 무작위로 고릅니다.
- 실제 `GET /search`를 사용합니다. 검색마다 유료 외부 API를 호출합니다.
- SerpApi 설정은 `hl=ko`, `gl=kr`, `tbs=li:1`(Verbatim), `no_cache=true`이고, 동시 요청은 최대 5개입니다.
- good과 검색어 생성은 병렬로 시작합니다. 검색어 생성은 한 번만 호출하며, 실패하면 502를 돌려주고 재시도나 다른 공급자로 대체하지 않습니다.
- LLM 기본 공급자는 Anthropic(`claude-opus-5-5`)이고, `LLM_PROVIDER=openai`이면 OpenAI(`gpt-6.1-sol`)를 씁니다.
- 순위는 두 가지입니다. `awesome[검색어].rank`는 검색어 순위이고, `results[i].rank`는 Google 문서 순위 $(page-1) \cdot 10 + position$ 입니다.
- 새 검색이나 화면 종료 때 이전 요청을 취소하며, 서버도 연결이 끊어진 요청의 외부 작업을 취소합니다.
- 서버 시간 제한은 120초이고, 그때까지 모인 부분 결과를 200으로 돌려줍니다. 클라이언트 제한은 122초입니다.
- 오류, 빈 결과, 부분 결과를 그대로 표시하고 목데이터로 대체하지 않습니다. 화면 문구는 `검색 API 오류 (N)`, 검색 요청이 중단되었습니다. 다시 검색해주세요., 검색 결과가 없습니다 입니다.

</details>

## 2. 카드 스택

<img src="docs/readme/overview_callouts.png" width="100%" alt="실제 앱 화면에 번호를 붙인 그림: 미디어 아트 검색 결과를 휠로 확대한 모습. 1 파란 탭 aligned는 good 결과이고 대각선 줄기를 이룸. 2 주황 탭 01–04 skewed는 awesome 결과이고 숫자는 검색어 순위. 3 빨간 화살표는 good에서 awesome으로 그린 규칙이며 실제 하이퍼링크가 아님. 4 오른쪽 history 띠에 나타난 카드가 최신순으로 쌓이고 누르면 그 카드의 미리보기가 열림. 5 삼각형은 검색어 기록을 열고, 누르면 그 스택으로 카메라만 옮김. 6 왼쪽 아래 둥근 버튼은 모두 지우고 첫 화면으로 돌아감. 7 왼쪽 위 범례는 검색어 연관 1–4순위">

<sub>실제 화면에 번호를 덧붙임 · 실제 검색(미디어 아트)</sub>

<details>
<summary>조작, 검색 이어가기, 검색어 기록</summary>

**조작**: 드래그는 이동, 휠은 확대, 빈 곳 더블클릭은 전체 보기, 포커스된 카드에서 Enter는 선택입니다. history 띠는 휠이나 드래그로 넘깁니다. 카드는 850 ms 간격으로 하나씩 나타나고, 카메라가 최신 카드를 따라간 뒤 마지막에 전체를 보여 줍니다. 카드에는 제목, URL, 설명만 있고 이미지는 그리지 않습니다.

**검색 이어가기**: 카드를 고르면 되돌아가기, 분해, 검색 이어가기 버튼이 나옵니다. 검색 이어가기는 그 카드의 제목(없으면 도메인)을 새 검색어로 씁니다. 기존 카드, 위치, 히스토리는 그대로 두고 새 스택을 붙입니다. [설명용 모션](#1-검색-한-검색어-두-갈래)의 끝부분이 이 동작입니다.

**검색어 기록**: 검색과 이어가기마다 기록이 한 줄씩 늘어납니다. 기록을 누르면 새로 검색하지 않고 그 스택으로 카메라만 옮깁니다. 기록과 히스토리는 메모리에만 있어 새로고침하면 사라지고, 새 최초 검색을 하면 이전 기록과 카드가 지워집니다.

</details>

## 3. 원문 미리보기

<img src="docs/readme/demo_preview.webp" width="100%" alt="실제 앱 화면 녹화: 위키백과 미디어 아트 카드를 고르면 스택 위에 실제 페이지가 열림 → 휠로 스크롤 → 본문의 포스트모더니즘 링크를 눌러 창 안에서 이동하고 주소 줄이 바뀜 → 왼쪽 화살표로 뒤로 돌아감 → 되돌아가기로 전체 스택으로 복귀">

<sub>실제 화면 · 실제 원격 브라우저 · 서버의 Chrome 화면을 캔버스로 받고 입력을 그대로 보냄 · 이미 주소가 풀린 카드를 다시 연 장면이며, 첫 프레임 전 0.5초의 검은 화면과 대기 구간을 잘라냄 · 1.15배속</sub>

<details>
<summary>미리보기 동작 자세히</summary>

- 서버의 시스템 Chrome 화면을 앱 안 캔버스로 받아 그리고, 마우스, 휠, 키 입력을 그대로 보냅니다. 새 탭으로 열리는 링크(`target="_blank"`, `window.open`)와 오른쪽 히스토리 클릭도 이 창 안에서 이동합니다.
- 기본 경로는 WebSocket `/preview-ws?url&w&h&dpr`입니다. 시스템 Chrome(`--headless=new`, `CHROME_BIN` 또는 알려진 경로)을 CDP로 움직이고, `Page.startScreencast`의 JPEG(품질 82)를 캔버스에 그립니다.
- 세션은 최대 6개이고, 넘으면 가장 오래된 세션을 닫습니다. 캔버스는 너비 320–1920, 높이 240–1200, dpr 1–2로 제한합니다.
- 첫 프레임 전에 WebSocket이 실패하거나(`ws_error`, `ws_closed_before_frame`, `invalid_ws_url`) 서버가 오류를 보내면(`browser_unavailable`, `unsafe_url`, `missing_url`) `GET /preview?mode=inspect&url=`로 넘어갑니다. 서버에 Chrome이 없을 때가 `browser_unavailable`입니다. 결과는 셋 중 하나입니다.
  - `iframe`: 직접 임베드. YouTube 임베드 포함. sandbox는 `allow-scripts allow-same-origin allow-forms`
  - `proxy`: `/preview?url=`로 정리한 HTML. CSP `script-src 'none'`, sandbox `allow-same-origin`, 512 KB 제한, 보이는 글자 120자 이상 필요
  - `fallback`: 앱 안 요약 카드 "앱 내 문서 요약 보기". 사유는 `http_N`, `non_html`, `client_only_shell`, `upstream_unreachable`
- Google 리다이렉트 URL(`/goto`, `/url`)을 풀고, `assertSafePublicUrl`로 SSRF를 검사합니다.
- 미리보기 바깥을 누르면 닫힙니다. 분해 중에는 닫지 않습니다.

</details>

## 4. 분해

<img src="docs/readme/demo_deconstruct.webp" width="100%" alt="실제 앱 화면 녹화: 위키백과 미디어 아트 카드를 열고 분해를 누름 → 흐려진 미리보기 위로 말 로딩 화면과 취소 버튼 → 조각 500개가 읽는 순서의 세로 단으로 퍼짐 → 저절로 상호 유사도 배치로 다시 모임 → 휠로 확대하자 글자가 읽힘">

<sub>실제 화면 · 실제 분해 응답 · 첫 유료 요청 장면(대기 18.4초를 약 2초로 줄임)과 같은 페이지의 캐시 재진입 장면을 로딩이 끝나는 순간에 이어 붙임 · 페이지가 그려지기 전 검은 프레임을 빼고, 조각이 자리 잡는 3.3초는 3배속</sub>

<img src="docs/readme/motion_deconstruct.webp" width="100%" alt="설명용 모션: 예시 페이지에서 글과 이미지를 꺼냄 → 의미 단위로 나눔 → 조각마다 1024차원 벡터 → 모든 쌍의 유사도를 잼(조각 15개면 105쌍) → 같은 조각이 유사도로 다시 모이고 빨간 선이 이어짐 → 검색어 고양이와 가까울수록 진하고 크게 → 문장을 구절로 더 잘게 분해 → 조립하면 원래 페이지로">

<sub>설명용 모션 · 코드로 그린 개념도이며 실제 화면이 아님 · 예시 페이지와 유사도 값은 지어낸 것이고, 식과 상수(1024차원, 0.14, 0.72)만 실제 코드 값</sub>

<details>
<summary>분해 동작, 기준 검색어, 오류</summary>

- 처음에는 읽는 순서로 0.5초에 걸쳐 퍼지고, 2.2초 뒤 저절로 상호 유사도로 바뀝니다. 그 전에 조각을 드래그하거나 누르면 바뀌지 않습니다. 움직임 줄이기 설정이면 바로 상호 유사도로 엽니다.
- 조각은 사각형 없이 글자와 이미지만 표시합니다. 입력한 검색어와 비슷할수록 진하고 큽니다. 계산은 [7절](#7-계산)에 있습니다.
- 대기 중에는 취소할 수 있습니다. 같은 URL과 검색어는 새로고침 전까지 최근 8개를 다시 요청하지 않습니다.
- 페이지당 약 0.01–0.05달러, 보통 8–21초가 듭니다(문서 기록).
- 조립 버튼이나 Esc는 조각을 가운데로 모아 같은 미리보기로 돌아갑니다. 페이지를 다시 불러오지 않습니다. 조각을 선택한 상태의 Esc는 선택만 해제합니다.

기준 검색어는 입력한 검색어이거나, 마지막으로 이어간 검색어이거나, 검색어 기록에서 옮겨 간 검색어입니다. awesome 카드에서도 LLM이 만든 검색어가 아니라 이 검색어를 씁니다. 눌러 본 카드의 스택을 따라가지 않으며, 200자로 잘라 보냅니다.

오류는 버튼 옆에 한국어로 표시하고 미리보기는 그대로 둡니다. 응답 형식은 `{error:{code,message}}`입니다.

| 상태 | 코드 |
| --- | --- |
| 400 | `INVALID_URL`, `INVALID_TEXT` |
| 403 | `BLOCKED_URL` |
| 405 | `METHOD_NOT_ALLOWED`(프록시) |
| 413 | `PAGE_TOO_LARGE` |
| 415 | `UNSUPPORTED_CONTENT` |
| 422 | `EMPTY_CONTENT` |
| 500 | `INTERNAL` |
| 502 | `DNS_FAILED`, `FETCH_FAILED`, `UPSTREAM_STATUS`, `DECONSTRUCT_UNAVAILABLE`(프록시) |
| 503 | `BUSY`, `EMBEDDING_FAILED` |
| 504 | `PAGE_TIMEOUT` |

</details>

## 5. 세 가지 보기

<img src="docs/readme/views_matrix.png" width="100%" alt="세 가지 보기를 2D와 3D로 놓은 표, 칸마다 실제 화면. 읽는 순서: 2D 세로 단(문서 순서대로 단을 따라), 3D 나선(같은 순서로 감겨 내려감). 상호 유사도: 2D 스프링(가까운 4개와 당겨져 모임), 3D 구름(같은 인력을 3차원으로). 검색어 유사도: 2D 궤도(가운데에 가까울수록 비슷함), 3D 구체(가운데까지 거리가 곧 유사도). 3D 버튼은 지금 보기를 오른쪽 칸으로 바꿈">

<sub>실제 화면, 위키백과 미디어 아트 페이지의 조각 500개 · 칸마다 연결 상위 값이 다름</sub>

<img src="docs/readme/demo_views_flat.webp" width="100%" alt="실제 앱 화면 녹화: 읽는 순서의 세로 단 → 상호 유사도 버튼을 눌러 조각이 다시 모임 → 연결 상위 슬라이더를 0.5%로 끌자 빨간 선이 나타남 → 검색어 유사도, 가운데 붉은 검색어. 왼쪽 아래에 지금 보기의 이름표">

<img src="docs/readme/demo_views_3d.webp" width="100%" alt="실제 앱 화면 녹화: 3D 버튼을 눌러 3D 나선이 천천히 돎 → 3D 구름 → 3D 구체. 왼쪽 아래에 지금 보기의 이름표">

<sub>실제 화면 · 실제 분해 응답 · 왼쪽 아래 이름표는 녹화용으로 덧붙임 · 위 1.5배속, 아래 1.3배속 · 커서가 조각을 지날 때의 강조는 녹화에서 끔</sub>

### 읽는 순서

<img src="docs/readme/shot_reading.jpg" width="100%" alt="실제 앱 화면: 위키백과 미디어 아트 페이지의 읽는 순서 보기를 확대한 모습. 조각 500개(글 490, 이미지 10)가 문서 순서대로 세로 단을 이루고, 검색어와 비슷한 글은 진하고 큼. 팝 아트, 비디오 아트 같은 목록이 가운데 단에 보임. 연결 상위 0%">

### 상호 유사도

<img src="docs/readme/shot_meaning.jpg" width="100%" alt="실제 앱 화면: 상호 유사도 보기를 확대한 모습. 연결 상위 0.5%, 빨간 선 624개가 비슷한 말들을 묶어 아래쪽에 짙은 무리를 이룸">

<sub>빨간 선은 가중치가 높은 쌍입니다. "연결 상위" 기본값은 0%이고, 조각을 고르거나 올리면 가까운 조각 최대 5개로 선이 나타납니다.</sub>

### 검색어 유사도

<img src="docs/readme/shot_query.jpg" width="100%" alt="실제 앱 화면: 검색어 유사도 보기를 확대한 모습. 가운데 붉은 글자로 미디어 아트, 그 둘레에 비슷한 조각이 크고 진하게 놓이고 바깥으로 갈수록 작고 흐려짐. 연결 상위 0%">

### 3D

<img src="docs/readme/shot_3d.jpg" width="100%" alt="실제 앱 화면: 같은 미디어 아트 페이지를 3D 나선으로 본 모습. 언어 이름, 디지털 아트와 비디오 아트 같은 말이 위에서 아래로 층을 이루며 감겨 내려가고, 연결 상위 0.2%의 빨간 선 250개가 층 사이를 이음">

<details>
<summary>보기 조작</summary>

평면에서 드래그는 이동, 3D에서 드래그는 회전이고, 휠은 확대입니다. 처음에는 살짝 확대되어 열리고(0.68), 빈 곳 더블클릭은 전체 보기입니다. 3D는 드래그하거나 조각을 고르기 전까지 천천히 돕니다. 검색어 유사도는 유사도 값이 있을 때만 나타나고, 가운데에 검색어가 붉은 글자로 놓입니다.

</details>

## 6. 조각 다루기

<img src="docs/readme/focus_callouts.png" width="100%" alt="실제 앱 화면에 번호를 붙인 그림: 컴퓨터를 기반으로 한 미디어아트로 시작하는 문장을 고른 모습. 1 고른 글은 빨갛게, 나머지는 흐리게, 빨간 선 5개가 가까운 조각으로 이어짐. 2 패널의 검색어 미디어 아트와의 유사도 0.78. 3 이 조각으로 다시 검색 버튼은 새 최초 검색이며 이전 카드가 지워짐. 4 더 잘게 분해 버튼은 Haiku가 원문 안의 구절로 나눔. 5 가까운 조각 목록은 가중치 0.85부터 0.83까지 5개이고 누르면 초점을 옮김">

<sub>실제 화면에 번호를 덧붙임</sub>

<img src="docs/readme/demo_split.webp" width="100%" alt="실제 앱 화면 녹화: 긴 문장을 고르고 더 잘게 분해를 누르자 그 자리에서 컴퓨터, 기반, 미디어아트, 과학자, 컴퓨터이론가, 예술가, 공동참여로 나뉨 → 컴퓨터이론가를 고르고 이 조각으로 다시 검색 → 말 로딩 화면 → 검색어 컴퓨터이론가의 새 카드가 나타남">

<sub>실제 화면 · 실제 Haiku 호출과 실제 검색 · 대기 17.5초를 약 2초로 줄이고 새 카드 등장은 3.2배속</sub>

<details>
<summary>다시 검색과 구절 나누기 자세히</summary>

- 다시 검색은 그 글을 새 최초 검색어로 삼습니다. 이미지는 `label`을, 없으면 가장 가까운 글 조각을 씁니다. 공백을 정리하고 단어 경계에서 100자로 자릅니다.
- 구절 나누기는 Claude Haiku(`claude-haiku-5-5`)로 원문 순서대로 겹치지 않는 구절을 받습니다. 원문에 실제로 있는 부분만 통과합니다. 호출당 약 0.00005달러입니다.
- `GET /deconstruct/phrases?text=&query=`, 글은 1000자까지, 구절은 최대 8개입니다. 모델은 `REFINE_MODEL`로 바꿀 수 있습니다.
- 호출이 실패하거나, 지출 한도에 닿거나, `SEGMENT_MODE=rule`이면 규칙으로(문장 부호, 없으면 단어) 나누고 화면에 표시합니다. 상태 문구는 구절로 나누는 중입니다, 규칙으로 나눴습니다, 더 나눌 구절이 없습니다 입니다.
- 원문이 6자 미만이면 더 잘게 분해 버튼을 숨깁니다. 원래 문장으로 합치기는 나누기 전으로 되돌립니다.
- 글 조각은 그 자리에서 구절로 바뀝니다. 이미지는 그대로 두고 `label`을 나눈 구절을 아래에 모읍니다.
- 구절의 크기와 진하기는 자기 검색어 유사도를 원래 페이지 척도로 계산한 값입니다. 가까운 조각 목록은 원래 문장의 것을 물려받습니다. 구절끼리의 가중치는 계산하지 않습니다.
- 구절도 다시 검색하거나 또 나눌 수 있고, 보기와 3D를 바꿔도 부모를 따라갑니다.

</details>

## 7. 계산

<img src="docs/readme/pipeline.png" width="100%" alt="분해 파이프라인 여섯 단계: 1 추출(Playwright Chromium, egress proxy 경유, 페이지를 열고 스크롤해 글과 이미지를 모음, 최대 500개) 2 문장 나누기(claude-opus-5-5, 60자 넘는 글의 경계만 받아 서버가 자름, 실패하면 규칙으로 분할) 3 이미지 설명(alt와 캡션을 먼저 쓰고 없으면 claude-opus-5-5 Vision, 페이지당 최대 12장, 512px) 4 임베딩(Xenova/bge-m3 로컬, q8, 1024차원) 5 가중치(모든 쌍) 6 검색어 유사도(검색어가 있을 때만). 응답은 contents, weights, querySimilarities. 페이지당 약 0.01–0.05달러, 8–21초(문서 기록), 주황은 유료 Claude 호출">

모든 쌍($i \lt j$)의 가중치입니다. 값이 대략 0.53–1에 몰려서, 빨간 선은 상위 백분위로 고릅니다.

$$
w_{ij} = \frac{1 + \cos(e_i, e_j)}{2}
$$

빨간 선 개수입니다. $N$ 은 쌍의 수 $n(n-1)/2$ 이고, $p$ 는 "연결 상위" 퍼센트($p \gt 0$)입니다.

$$
\mathrm{threads} = \max\left(1, \min\left(4000, N, \left\lceil \frac{N p}{100} \right\rceil\right)\right)
$$

진하기와 크기는 가중치가 아니라 조각의 검색어 유사도 $v$ 만 따릅니다. $v$ 도 $(1 + \cos)/2$ 척도이고, 페이지마다 정렬해 5% 지점을 $low$, 95% 지점을 $high$ 로 잡습니다.

$$
t = \mathrm{clamp}\left(\frac{v - low}{high - low}, 0, 1\right)
$$

불투명도는 $\epsilon = 0.14$ 아래로 내려가지 않습니다.

$$
\mathrm{opacity} = \epsilon + (1 - \epsilon) t
$$

크기 배율은 0.72에서 1.72 사이입니다.

$$
\mathrm{scale} = 0.72 + t
$$

<img src="docs/readme/emphasis_scale.png" width="100%" alt="유사도가 높을수록 진하고 크게: 같은 단어 고양이를 t = 0, 0.25, 0.5, 0.75, 1로 놓은 그림. 불투명도 0.14, 0.355, 0.57, 0.785, 1, 크기 ×0.72, ×0.97, ×1.22, ×1.47, ×1.72. 막대 그래프의 붉은 선은 바닥 0.14. 아래에 t, 불투명도, 크기 식">

<sub>실제 코드의 상수로 계산해 그린 그림 · 앱 화면 캡처가 아님</sub>

<details>
<summary>표시 값 자세히</summary>

가중치는 소수 넷째 자리까지 돌려주고, 길이는 $n(n-1)/2$ 입니다.

패널에는 늘리기 전의 원래 유사도를 소수 둘째 자리까지 표시합니다. 유사도가 없으면 불투명도와 크기는 1입니다.

- 이미지는 `alt`, 캡션, `aria-label`, `title`을 먼저 씁니다. SVG, 64px 미만, 한도를 넘는 이미지는 주변 글자를 쓰고, 단색 이미지는 뺍니다.
- 임베딩 모델 `Xenova/bge-m3`는 첫 실행 때 약 560MB를 내려받고 메모리를 1.2–1.8GB 씁니다.
- 응답은 `{contents:[{type:"text"|"img",content,label?}], weights:[[i,j,w]], querySimilarities?}`입니다.
- 기본 글상자: 이미지 200x150, 14자 이하 글 너비 200·글자 22, 48자 이하 너비 260·글자 17, 그보다 길면 너비 340·글자 14·최대 6줄입니다.
- 선택하거나 올리면 다른 조각은 불투명도 $\times 0.16$ 으로 낮아지고, 선택한 조각과 가까운 조각은 1이 되며, 선택한 글은 빨강이 됩니다.
- 슬라이더 단계는 0, 0.05, 0.1, 0.2, 0.5, 1, 2, 5 퍼센트입니다.
- 선의 투명도와 굵기는 표시 범위 안에서 늘린 강도 $s$ 를 따릅니다. 투명도는 $(0.28 + 0.6 s) \cdot threadAlpha$, 굵기는 $1 + 0.5 s$ 입니다.

</details>

## 8. 구조와 API

<img src="docs/readme/architecture.png" width="100%" alt="어떤 요청이 어디로 가는가: 브라우저(apps/web, 카드 스택, 미리보기 캔버스, 분해 보기) → 개발은 pnpm dev의 Vite 127.0.0.1:5173이 두 서버로 나눠 보내고, 배포는 pnpm start의 서버 하나가 dist까지 제공 → apps/api :3000(/search, /preview, /preview-ws)과 apps/deconstruct 127.0.0.1:3001(/deconstruct, /deconstruct/phrases) → 외부 유료 API SerpApi와 Claude, 시스템 Chrome, Playwright Chromium, 로컬 임베딩 Xenova/bge-m3. 배포에서는 프록시가 GET /deconstruct와 /deconstruct/phrases만 통과시키고, 분해 서비스가 꺼지거나 실패해도 검색은 계속 동작함">

<img src="docs/readme/repo_structure.png" width="100%" alt="폴더 구조: apps/api(검색, LLM, 미리보기, 원격 브라우저 서버), apps/deconstruct(Fastify 분해 서버: 추출, 분할, 이미지 설명, 임베딩, 그래프, 구절 분해, 보안, 사용량, 뷰어), apps/web(카드 스택과 분해 보기 화면, three CSS3DRenderer), packages/graph-contract(공용 그래프 계약과 시뮬레이터), packages/lab-kit(실험 패널과 공용 도구), scripts(dev, start, config, deconstruct 실행 스크립트), tests(production, search-integration 테스트), docs/readme(이 README의 그림과 영상, 그림 원본)">

### 검색 API

<img src="docs/readme/api_search.webp" width="100%" alt="팀원이 녹화한 터미널 화면: curl로 localhost:3000/search에 query=고양이, skewedQueryCount=4, skewedCount=4, alignedCount=10을 보내고 jq로 출력. 응답 JSON의 aligned 목록과, 톡소포자충 행동 조작 등 검색어를 키로 하고 rank와 results를 가진 skewed 객체가 스크롤됨. 이 파라미터와 키 이름은 현재 코드에 없음">

<sub>실제 터미널 녹화(팀원 제공) · 개인 프롬프트가 보이는 맨 앞 0.4초를 잘라 내고 타이핑 1.6배속, 대기 3배속 · **영상의 이름은 지금 API와 다릅니다.** 아래 표의 현재 이름을 쓰세요</sub>

| 영상 속 이름 | 현재 코드의 이름 | 기본값 | 범위 |
| --- | --- | --- | --- |
| `skewedQueryCount` | `awesomeQueryCount` | 10 | 0–20 |
| `skewedCount` | `awesomeCount`(검색어 하나당) | 3 | 0–100 |
| `alignedCount` | `goodCount` | 30 | 0–100 |
| 응답 키 `aligned` | 응답 키 `good` | | |
| 응답 키 `skewed` | 응답 키 `awesome` | | |

<details>
<summary>현재 이름으로 쓴 요청, 검색 API 오류, 서버 구성</summary>

`aligned`와 `skewed`는 지금 카드 탭의 표시 글자로만 남아 있습니다. 서버는 모르는 파라미터를 거부하지 않으므로, 영상의 명령을 그대로 보내면 기본값이 적용될 것입니다(코드를 읽어 추론, 실행해 보지 않음).

영상과 같은 요청을 현재 이름으로 쓰면 다음과 같습니다. 실행할 때마다 유료 API를 호출합니다.

```bash
curl --get 'http://localhost:3000/search' \
  --data-urlencode 'query=고양이' \
  --data-urlencode 'awesomeQueryCount=4' \
  --data-urlencode 'awesomeCount=4' \
  --data-urlencode 'goodCount=10' | jq
```

화면은 `goodCount=10`, `awesomeQueryCount=4`, `awesomeCount=2`로 요청합니다. `awesomeDirection`으로 재해석 방향을 직접 줄 수도 있습니다.

`/search` 오류:

| 상태 | 메시지 |
| --- | --- |
| 400 | `query is required`, 개수 관련 메시지 |
| 404 | `Not found` |
| 405 | `Method not allowed` |
| 502 | `LLM query generation failed`, `SerpApi search failed` |

- 개발 서버는 `/search`, `/preview`, `/preview-ws`를 API로, `/deconstruct`를 분해 서버로 프록시합니다.
- 프로덕션 서버는 빌드 화면과 생성된 assets를 제공하고, 127.0.0.1에만 열린 분해 서버의 `GET /deconstruct`와 `/deconstruct/phrases`만 프록시합니다. 그래서 공개 포트에서 `/health`와 `/debug/extract`는 404입니다.
- 분해 서버는 `NODE_ENV=production`으로 돌며, 이때 뷰어와 `/debug/extract`를 등록하지 않습니다. `/health`는 127.0.0.1:3001에서 그대로 응답합니다.
- 서버 생성 함수의 선택적 `frontendDir` 옵션을 생략하면 기존 API 진단 화면(`apps/api/public`)을 유지합니다.
- `dist`는 Git에서 제외합니다.
- `art-hackathon-query-api`의 검색 API와 `algorithm_team2/prototypes/06-card-stack` 화면을 통합한 독립 프로젝트입니다. 원본 저장소의 코드는 변경하지 않습니다.

</details>

상세 규약: [API_SPEC](apps/api/API_SPEC.md) · [분해 API 연동 가이드](apps/deconstruct/FRONTEND.md) · [분해 서버 README](apps/deconstruct/README.md)

## 9. 실행

<img src="docs/readme/run_steps.png" width="100%" alt="실행하기, Node 22.9.0 이상, pnpm 11.25.0: 1 의존성 설치 pnpm install, 2 분해용 Chromium 설치 pnpm setup:deconstruct(한 번만), 3 환경 변수 파일 만들기 cp .env.example .env(채울 값은 SERPAPI_API_KEY와 고른 LLM의 키), 4 개발 서버 실행 pnpm dev(웹 127.0.0.1:5173, 검색 API :3000, 분해 API :3001). 배포 모드 pnpm build, pnpm start(localhost:3000, 외부 배포는 포함되어 있지 않음). 테스트 pnpm check, pnpm test, pnpm build, pnpm test:deconstruct(외부 API를 대체해 비용 없음). 분해 비용 없이 화면 작업 SEGMENT_MODE=rule, VISION_MAX_PER_PAGE=0(검색은 그래도 유료 API를 부름)">

```bash
pnpm install
```

```bash
pnpm setup:deconstruct   # 분해에 쓰는 Chromium 설치. 최초 1회
```

```bash
cp .env.example .env     # SERPAPI_API_KEY와 선택한 LLM 공급자의 API 키를 입력
```

```bash
pnpm dev
```

분해 서버는 메모리를 1.2–1.8GB 쓰고, 첫 실행 때 임베딩 모델 약 560MB를 내려받습니다. 필요 없으면 `DECONSTRUCT_ENABLED=false`로 끕니다.

<details>
<summary>프로덕션과 검증</summary>

개발 화면: http://127.0.0.1:5173 · 검색 API: http://127.0.0.1:3000 · 분해 API: http://127.0.0.1:3001

프로덕션:

```bash
pnpm build
```

```bash
pnpm start
```

http://localhost:3000 에서 카드 스택과 API를 같은 서버로 제공합니다. 빌드가 없으면 실행 안내와 함께 종료합니다. 외부 배포는 포함하지 않습니다.

검증:

```bash
pnpm check
```

```bash
pnpm test
```

```bash
pnpm build
```

```bash
pnpm test:deconstruct   # 분해 서버 테스트. Chromium 필요
```

테스트는 외부 API를 대체하며 실제 비용을 발생시키지 않습니다. 목데이터는 명시적인 격리 테스트나 `apiEndpoint: ''`로 지정한 테스트 마운트에서만 사용합니다. 기록은 [VERIFICATION.md](VERIFICATION.md)에 있습니다.

</details>

<details>
<summary>환경 변수와 비용</summary>

키는 서버에서만 읽으며 Git과 프론트 빌드에서 제외됩니다. 환경 설정을 변경하면 서버를 재시작합니다. 최초 구성 때는 기존 API 프로젝트의 환경 설정을 루트 `.env`에 복사했습니다.

| 변수 | 뜻 |
| --- | --- |
| `SERPAPI_API_KEY` | 필수. Google 검색 |
| `ANTHROPIC_API_KEY` | `LLM_PROVIDER=anthropic`(기본)일 때 필수 |
| `OPENAI_API_KEY` | `LLM_PROVIDER=openai`일 때 필수 |
| `LLM_PROVIDER` | `anthropic` 또는 `openai` |
| `ANTHROPIC_MODEL`, `OPENAI_MODEL` | 공급자별 모델 |
| `PORT` | API, 프로덕션 포트. 기본 3000 |
| `WEB_PORT` | 개발 화면 포트. 기본 5173 |
| `DECONSTRUCT_ENABLED` | `false`면 분해 서버를 끕니다. 꺼져 있거나 실패해도 검색은 그대로 동작합니다 |
| `DECONSTRUCT_PORT` | 분해 서버 포트. 기본 3001 |
| `SEGMENT_MODE` | `rule`이면 문장 나누기와 구절 나누기를 규칙으로 합니다 |
| `VISION_MAX_PER_PAGE` | 페이지당 Vision 이미지 수. 기본 12 |
| `LLM_BUDGET_USD` | 분해 지출 한도. 기본 100달러 |
| `REFINE_MODEL` | 구절 나누기 모델. 기본 `claude-haiku-5-5` |
| `CHROME_BIN` | 미리보기에 쓸 Chrome 경로 |
| `CORS_ORIGIN` | CORS 허용 출처 |

그 밖의 한도는 [`apps/deconstruct/src/config.js`](apps/deconstruct/src/config.js)에 있습니다.

- 화면 작업 중에는 루트 `.env`에 `SEGMENT_MODE=rule`과 `VISION_MAX_PER_PAGE=0`을 넣으면 분해 LLM 비용 없이 같은 형식으로 응답합니다. 검색은 그래도 유료 API를 부릅니다.
- 지출 한도는 머신별로 `apps/deconstruct/data/usage.json`에 쌓는 추정치이고, 조금 넘을 수 있으며, `/search`의 LLM 비용은 포함하지 않습니다.
- 장부 단가는 백만 토큰당 달러로 입력/출력 Opus 4/20, Sonnet 2/10, Haiku 0.1/0.5입니다.
- 검색 한 번의 비용은 문서에 기록되어 있지 않습니다.
- `pnpm dev` 터미널에는 `/search` 요청 검색어와 옵션, 응답 상태와 소요 시간, good 문서 순위와 제목, awesome 생성 검색어와 순위, 각 문서 순위와 제목이 표시됩니다. 요청 번호로 요청과 응답을 연결하며 URL, 이미지, 본문은 출력하지 않습니다. `pnpm start`에서는 이 로그를 출력하지 않습니다.

</details>

## 10. 한계와 문서

<img src="docs/readme/limits.png" width="100%" alt="한계와 확인하지 못한 것. 왼쪽, 마지막 기록까지 확인하지 못함: 실제 Haiku 구절이 화면에 나오는 모습, 실제 검색 카드에서 시작한 분해, 실제 터치 입력, 다른 PC에서 새로 설치. 오른쪽, 알려진 한계: 요청 제한이 없어 공개 터널을 열면 누구나 유료 분해를 호출할 수 있음, 검색 기록은 메모리에만 있음, canvas와 WebGL 내용, 인라인 SVG, ::before 글자, select, textarea, placeholder, aria-label은 추출하지 않음, 눌러야 보이는 내용과 안쪽 스크롤의 지연 로딩은 깨우지 않음, 200으로 응답한 CAPTCHA 페이지도 내용으로 추출됨, 조각 수는 실행마다 달라짐, 이미지는 픽셀이 아니라 설명 글로 비교해 설명 없는 이미지가 이웃하면 근거 없이 높은 가중치를 받을 수 있음, 링크 따라가기는 구현되지 않았고 붉은 화살표도 실제 하이퍼링크가 아님">

<sub>왼쪽은 VERIFICATION.md 마지막 기록 기준입니다. 이 README를 촬영하면서 앞의 두 항목은 실제 응답으로 동작을 봤고, 뒤의 두 항목은 여전히 확인하지 못했습니다.</sub>

<details>
<summary>촬영하며 본 문제</summary>

- 공개 터널로 열면 누구나 유료 분해를 호출할 수 있습니다. 서버에는 아직 요청 빈도 제한이 없고, 지출은 `LLM_BUDGET_USD`에서 멈춥니다.
- Google `/goto` 카드를 처음 열면 원격 브라우저가 "요청 확인 중" 중간 페이지에 머물 수 있습니다(촬영 때 약 10초 지속, 다음 열기에서는 바로 열림). 이때 분해하면 중간 페이지를 추출할 가능성이 있습니다(코드를 읽어 추론, 실행해 보지 않음).
- 조각에는 페이지의 메뉴와 아이콘도 포함됩니다. 위키백과 미디어 아트 페이지는 500개 상한에 닿았습니다.
- 언어 이름 조각의 키릴 문자 일부(и)가 빈 네모로 나왔습니다(촬영 환경의 헤드리스 Chromium). 다른 환경에서 같은지는 확인하지 않았습니다.

</details>

<details>
<summary>기록된 검증과 성능</summary>

- 테스트, README 촬영 때 다시 실행(커밋 21f6492 기준): API·production 102, web·shared 108, deconstruct 97 모두 통과. [VERIFICATION.md](VERIFICATION.md)의 2026-11-07 main 병합 기록에는 web·shared가 104입니다.
- 성능, 2026-11-07 3차 검증 기록: 조각 500개, 개발 PC Chromium에서 터짐, 3D, 회전 120fps(가장 느린 프레임 9 ms), 평면 복귀 117fps(가장 느린 프레임 67 ms). 이 값은 전환을 바꾼 4차 변경 전의 측정입니다.
- 검색 이어가기, 2026-11-06 통합 검증 기록: 카드 17장에서 35장으로 늘어도 기존 17장의 ID와 위치가 유지됨.

</details>

<details>
<summary>이 README의 그림과 영상</summary>

- 그림 원본: [`docs/readme/src/figures.html`](docs/readme/src/figures.html), 그림에 쓴 화면 사진은 [`docs/readme/src/raw`](docs/readme/src/raw)
- 설명용 모션 원본: [`motion_concept.html`](docs/readme/src/motion_concept.html), [`motion_deconstruct.html`](docs/readme/src/motion_deconstruct.html)
- 실제 화면 영상과 사진은 2026-11-07에 실제 검색과 실제 분해 응답으로 찍었습니다. 카드에 나오는 내용은 그때의 공개 검색 결과입니다.
- `process_concept`, `process_archive`는 팀 아카이브를, `process_board`는 피그마 보드를 캡처했습니다.

모션 렌더:

```bash
node docs/readme/src/render-motion.mjs <html> <output.webp> --lossless
```

</details>

문서: [API_SPEC](apps/api/API_SPEC.md) · [분해 API 연동 가이드](apps/deconstruct/FRONTEND.md) · [분해 서버 README](apps/deconstruct/README.md) · [검증 기록](VERIFICATION.md)

## 11. 작업 과정

**[팀 아카이브 열기](https://claude.ai/artifact/5tuAr4eDBKamX1oaWJu8Jy)**: 회의 녹음과 전사, 직접 눌러 보는 개념 시연

<a href="https://claude.ai/artifact/5tuAr4eDBKamX1oaWJu8Jy"><img src="docs/readme/process_archive.jpg" width="100%" alt="팀 아카이브 첫 화면: 흰 바탕의 노드 그래프 위에 앱의 검색 원이 있고, 원 안에 제목 AI와 알고리즘의 평균에서 벗어나는 인간의 지향, 2026 Open Prompt Art Hackathon 2조 11.05–11.07. 누르면 아카이브가 열림"></a>

<img src="docs/readme/process_timeline.png" width="100%" alt="회의 녹음 11개, 14시간 46분의 타임라인. Day 1 11월 5일 6시간 45분: 01 취미로 자기소개 1시간 20분, 02 발제와 진행 방식 토론 1시간 11분(입장 차이), 03 자유 토론 44분, 04 jev 그래프와 주제 문장 해부 57분(핵심 등장), 05 벗어남과 찾아감, 정리 방식 논의 15분, 06 너무 빨리 정리하지 말자 5분(속도 조절), 07 경험 구조 2시간 13분(수렴). Day 2 11월 6일 8시간 1분: 2-1 시안 공유 55분(방향 전환), 2-2 재귀 구조와 크릿 2시간 18분(구조 합의), 2-3 분해 스키마 2시간 39분(구현과 통합), 2-4 통합 순서 2시간 11분(첫 데모). 합친 순서: 21:45 첫 통합, 23:32 PR 1과 2, 00:00 PR 3, 00:57 PR 4, 01:15 PR 6, 01:19 PR 5">

<img src="docs/readme/process_board.jpg" width="70%" alt="Day 1 피그마 보드: 위쪽에 주제 문장을 구성에서 평균(일반)으로 고친 메모와 어떤 경험을 주고 싶은가라는 질문, 왼쪽에 각자의 키워드와 레퍼런스 카드 Curatorial A(i)gents, X Degrees of Separation, Neue Metabilder, 오른쪽에 jev의 선택을 edge로 삼아 그래프를 만든다는 정리 메모">

<sub>Day 1 · 피그마 보드</sub>

<img src="docs/readme/process_concept_day1.webp" width="100%" alt="아카이브의 Day 1 개념 시연: 파란 jev 경로가 노드 그래프를 빠르게 달리고, 사람은 노드를 눌러 같은 선택지에서 한 걸음씩 고르며 주황 경로를 남김. 선택이 jev와 겹치면 잡았다가 뜸">

<sub>Day 1 안 · jev의 빠른 길과 사람의 느린 길 · 아카이브의 개념 시연, 단어는 예시</sub>

<img src="docs/readme/process_concept_day2.webp" width="100%" alt="아카이브의 Day 2 오후 개념 시연: 김치찌개 검색에서 익숙한 결과는 흐려지고, 튀는 결과를 누르면 페이지가 조각으로 터지고, 고른 조각이 다음 검색어가 되어 이어짐">

<sub>Day 2 오후 안 · 튀는 결과를 부수고 조각에서 다시 검색 · 아카이브의 개념 시연, 단어는 예시</sub>

<img src="docs/readme/process_shift.png" width="100%" alt="세 시점 비교표. 벗어나는 방법: Day 1은 jev가 달리는 평균의 길 옆을 사람이 직접 걷기, Day 2 오후는 검색 순위를 뒤집어 뒤쪽 결과로 들어가기, 최종은 LLM이 검색어를 네 단계로 재해석해 곁에 붙이기. 노드: 미정, 검색 결과 사이트와 그 안의 조각, 3D 카드와 실제 페이지와 조각. jev: 작품의 주인공, 결과를 고르는 규칙 중 하나, 쓰지 않음. 사람: jev와 같은 선택지에서 고르기, 튀는 결과를 누르고 조각을 골라 다음 검색으로, 카드를 열고 분해할지 이어 검색할지 어느 조각을 고를지 정하기. 루프: 없음, 결과가 다시 검색어가 됨, 카드 제목은 이어가기이고 조각은 새 최초 검색어">

<img src="docs/readme/process_threads.png" width="100%" alt="아이디어 갈래 23개와 등장 회의의 격자. 최종 핵심 4개: 검색어 재해석, 결과가 다시 검색어로, 페이지 해체와 임베딩, 네트워크 데이터 시각화. 방식과 표현으로 반영 5개: 보간 너머와 AI 압축 문제, 취향과 개성과 디깅, 알고리즘 반대편과 뒤쪽 결과, 추천 기준 직접 고르기, 공통 질문에서 각자 MVP. 보류 13개: 순위 역순과 확률 뒤집기, 선택 의탁 그래프 jev, 껍데기 페르소나, 군집화, 불편함과 감정의 여운, 플랫폼 카피 UI, 탄막과 떨어지는 선택지, 물리적 출력, 카오스 속의 하모니, 기억하는 AI 검증, 사건 데이터 위의 궤적, 챗봇 인터페이스, 크롬 확장 형태. 제외 1개: 취향 찾기 에이전트">

<sub>자동 전사를 Claude로 분류한 집계</sub>
