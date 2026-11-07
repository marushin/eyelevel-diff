import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { AWESOME_DIRECTIONS, createSearchServer, search } from './server.js';

const apiKey = 'test-serp-key';
const openaiApiKey = 'test-openai-key';
const anthropicApiKey = 'test-anthropic-key';
const queryNames = (count) => Array.from({ length: count }, (_, i) => '연관 검색 ' + (i + 1));
const rows = (query, page = 1, count = 10) => Array.from({ length: count }, (_, i) => ({
  link: 'https://example.com/' + encodeURIComponent(query) + '/' + page + '/' + i,
  title: 'Title ' + page + '/' + i,
  snippet: 'Description ' + page + '/' + i,
  thumbnail: 'https://example.com/images/' + page + '-' + i + '.jpg',
  position: i + 1,
}));
const llmBody = (queries) => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ queries }) }] },
  ],
});

const anthropicBody = (queries) => ({
  type: 'message',
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: 'Reasoning is not part of the generated JSON.' },
    { type: 'text', text: JSON.stringify({ queries }) },
  ],
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function mockUpstream({
  queries,
  generate = (body) => {
    const generated = queries ?? queryNames(JSON.parse(body.input ?? body.messages[0].content).count);
    return body.messages ? anthropicBody(generated) : llmBody(generated);
  },
  serp = (query, page) => ({ organic_results: rows(query, page) }),
} = {}) {
  const openaiCalls = [];
  const anthropicCalls = [];
  const serpCalls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    let value;
    if (url.origin === 'https://api.openai.com') {
      const body = JSON.parse(options.body);
      openaiCalls.push({ url, ...options, body });
      value = await generate(body, options.signal);
    } else if (url.origin === 'https://api.anthropic.com') {
      const body = JSON.parse(options.body);
      anthropicCalls.push({ url, ...options, body });
      value = await generate(body, options.signal);
    } else {
      assert.equal(url.origin, 'https://serpapi.com');
      assert.equal(url.pathname, '/search.json');
      const query = url.searchParams.get('q');
      const page = Number(url.searchParams.get('start')) / 10 + 1;
      serpCalls.push({ url, query, page, signal: options.signal });
      value = await serp(query, page, options.signal);
    }
    return value instanceof Response ? value : Response.json(value);
  };
  return { fetchImpl, openaiCalls, anthropicCalls, serpCalls };
}

const runSearch = (mock, options = {}, query = '인터랙티브 아트') => search(query, {
  apiKey, openaiApiKey, anthropicApiKey, llmProvider: 'openai', ...mock, ...options,
});

