const $ = (selector) => document.querySelector(selector);
const form = $('#search-form');
const fields = $('#search-fields');
const queryInput = $('#search-query');
const directionInput = $('#direction');
const countInputs = [$('#good-count'), $('#query-count'), $('#awesome-count')];
const defaults = [30, 10, 3];
const sections = ['welcome', 'loading', 'error-state', 'results'];
let controller = null;
let responseData = null;
let requestUrl = '';
let rankedGroups = [];
let selectedQuery = null;
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showSection(id) {
  for (const section of sections) $('#' + section).hidden = section !== id;
}

function setStatus(label, message, state = '') {
  $('#status-badge').textContent = label;
  $('#status-badge').dataset.state = state;
  $('#status-line').textContent = message;
}

function updateEstimate() {
  const [good, queries, perQuery] = countInputs.map((input) => Number(input.value));
  const valid = countInputs.every((input) => input.validity.valid);
  const estimate = $('#estimate');
  estimate.replaceChildren();
  if (!valid) {
    estimate.textContent = '각 항목의 허용 범위 안에서 정수를 입력하세요.';
    return;
  }
  estimate.append('최대 ', element('strong', '', String(good + queries * perQuery)), '개 문서를 탐색합니다.');
}

function loadParameters() {
  const params = new URLSearchParams(location.search);
  queryInput.value = params.get('query') ?? '';
  directionInput.value = params.get('awesomeDirection') ?? '';
  for (const input of countInputs) {
    const value = params.get(input.name);
    if (value !== null && /^\d+$/.test(value) && Number(value) <= Number(input.max)) {
      input.value = String(Number(value));
    }
  }
  updateEstimate();
}

function safeWebUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function documentCard(row) {
  const url = safeWebUrl(row.url);
  const card = element(url ? 'a' : 'article', 'document-card');
  if (url) {
    card.href = url.href;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
  }
  const meta = element('div', 'document-meta');
  meta.append(
    element('span', 'document-rank', '#' + row.rank),
    element('span', '', '·'),
    element('span', 'document-domain', url ? url.hostname.replace(/^www\./, '') : '링크 없음'),
  );
  if (url) meta.append(element('span', 'document-arrow', '↗'));
  const body = element('div', 'document-body');
  const copy = element('div', 'document-copy');
  copy.append(element('h5', '', row.title || '제목 없는 문서'));
  if (row.description) copy.append(element('p', '', row.description));
  body.append(copy);
  const imageUrl = safeWebUrl(row.image);
  if (imageUrl) {
    const image = element('img', 'document-image');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = imageUrl.href;
    body.append(image);
  }
  card.append(meta, body);
  return card;
}

function renderDocuments(container, rows, emptyMessage) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(element('p', 'group-empty', emptyMessage));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const row of rows) fragment.append(documentCard(row));
  container.append(fragment);
}

function renderAwesome() {
  const container = $('#awesome-results');
  container.replaceChildren();
  if (!rankedGroups.length) {
    container.append(element('p', 'group-empty', '반환된 검색어가 없습니다. 생성 검색어 수와 검색어당 문서 수가 0인지 확인하세요. 검색어 생성 전 시간 초과인 경우에도 비어 있을 수 있습니다.'));
    return;
  }
  for (const { query, rank, results } of rankedGroups) {
    if (selectedQuery !== null && selectedQuery !== query) continue;
    const section = element('section', 'query-group');
    const heading = element('div', 'group-heading');
    heading.append(
      element('span', 'group-number', String(rank).padStart(2, '0')),
      element('h5', '', query),
      element('span', 'group-count', results.length + '개 문서'),
    );
    const documents = element('div', 'document-list');
    renderDocuments(documents, results, '이 검색어로 수집된 문서가 없습니다.');
    section.append(heading, documents);
    container.append(section);
  }
}