async function listen(t, options) {
  const server = createSearchServer({ apiKey, openaiApiKey, anthropicApiKey, llmProvider: 'openai', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('frontend assets and documentation are served without upstream requests', async (t) => {
  const mock = mockUpstream();
  const base = await listen(t, mock);
  for (const [path, mime, marker] of [
    ['/', 'text/html; charset=utf-8', 'id="search-form"'],
    ['/app.js', 'text/javascript; charset=utf-8', "fetch(requestUrl"],
    ['/styles.css', 'text/css; charset=utf-8', '.workspace'],
    ['/favicon.svg', 'image/svg+xml', '<svg'],
    ['/API_SPEC.html', 'text/html; charset=utf-8', '/search'],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mime);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await response.text()).includes(marker));
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
    assert.equal(await head.text(), '');
  }
  assert.equal(mock.openaiCalls.length + mock.anthropicCalls.length + mock.serpCalls.length, 0);
});

test('static serving is allowlisted and rejects unsupported methods', async (t) => {
  const mock = mockUpstream();
  const base = await listen(t, mock);
  for (const path of ['/.env', '/server.js', '/package.json', '/public/app.js', '/%2e%2e/.env', '/missing.css', '/constructor']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  }
  const response = await fetch(base + '/', { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.deepEqual(await response.json(), { error: 'Method not allowed' });
  assert.equal(mock.openaiCalls.length + mock.anthropicCalls.length + mock.serpCalls.length, 0);
});

test('defaults produce ten ranked query groups with three Google results each', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const mock = mockUpstream();
  const result = await runSearch(mock);
  assert.equal(result.good.length, 30);
  assert.deepEqual(Object.keys(result.awesome), queryNames(10));
  for (const [index, query] of queryNames(10).entries()) {
    const group = result.awesome[query];
    assert.equal(group.rank, index + 1);
    assert.deepEqual(group.results.map((row) => row.rank), [1, 2, 3]);
  }
  assert.deepEqual(result.good[0], {
    url: rows('인터랙티브 아트')[0].link,
    title: 'Title 1/0', description: 'Description 1/0',
    image: 'https://example.com/images/1-0.jpg', rank: 1,
  });
  assert.equal(result.good.at(-1).rank, 30);
  assert.equal(mock.serpCalls.length, 13);
  assert.equal(mock.openaiCalls.length, 1);
  const call = mock.openaiCalls[0];
  assert.equal(call.url.pathname, '/v1/responses');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer ' + openaiApiKey);
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.body.model, 'gpt-6.1-sol');
  assert.equal(call.body.store, false);
  assert.deepEqual(JSON.parse(call.body.input), {
    query: '인터랙티브 아트', direction: AWESOME_DIRECTIONS[0], count: 10,
  });
  assert.match(call.body.instructions, /semantic similarity.*closest first/);
  assert.match(call.body.instructions, /first query should be relatively close/);
  assert.match(call.body.instructions, /final query should look almost entirely unrelated/);
  assert.match(call.body.instructions, /If count is 1, prioritize one bold/);
  assert.doesNotMatch(call.body.instructions, /original query language/);
  const format = call.body.text.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  assert.equal(format.schema.properties.queries.minItems, 10);
  assert.equal(format.schema.properties.queries.maxItems, 10);
  for (const { url, page } of mock.serpCalls) {
    assert.equal(url.searchParams.get('engine'), 'google');
    assert.equal(url.searchParams.get('api_key'), apiKey);
    assert.equal(url.searchParams.get('hl'), 'ko');
    assert.equal(url.searchParams.get('gl'), 'kr');
    assert.equal(url.searchParams.get('no_cache'), 'true');
    assert.equal(url.searchParams.get('tbs'), 'li:1');
    assert.equal(url.searchParams.has('start'), page > 1);
    assert.ok(page >= 1 && page <= 3);
  }
});

test('HTTP decodes and trims query and direction and applies per-query counts', async (t) => {
  const mock = mockUpstream({ queries: [' 가까운 검색 ', '다른 검색'] });
  const base = await listen(t, { ...mock, openaiModel: 'configured-model' });
  const params = new URLSearchParams({
    query: '  아트 & design  ', awesomeDirection: '  생물학 관점 & 영어로  ',
    goodCount: '5', awesomeQueryCount: '2', awesomeCount: '12',
  });
  const response = await fetch(base + '/search?' + params);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const result = await response.json();
  assert.deepEqual(Object.keys(result), ['good', 'awesome']);
  assert.deepEqual(Object.keys(result.awesome), ['가까운 검색', '다른 검색']);
  assert.equal(result.good.length, 5);
  assert.equal(result.awesome['가까운 검색'].rank, 1);
  assert.equal(result.awesome['다른 검색'].rank, 2);
  for (const group of Object.values(result.awesome)) {
    assert.equal(group.results.length, 12);
    assert.equal(group.results.at(-1).rank, 12);
  }
  assert.deepEqual(JSON.parse(mock.openaiCalls[0].body.input), {
    query: '아트 & design', direction: '생물학 관점 & 영어로', count: 2,
  });
  assert.equal(mock.openaiCalls[0].body.model, 'configured-model');
  assert.equal(mock.openaiCalls[0].body.text.format.schema.properties.queries.maxItems, 2);
  for (const query of ['아트 & design', '가까운 검색', '다른 검색']) {
    assert.deepEqual(mock.serpCalls.filter((call) => call.query === query).map(({ page }) => page),
      query === '아트 & design' ? [1] : [1, 2]);
  }
});

test('search logs correlate requests with ranked titles and omit document payloads', async (t) => {
  const logs = [];
  const queries = ['가까운 관점', '먼 관점'];
  const mock = mockUpstream({
    queries,
    serp: (query) => ({ organic_results: rows(query).map((row, index) => ({ ...row, position: index + 7 })) }),
  });
  const base = await listen(t, { ...mock, searchLogger: (line) => logs.push(line) });
  const params = new URLSearchParams({
    query: '  아트 & design  ', awesomeDirection: '생물학 관점',
    goodCount: '1', awesomeQueryCount: '2', awesomeCount: '1',
    api_key: 'should-not-be-logged',
  });
  const response = await fetch(base + '/search?' + params);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(logs.length, 2);
  assert.ok(logs[0].startsWith('[search #1] request '));
  assert.deepEqual(JSON.parse(logs[0].slice('[search #1] request '.length)), {
    method: 'GET', query: '  아트 & design  ', awesomeDirection: '생물학 관점',
    goodCount: '1', awesomeCount: '1', awesomeQueryCount: '2',
  });
  assert.ok(logs[1].startsWith('[search #1] response '));
  const summary = JSON.parse(logs[1].slice('[search #1] response '.length));
  assert.equal(summary.status, 200);
  assert.ok(Number.isFinite(summary.durationMs) && summary.durationMs >= 0);
  assert.deepEqual(summary.good, [{ rank: 7, title: 'Title 1/0' }]);
  assert.deepEqual(summary.awesome, queries.map((query, index) => ({
    query, rank: index + 1, results: [{ rank: 7, title: 'Title 1/0' }],
  })));
  assert.ok(result.good[0].url && result.good[0].image && result.good[0].description);
  assert.doesNotMatch(logs.join('\n'), /https?:|"(?:url|image|description)"|Description|should-not-be-logged|test-.*-key/);

  await fetch(base + '/search?query=empty&goodCount=0&awesomeCount=0');
  assert.ok(logs[2].startsWith('[search #2] request '));
  assert.ok(logs[3].startsWith('[search #2] response '));
  const empty = JSON.parse(logs[3].slice('[search #2] response '.length));
  assert.deepEqual(empty.good, []);
  assert.deepEqual(empty.awesome, []);
});

test('search logs contain safe validation and upstream errors, ignoring other routes', async (t) => {
  const logs = [];
  const mock = mockUpstream({ serp: () => { throw new Error('private upstream url and key'); } });
  const base = await listen(t, { ...mock, searchLogger: (line) => logs.push(line) });
  await fetch(base + '/missing');
  assert.deepEqual(logs, []);
  for (const [path, options, status, error] of [
    ['/search', undefined, 400, 'query is required'],
    ['/search?query=art', { method: 'POST' }, 405, 'Method not allowed'],
    ['/search?query=art&awesomeCount=0', undefined, 502, 'SerpApi search failed'],
  ]) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, status);
    const summary = JSON.parse(logs.at(-1).slice(logs.at(-1).indexOf('response ') + 9));
    assert.equal(summary.status, status);
    assert.equal(summary.error, error);
  }
  assert.doesNotMatch(logs.join('\n'), /private upstream|test-.*-key/);
});

test('search logging is disabled unless a logger is supplied', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const base = await listen(t, mockUpstream());
  const response = await fetch(base + '/search?query=art&goodCount=1&awesomeQueryCount=1&awesomeCount=1');
  assert.equal(response.status, 200);
  assert.equal(log.mock.callCount(), 0);
});

test('omitted, empty and whitespace-only directions select afresh while explicit directions bypass randomness', async (t) => {
  const randomValues = [0, 0.5, 0.999999];
  let randomCalls = 0;
  t.mock.method(Math, 'random', () => randomValues[randomCalls++]);
  const mock = mockUpstream();
  const base = await listen(t, mock);
  for (const suffix of ['', '&awesomeDirection=', '&awesomeDirection=%20%20', '&awesomeDirection=%20custom%20']) {
    const response = await fetch(base + '/search?query=art&awesomeQueryCount=1' + suffix);
    assert.equal(response.status, 200);
  }
  assert.deepEqual(mock.openaiCalls.map(({ body }) => JSON.parse(body.input).direction), [
    AWESOME_DIRECTIONS[0],
    AWESOME_DIRECTIONS[10],
    AWESOME_DIRECTIONS[19],
    'custom',
  ]);
  assert.equal(randomCalls, 3);
});

test('direct searches can select all twenty directions without changing the original query', async (t) => {
  assert.equal(AWESOME_DIRECTIONS.length, 20);
  assert.equal(new Set(AWESOME_DIRECTIONS).size, 20);
  let index = 0;
  t.mock.method(Math, 'random', () => (index + 0.5) / 20);
  const mock = mockUpstream();
  for (; index < 20; index++) {
    await runSearch(mock, { goodCount: 0, awesomeQueryCount: 1 });
  }
  assert.deepEqual(mock.openaiCalls.map(({ body }) => JSON.parse(body.input)), AWESOME_DIRECTIONS.map((direction) => ({
    query: '인터랙티브 아트', direction, count: 1,
  })));
});

test('each omitted count defaults independently', async (t) => {
  const mock = mockUpstream();
  const base = await listen(t, mock);
  for (const [params, good, queries, perQuery] of [
    ['goodCount=1', 1, 10, 3],
    ['awesomeCount=1', 30, 10, 1],
    ['awesomeQueryCount=1', 30, 1, 3],
  ]) {
    const response = await fetch(base + '/search?query=art&' + params);
    const result = await response.json();
    assert.equal(result.good.length, good);
    assert.equal(Object.keys(result.awesome).length, queries);
    assert.ok(Object.values(result.awesome).every(({ results }) => results.length === perQuery));
  }
});

test('zero counts independently skip generation and all disabled search work', async (t) => {
  const mock = mockUpstream();
  const base = await listen(t, mock);
  for (const [good, count, queries, expectedSerp, expectedLlm] of [
    [0, 0, 10, 0, 0], [0, 3, 0, 0, 0], [0, 0, 0, 0, 0],
    [5, 0, 10, 1, 0], [5, 3, 0, 1, 0], [0, 3, 1, 1, 1],
  ]) {
    mock.serpCalls.length = 0;
    mock.openaiCalls.length = 0;
    const params = new URLSearchParams({
      query: 'art', goodCount: good, awesomeCount: count, awesomeQueryCount: queries,
    });
    const response = await fetch(base + '/search?' + params);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.good.length, good);
    assert.equal(mock.serpCalls.length, expectedSerp);
    assert.equal(mock.openaiCalls.length, expectedLlm);
    if (!expectedLlm) assert.deepEqual(result.awesome, {});
  }
});