function renderFilters() {
  const filters = $('#query-filters');
  filters.replaceChildren();
  if (!rankedGroups.length) return;
  const options = [{ query: null, rank: null }, ...rankedGroups];
  for (const { query, rank } of options) {
    const button = element('button', 'filter-button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedQuery === query));
    if (rank !== null) button.append(element('span', 'filter-rank', String(rank).padStart(2, '0')));
    button.append(document.createTextNode(query ?? '전체 보기'));
    button.addEventListener('click', () => {
      selectedQuery = query;
      for (const [index, filter] of [...filters.children].entries()) {
        filter.setAttribute('aria-pressed', String(options[index].query === selectedQuery));
      }
      renderAwesome();
    });
    filters.append(button);
  }
}

function renderResponse(data, query, duration, counts) {
  responseData = data;
  selectedQuery = null;
  rankedGroups = Object.entries(data.awesome)
    .map(([query, group]) => ({ query, ...group }))
    .sort((a, b) => a.rank - b.rank);
  const awesomeTotal = rankedGroups.reduce((sum, group) => sum + group.results.length, 0);
  $('#result-query').textContent = query;
  $('#good-total').textContent = data.good.length;
  $('#awesome-total').textContent = awesomeTotal;
  const summary = $('#result-summary');
  summary.replaceChildren();
  for (const [label, value] of [
    ['원문 문서', data.good.length + '개'],
    ['새로운 검색어', rankedGroups.length + '개'],
    ['새 관점 문서', awesomeTotal + '개'],
    ['응답 시간', duration.toFixed(1) + '초'],
  ]) {
    const item = element('span', 'summary-item', label);
    item.append(element('strong', '', value));
    summary.append(item);
  }
  renderDocuments($('#good-results'), data.good,
    counts.goodCount === 0 ? '원문 검색이 꺼져 있습니다. 원문 검색 문서 수를 1 이상으로 설정하세요.' : '수집된 원문 문서가 없습니다. 검색 결과가 없거나 시간 제한에 도달했을 수 있습니다.');
  renderFilters();
  renderAwesome();
  $('#json-output').textContent = JSON.stringify(data, null, 2);
  selectTab('visual');
  showSection('results');
  setStatus('응답 수신', `“${query}” · ${data.good.length + awesomeTotal}개 문서와 ${rankedGroups.length}개의 새로운 검색어를 받았습니다.`, 'success');
}

function validateResponse(data) {
  const validRows = (rows) => Array.isArray(rows) && rows.every((row) => row &&
    typeof row === 'object' && ['url', 'title', 'description', 'image'].every((key) => typeof row[key] === 'string') &&
    Number.isInteger(row.rank) && row.rank > 0);
  return data && validRows(data.good) && data.awesome && typeof data.awesome === 'object' &&
    !Array.isArray(data.awesome) && Object.values(data.awesome).every((group) =>
      group && Number.isInteger(group.rank) && group.rank > 0 && validRows(group.results));
}

function errorMessage(error, status) {
  const messages = {
    'LLM query generation failed': '새로운 검색어를 생성하지 못했습니다. 서버의 LLM API 키·모델 설정과 사용 한도를 확인하세요.',
    'SerpApi search failed': 'Google 검색 결과를 가져오지 못했습니다. 서버의 SerpApi 키·사용 한도와 네트워크 연결을 확인하세요.',
    'query is required': '검색어를 입력하세요.',
  };
  return `HTTP ${status} · ${messages[error] ?? (error || '검색 요청을 처리하지 못했습니다.')}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (controller || !form.reportValidity()) return;
  const query = queryInput.value.trim();
  if (!query) {
    queryInput.setCustomValidity('검색어를 입력하세요.');
    queryInput.reportValidity();
    return;
  }
  queryInput.value = query;
  const params = new URLSearchParams(new FormData(form));
  params.set('query', query);
  const direction = directionInput.value.trim();
  if (direction) params.set('awesomeDirection', direction);
  else params.delete('awesomeDirection');
  const counts = Object.fromEntries(countInputs.map((input) => [input.name, Number(input.value)]));
  for (const [name, value] of Object.entries(counts)) params.set(name, String(value));
  requestUrl = new URL('/search?' + params, location.origin).href;
  history.replaceState(null, '', '?' + params);
  controller = new AbortController();
  fields.disabled = true;
  $('#cancel-button').hidden = false;
  $('.explorer').setAttribute('aria-busy', 'true');
  showSection('loading');
  setStatus('탐색 중', `“${query}”의 검색 결과를 기다리고 있습니다.`);
  const startedAt = performance.now();
  $('#elapsed').textContent = '0초 경과';
  const ticker = setInterval(() => {
    const seconds = Math.floor((performance.now() - startedAt) / 1000);
    $('#elapsed').textContent = seconds + '초 경과';
    if (seconds >= 30) $('#status-line').textContent = '새로운 검색어와 문서를 수집하고 있습니다. 최대 120초가 소요될 수 있습니다.';
  }, 1000);
  let clientTimedOut = false;
  const timeout = setTimeout(() => {
    clientTimedOut = true;
    controller?.abort();
  }, 135_000);
  try {
    const response = await fetch(requestUrl, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(errorMessage(data.error, response.status));
    if (!validateResponse(data)) throw new Error('API 응답 형식이 올바르지 않습니다. 서버의 응답 구조를 확인하세요.');
    renderResponse(data, query, (performance.now() - startedAt) / 1000, counts);
  } catch (error) {
    if (controller.signal.aborted && !clientTimedOut) {
      showSection('welcome');
      setStatus('대기 취소', '검색 대기를 취소했습니다. 서버에서 이미 시작한 검색은 계속 진행될 수 있습니다.');
    } else {
      showSection('error-state');
      $('#error-message').textContent = clientTimedOut
        ? '서버 응답 대기 시간이 초과되었습니다. 서버 연결 상태를 확인한 뒤 다시 시도하세요.'
        : error instanceof TypeError ? '서버에 연결할 수 없습니다. 서버 실행 상태와 네트워크 연결을 확인하세요.'
          : error instanceof SyntaxError ? '서버에서 JSON 응답을 받지 못했습니다. 서버의 응답을 확인하세요.' : error.message;
      setStatus('요청 실패', '검색 요청을 완료하지 못했습니다. 아래 오류 내용을 확인하세요.', 'error');
    }
  } finally {
    clearInterval(ticker);
    clearTimeout(timeout);
    controller = null;
    fields.disabled = false;
    $('#cancel-button').hidden = true;
    $('.explorer').setAttribute('aria-busy', 'false');
  }
});

queryInput.addEventListener('input', () => queryInput.setCustomValidity(''));
for (const button of document.querySelectorAll('[data-query]')) {
  button.addEventListener('click', () => {
    queryInput.value = button.dataset.query;
    queryInput.setCustomValidity('');
    queryInput.focus();
  });
}
for (const input of countInputs) input.addEventListener('input', updateEstimate);
$('#reset-counts').addEventListener('click', () => {
  countInputs.forEach((input, index) => { input.value = defaults[index]; });
  updateEstimate();
});
$('#cancel-button').addEventListener('click', () => controller?.abort());

function selectTab(name, focus = false) {
  for (const view of ['visual', 'json']) {
    const selected = name === view;
    const tab = $('#' + view + '-tab');
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $('#' + view + '-panel').hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

for (const name of ['visual', 'json']) {
  const tab = $('#' + name + '-tab');
  tab.addEventListener('click', () => selectTab(name));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    selectTab(event.key === 'Home' ? 'visual' : event.key === 'End' ? 'json' : name === 'visual' ? 'json' : 'visual', true);
  });
}

async function copyText(value, message) {
  clearTimeout(toastTimer);
  try {
    await navigator.clipboard.writeText(value);
    $('#toast').textContent = message;
  } catch {
    $('#toast').textContent = '복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하세요.';
  }
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3000);
}

$('#copy-request').addEventListener('click', () => copyText(requestUrl, '검색 API 요청 URL을 복사했습니다.'));
$('#copy-json').addEventListener('click', () => copyText(JSON.stringify(responseData, null, 2), 'JSON 응답을 복사했습니다.'));
loadParameters();