test('invalid counts and request shapes are rejected before either provider is called', async (t) => {
  const mock = mockUpstream();
  const base = await listen(t, mock);
  for (const [name, max] of [['goodCount', 100], ['awesomeCount', 100], ['awesomeQueryCount', 20]]) {
    for (const value of ['', '-1', '1.5', String(max + 1), 'text', 'Infinity', '1e1', '0x10', ' ', '9007199254740993']) {
      const response = await fetch(base + '/search?query=art&' + name + '=' + encodeURIComponent(value));
      assert.equal(response.status, 400, name + '=' + JSON.stringify(value));
      assert.deepEqual(await response.json(), { error: name + ' must be an integer from 0 to ' + max });
    }
  }
  for (const path of ['/search', '/search?query=', '/search?query=%20%20']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'query is required' });
  }
  assert.equal((await fetch(base + '/deconstruct?url=https://example.com')).status, 404);
  const method = await fetch(base + '/search?query=art', { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET');
  assert.equal(mock.openaiCalls.length, 0);
  assert.equal(mock.serpCalls.length, 0);
});

test('each query finishes the first page before requesting the second page', { timeout: 2000 }, async () => {
  const started = deferred();
  const release = deferred();
  const firstPages = [];
  const mock = mockUpstream({
    serp: async (query, page) => {
      if (page === 1) {
        firstPages.push(query);
        if (firstPages.length === 2) started.resolve();
        await release.promise;
      }
      return { organic_results: rows(query, page) };
    },
  });
  const pending = runSearch(mock, { goodCount: 12, awesomeCount: 12, awesomeQueryCount: 1 });
  await started.promise;
  try {
    assert.deepEqual(mock.serpCalls.map(({ page }) => page), [1, 1]);
  } finally {
    release.resolve();
  }
  const result = await pending;
  for (const results of [result.good, result.awesome[queryNames(1)[0]].results]) {
    assert.deepEqual(results.map(({ rank }) => rank), Array.from({ length: 12 }, (_, i) => i + 1));
  }
});

test('query ranks remain LLM order when less similar queries finish first', async () => {
  const ready = deferred();
  const queries = ['意味が近い', 'another field', '먼 분야'];
  const finished = [];
  const mock = mockUpstream({
    queries,
    serp: async (query, page) => {
      if (query === queries[0]) await ready.promise;
      if (query === queries[2]) ready.resolve();
      finished.push(query);
      return { organic_results: rows(query, page) };
    },
  });
  const result = await runSearch(mock, { goodCount: 0, awesomeQueryCount: 3 });
  assert.notEqual(finished[0], queries[0]);
  assert.deepEqual(Object.keys(result.awesome), queries);
  assert.deepEqual(Object.values(result.awesome).map(({ rank }) => rank), [1, 2, 3]);
});

test('deduplicates only within each array, defaults fields and preserves document rank gaps', async () => {
  const common = 'https://example.com/common';
  const next = 'https://example.com/next';
  const mock = mockUpstream({
    serp: (_, page) => ({
      organic_results: page === 1 ? [
        null, {}, { link: '' }, { link: ' ' },
        { link: common, position: 5, title: 8, snippet: null, thumbnail: {} },
        { link: common, position: 6 },
        { link: next, position: 0 },
      ] : [
        { link: common, position: 1 },
        { link: 'https://example.com/last', position: 2 },
      ],
    }),
  });
  const result = await runSearch(mock, { goodCount: 15, awesomeCount: 15, awesomeQueryCount: 2 });
  for (const results of [result.good, ...Object.values(result.awesome).map((group) => group.results)]) {
    assert.deepEqual(results.map(({ rank }) => rank), [5, 7, 12]);
    assert.deepEqual(results.map(({ url }) => url), [common, next, 'https://example.com/last']);
    assert.deepEqual(results[0], { url: common, title: '', description: '', image: '', rank: 5 });
  }
});

test('accepts every organic row in a page but caps groups independently', async () => {
  const mock = mockUpstream({ serp: (query, page) => ({ organic_results: rows(query, page, 35) }) });
  const result = await runSearch(mock, { goodCount: 12, awesomeCount: 12, awesomeQueryCount: 2 });
  assert.equal(result.good.length, 12);
  assert.ok(Object.values(result.awesome).every(({ results }) => results.length === 12));
  assert.equal(mock.serpCalls.length, 3);
});

test('empty first pages stop collection without requesting later pages', async () => {
  const mock = mockUpstream({ serp: () => ({ organic_results: [] }) });
  const result = await runSearch(mock, { goodCount: 30, awesomeCount: 30, awesomeQueryCount: 2 });
  assert.deepEqual(result.good, []);
  assert.ok(Object.values(result.awesome).every(({ results }) => results.length === 0));
  assert.equal(mock.serpCalls.length, 3);
  assert.ok(mock.serpCalls.every(({ page }) => page === 1));
});

test('awesome preserves complete phrases with fresh verbatim first-page searches', async () => {
  const queries = ['오로라 관측 여행', '중세 아스트롤라베', 'medieval astrolabe'];
  const mock = mockUpstream({ queries });
  const result = await runSearch(mock, { goodCount: 0, awesomeCount: 2, awesomeQueryCount: queries.length });
  assert.equal(mock.serpCalls.length, queries.length);
  for (const [index, query] of queries.entries()) {
    const params = mock.serpCalls[index].url.searchParams;
    assert.equal(params.get('q'), query);
    assert.equal(params.get('hl'), 'ko');
    assert.equal(params.get('gl'), 'kr');
    assert.equal(params.get('no_cache'), 'true');
    assert.equal(params.get('tbs'), 'li:1');
    assert.equal(params.has('start'), false);
    assert.deepEqual(result.awesome[query].results.map(({ url }) => url), rows(query).slice(0, 2).map(({ link }) => link));
  }
});

test('does not search outside the requested top-page range to fill sparse results', async () => {
  const mock = mockUpstream({
    serp: (query, page) => ({
      organic_results: rows(query, page, 1),
      serpapi_pagination: { next: 'https://evil.example/?start=990' },
    }),
  });
  const result = await runSearch(mock, { goodCount: 35, awesomeCount: 12, awesomeQueryCount: 2 });
  assert.equal(result.good.length, 4);
  assert.ok(Object.values(result.awesome).every(({ results }) => results.length === 2));
  assert.equal(mock.serpCalls.length, 8);
  assert.ok(mock.serpCalls.every(({ query, page }) => page <= (query === '인터랙티브 아트' ? 4 : 2)));
});

test('normal empty search responses keep generated keys and ranks', async () => {
  const queries = queryNames(3);
  const mock = mockUpstream({
    queries,
    serp: (query) => query === queries[0] ? {
      search_metadata: { status: 'Success' },
      search_information: { organic_results_state: 'Fully empty' },
      error: "Google hasn't returned any results for this query.",
    } : {},
  });
  const result = await runSearch(mock, { awesomeQueryCount: 3 });
  assert.deepEqual(result.good, []);
  assert.deepEqual(result.awesome, Object.fromEntries(queries.map((query, index) => [
    query, { rank: index + 1, results: [] },
  ])));
});

test('search terms that name object properties remain safe distinct JSON keys', async (t) => {
  const queries = ['__proto__', 'constructor', 'toString'];
  const mock = mockUpstream({ queries });
  const base = await listen(t, mock);
  const response = await fetch(base + '/search?query=art&goodCount=0&awesomeQueryCount=3');
  assert.equal(response.status, 200);
  const { awesome } = await response.json();
  assert.deepEqual(Object.keys(awesome), queries);
  assert.deepEqual(Object.values(awesome).map(({ rank }) => rank), [1, 2, 3]);
  assert.equal(Object.getPrototypeOf(awesome), Object.prototype);
});

test('supports maximum counts with at most five concurrent SerpApi calls', async () => {
  let active = 0;
  let peak = 0;
  const mock = mockUpstream({
    serp: async (query, page) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(setImmediate);
      active--;
      return { organic_results: rows(query, page) };
    },
  });
  const result = await runSearch(mock, { goodCount: 100, awesomeCount: 100, awesomeQueryCount: 20 });
  assert.equal(result.good.length, 100);
  assert.equal(Object.keys(result.awesome).length, 20);
  assert.ok(Object.values(result.awesome).every(({ results }) => results.length === 100));
  assert.equal(mock.serpCalls.length, 210);
  assert.equal(mock.openaiCalls.length, 1);
  assert.equal(peak, 5);
  assert.equal(mock.openaiCalls[0].body.text.format.schema.properties.queries.minItems, 20);
});

test('starts good retrieval and query generation concurrently', { timeout: 2000 }, async () => {
  const started = deferred();
  const generated = deferred();
  const mock = mockUpstream({
    generate: async (body) => {
      await started.promise;
      generated.resolve();
      return llmBody(queryNames(JSON.parse(body.input).count));
    },
    serp: async (query, page) => {
      if (query === '인터랙티브 아트') {
        started.resolve();
        await generated.promise;
      }
      return { organic_results: rows(query, page) };
    },
  });
  const result = await runSearch(mock, { awesomeQueryCount: 1 });
  assert.equal(result.good.length, 30);
  assert.equal(Object.keys(result.awesome).length, 1);
});

test('LLM provider and schema errors return safe 502s without retries or awesome searches', async (t) => {
  const rawText = (text) => ({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  });
  const cases = {
    http: () => new Response(openaiApiKey, { status: 401 }),
    network: () => { throw new Error(openaiApiKey); },
    json: () => new Response('not json'),
    null: () => null,
    incomplete: () => ({ ...llmBody(queryNames(2)), status: 'incomplete' }),
    failed: () => ({ ...llmBody(queryNames(2)), status: 'failed', error: { message: openaiApiKey } }),
    missingOutput: () => ({ status: 'completed' }),
    refusal: () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }),
    malformedContent: () => ({ status: 'completed', output: [null, { type: 'message', content: null }] }),
    malformedText: () => rawText('not json'),
    extraKey: () => rawText(JSON.stringify({ queries: queryNames(2), extra: true })),
    wrongShape: () => rawText('[]'),
    missingQueries: () => rawText('{}'),
    wrongType: () => rawText('{"queries":"query"}'),
    wrongCount: () => llmBody(queryNames(1)),
    tooMany: () => llmBody(queryNames(3)),
    empty: () => llmBody(['valid', ' ']),
    nonString: () => llmBody(['valid', 42]),
    duplicate: () => llmBody(['same', ' same ']),
    original: () => llmBody([' art ', 'new query']),
  };
  for (const [name, generate] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const mock = mockUpstream({ generate });
      const base = await listen(t, mock);
      const response = await fetch(base + '/search?query=art&goodCount=0&awesomeQueryCount=2');
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'LLM query generation failed' });
      assert.equal(mock.openaiCalls.length, 1);
      assert.equal(mock.serpCalls.length, 0);
    });
  }
});

test('SerpApi failures still return their own safe 502 after successful generation', async (t) => {
  const cases = {
    http: () => new Response(apiKey, { status: 401 }),
    api: () => ({ error: apiKey }),
    metadata: () => ({ search_metadata: { status: 'Error' } }),
    json: () => new Response('not json'),
    null: () => null,
    array: () => [],
    shape: () => ({ organic_results: {} }),
    network: () => { throw new Error(apiKey); },
  };
  for (const [name, serp] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const mock = mockUpstream({ serp });
      const base = await listen(t, mock);
      const response = await fetch(base + '/search?query=art&goodCount=0&awesomeQueryCount=1');
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'SerpApi search failed' });
      assert.equal(mock.openaiCalls.length, 1);
    });
  }
});

test('a SerpApi failure cancels concurrent generation without masking the cause', async (t) => {
  const mock = mockUpstream({
    generate: (_, signal) => waitForAbort(signal),
    serp: () => new Response('failed', { status: 500 }),
  });
  const base = await listen(t, mock);
  const response = await fetch(base + '/search?query=art');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'SerpApi search failed' });
  assert.ok(mock.openaiCalls[0].signal.aborted);
});

test('an LLM failure cancels the active good request and prevents later pages', async (t) => {
  const started = deferred();
  const mock = mockUpstream({
    generate: async () => {
      await started.promise;
      return new Response('failed', { status: 500 });
    },
    serp: (_, __, signal) => {
      started.resolve();
      return waitForAbort(signal);
    },
  });
  const base = await listen(t, mock);
  const response = await fetch(base + '/search?query=art&goodCount=100');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'LLM query generation failed' });
  assert.equal(mock.serpCalls.length, 1);
  assert.ok(mock.serpCalls.every(({ signal }) => signal.aborted));
});

test('deadline before generation preserves completed good pages and returns no awesome keys', async (t) => {
  const mock = mockUpstream({
    generate: (_, signal) => waitForAbort(signal),
    serp: (query, page, signal) => page === 2
      ? waitForAbort(signal) : { organic_results: rows(query, page) },
  });
  const base = await listen(t, { ...mock, timeoutMs: 40 });
  const response = await fetch(base + '/search?query=art');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.awesome, {});
  assert.deepEqual(result.good.map(({ rank }) => rank), [
    ...Array.from({ length: 10 }, (_, i) => i + 1),
  ]);
  assert.deepEqual(mock.serpCalls.map(({ page }) => page), [1, 2]);
  assert.ok(mock.openaiCalls[0].signal.aborted);
  assert.ok(mock.serpCalls.every(({ signal }) => signal.aborted));
});

test('deadline after generation keeps every query rank, completed pages and cancels queued work', async (t) => {
  const queries = queryNames(7);
  const mock = mockUpstream({
    queries,
    serp: (query, page, signal) => query === queries[0] && page === 1
      ? { organic_results: rows(query, page) } : waitForAbort(signal),
  });
  const base = await listen(t, { ...mock, timeoutMs: 40 });
  const response = await fetch(base + '/search?query=art&goodCount=0&awesomeCount=12&awesomeQueryCount=7');
  assert.equal(response.status, 200);
  const { awesome } = await response.json();
  assert.deepEqual(Object.keys(awesome), queries);
  assert.deepEqual(Object.values(awesome).map(({ rank }) => rank), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(awesome[queries[0]].results.map(({ rank }) => rank), Array.from({ length: 10 }, (_, i) => i + 1));
  assert.ok(queries.slice(1).every((query) => awesome[query].results.length === 0));
  assert.equal(mock.serpCalls.length, 6);
  assert.ok(mock.serpCalls.every(({ signal }) => signal.aborted));
  await new Promise(setImmediate);
  assert.equal(mock.serpCalls.length, 6);
});

test('OpenAI startup requires the selected key and a valid port', () => {
  for (const [overrides, message] of [
    [{ SERPAPI_API_KEY: '' }, 'SERPAPI_API_KEY is required'],
    [{ OPENAI_API_KEY: '' }, 'OPENAI_API_KEY is required'],
    [{ OPENAI_API_KEY: '  ' }, 'OPENAI_API_KEY is required'],
    [{ PORT: 'invalid' }, 'PORT must be an integer'],
    [{ PORT: '0' }, 'PORT must be an integer'],
  ]) {
    const child = spawnSync(process.execPath, ['server.js'], {
      cwd: new URL('.', import.meta.url),
      env: { ...process.env, LLM_PROVIDER: 'openai', SERPAPI_API_KEY: apiKey, OPENAI_API_KEY: openaiApiKey, ...overrides },
      encoding: 'utf8',
    });
    assert.equal(child.status, 1);
    assert.ok(child.stderr.includes(message));
    assert.ok(!child.stderr.includes(apiKey) && !child.stderr.includes(openaiApiKey));
  }
});

test('Claude is the default and generates the same ranked search response without an OpenAI key', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const mock = mockUpstream();
  const result = await search('인터랙티브 아트', { apiKey, anthropicApiKey, ...mock });
  assert.equal(result.good.length, 30);
  assert.equal(Object.keys(result.awesome).length, 10);
  assert.deepEqual(Object.values(result.awesome).map(({ rank }) => rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(Object.values(result.awesome).every(({ results }) => results.length === 3));
  assert.equal(mock.serpCalls.length, 13);
  assert.equal(mock.openaiCalls.length, 0);
  assert.equal(mock.anthropicCalls.length, 1);
  const { url, method, headers, body } = mock.anthropicCalls[0];
  assert.equal(url.pathname, '/v1/messages');
  assert.equal(method, 'POST');
  assert.equal(headers['x-api-key'], anthropicApiKey);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.messages[0].role, 'user');
  assert.deepEqual(JSON.parse(body.messages[0].content), {
    query: '인터랙티브 아트', direction: AWESOME_DIRECTIONS[0], count: 10,
  });
  assert.match(body.system, /semantic similarity.*closest first/);
  assert.match(body.system, /first query should be relatively close/);
  assert.match(body.system, /final query should look almost entirely unrelated/);
  assert.match(body.system, /If count is 1, prioritize one bold/);
  assert.doesNotMatch(body.system, /original query language/);
  const format = body.output_config.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.schema.additionalProperties, false);
  assert.equal(format.schema.properties.queries.minItems, 1);
  assert.ok(!Object.hasOwn(format.schema.properties.queries, 'maxItems'));
  assert.match(format.schema.properties.queries.description, /Exactly 10/);
});

test('Claude configuration preserves direction, model override and independent query/document ranks', async (t) => {
  const ready = deferred();
  const queries = [' 가까운 관점 ', '먼 관점'];
  const mock = mockUpstream({
    queries,
    serp: async (query) => {
      if (query === '가까운 관점') await ready.promise;
      else ready.resolve();
      return { organic_results: [{ link: 'https://example.com/shared', position: 7 }] };
    },
  });
  const base = await listen(t, {
    ...mock, llmProvider: 'anthropic', anthropicModel: 'custom-claude', openaiApiKey: undefined,
  });
  const params = new URLSearchParams({
    query: ' 아트 ', awesomeDirection: ' 과거 관점 ', goodCount: '0',
    awesomeQueryCount: '2', awesomeCount: '1',
  });
  const response = await fetch(base + '/search?' + params);
  assert.equal(response.status, 200);
  const { awesome } = await response.json();
  assert.deepEqual(Object.keys(awesome), ['가까운 관점', '먼 관점']);
  assert.deepEqual(Object.values(awesome).map(({ rank, results }) => [rank, results[0].rank]), [[1, 7], [2, 7]]);
  assert.equal(mock.anthropicCalls[0].body.model, 'custom-claude');
  assert.deepEqual(JSON.parse(mock.anthropicCalls[0].body.messages[0].content), {
    query: '아트', direction: '과거 관점', count: 2,
  });
  assert.equal(mock.openaiCalls.length, 0);
});

test('Claude is skipped when either awesome count is zero', async (t) => {
  const mock = mockUpstream();
  const base = await listen(t, { ...mock, llmProvider: 'anthropic', anthropicApiKey: undefined });
  for (const suffix of ['awesomeQueryCount=0', 'awesomeCount=0']) {
    const response = await fetch(base + '/search?query=art&goodCount=0&' + suffix);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { good: [], awesome: {} });
  }
  assert.equal(mock.anthropicCalls.length, 0);
  assert.equal(mock.openaiCalls.length, 0);
  assert.equal(mock.serpCalls.length, 0);
});

test('Claude failures use the common safe error with no automatic provider fallback', async (t) => {
  const rawText = (text) => ({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  const cases = {
    http: () => new Response(anthropicApiKey, { status: 401 }),
    rateLimit: () => new Response(anthropicApiKey, { status: 429 }),
    network: () => { throw new Error(anthropicApiKey); },
    json: () => new Response('not json'),
    null: () => null,
    apiError: () => ({ ...anthropicBody(queryNames(2)), error: { message: anthropicApiKey } }),
    wrongType: () => ({ ...anthropicBody(queryNames(2)), type: 'error' }),
    truncated: () => ({ ...anthropicBody(queryNames(2)), stop_reason: 'max_tokens' }),
    refusal: () => ({ ...anthropicBody(queryNames(2)), stop_reason: 'refusal' }),
    toolUse: () => ({ ...anthropicBody(queryNames(2)), stop_reason: 'tool_use' }),
    missingContent: () => ({ type: 'message', stop_reason: 'end_turn' }),
    invalidContent: () => ({ type: 'message', stop_reason: 'end_turn', content: {} }),
    emptyContent: () => ({ type: 'message', stop_reason: 'end_turn', content: [null, { type: 'text', text: 42 }] }),
    missingText: () => ({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Only thinking' }] }),
    malformedText: () => rawText('not json'),
    wrongCount: () => anthropicBody(queryNames(1)),
    tooMany: () => anthropicBody(queryNames(3)),
    emptyQuery: () => anthropicBody(['valid', ' ']),
    nonString: () => anthropicBody(['valid', 42]),
    duplicate: () => anthropicBody(['same', ' same ']),
    original: () => anthropicBody([' art ', 'new query']),
    extraKey: () => rawText(JSON.stringify({ queries: queryNames(2), extra: true })),
  };
  for (const [name, generate] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const mock = mockUpstream({ generate });
      const base = await listen(t, { ...mock, llmProvider: 'anthropic' });
      const response = await fetch(base + '/search?query=art&goodCount=0&awesomeQueryCount=2');
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'LLM query generation failed' });
      assert.equal(mock.anthropicCalls.length, 1);
      assert.equal(mock.openaiCalls.length, 0);
      assert.equal(mock.serpCalls.length, 0);
    });
  }
});

test('invalid provider or missing selected key fails without using another provider', async (t) => {
  for (const options of [
    { llmProvider: 'other' },
    { llmProvider: '__proto__' },
    { llmProvider: 'anthropic', anthropicApiKey: undefined },
    { llmProvider: 'openai', openaiApiKey: undefined },
  ]) {
    await t.test(JSON.stringify(options), async (t) => {
      const mock = mockUpstream();
      const base = await listen(t, { ...mock, ...options });
      const response = await fetch(base + '/search?query=art&goodCount=0');
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'LLM query generation failed' });
      assert.equal(mock.anthropicCalls.length + mock.openaiCalls.length + mock.serpCalls.length, 0);
    });
  }
});

test('deadline cancels Claude generation and keeps completed good documents', async (t) => {
  const mock = mockUpstream({ generate: (_, signal) => waitForAbort(signal) });
  const base = await listen(t, { ...mock, llmProvider: 'anthropic', timeoutMs: 40 });
  const response = await fetch(base + '/search?query=art');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.good.length, 30);
  assert.deepEqual(result.awesome, {});
  assert.ok(mock.anthropicCalls[0].signal.aborted);
  assert.equal(mock.openaiCalls.length, 0);
});

test('startup selects provider and only requires its API key', () => {
  for (const [overrides, message] of [
    [{ LLM_PROVIDER: '', ANTHROPIC_API_KEY: '' }, 'ANTHROPIC_API_KEY is required'],
    [{ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: ' ' }, 'ANTHROPIC_API_KEY is required'],
    [{ LLM_PROVIDER: 'openai', OPENAI_API_KEY: '' }, 'OPENAI_API_KEY is required'],
    [{ LLM_PROVIDER: 'other' }, 'LLM_PROVIDER must be anthropic or openai'],
    [{ LLM_PROVIDER: '__proto__' }, 'LLM_PROVIDER must be anthropic or openai'],
    [{ LLM_PROVIDER: 'anthropic', OPENAI_API_KEY: '', PORT: 'invalid' }, 'PORT must be an integer'],
    [{ LLM_PROVIDER: 'openai', ANTHROPIC_API_KEY: '', PORT: 'invalid' }, 'PORT must be an integer'],
    [{ LLM_PROVIDER: ' ', OPENAI_API_KEY: '', PORT: 'invalid' }, 'PORT must be an integer'],
  ]) {
    const child = spawnSync(process.execPath, ['server.js'], {
      cwd: new URL('.', import.meta.url),
      env: {
        ...process.env, SERPAPI_API_KEY: apiKey, ANTHROPIC_API_KEY: anthropicApiKey,
        OPENAI_API_KEY: openaiApiKey, ...overrides,
      },
      encoding: 'utf8',
    });
    assert.equal(child.status, 1);
    assert.ok(child.stderr.includes(message), child.stderr);
    assert.ok(!child.stderr.includes(anthropicApiKey) && !child.stderr.includes(openaiApiKey));
  }
});
