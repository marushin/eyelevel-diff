import { createServer, request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, extname } from 'node:path';
import { DEFAULT_LLM_PROVIDER, LLM_PROVIDERS, QueryGenerationError, generateQueries } from './llm.js';
import {
  UnsafeUrlError,
  inspectOrRenderPreview,
  unwrapDirectGoogleRedirectParam,
} from './preview.js';
import { createRemoteBrowserManager } from './remote-browser.js';
import { upgradeWebSocket } from './ws-frame.js';

const COUNT_PARAMETERS = {
  goodCount: { defaultValue: 30, max: 100 },
  awesomeCount: { defaultValue: 3, max: 100 },
  awesomeQueryCount: { defaultValue: 10, max: 20 },
};
export const AWESOME_DIRECTIONS = Object.freeze([
  '생물의 적응·공생·기생을 출발점으로 원문을 재해석하고, 생명 밖의 뜻밖의 개념으로 도약하라.',
  '먼 과거의 도구·의례·생활방식에서 원문의 낯선 대응물을 찾고, 잊힌 관습을 따라 도약하라.',
  '원문이 사라지거나 완전히 쓸모없어진 미래를 상상하고, 그때 남을 현상과 기술로 도약하라.',
  '원문의 목적과 수단, 원인과 결과를 뒤집고, 반대 원리로 작동하는 실제 사례로 도약하라.',
  '원문의 실패·오류·고장·부작용을 출발점으로 삼아, 오작동이 새로운 기능이 되는 세계로 도약하라.',
  '눈에 보이는 대상 대신 소리·촉각·냄새·맛·균형감각으로 원문을 옮기고, 감각 간 대응을 따라 도약하라.',
  '원문을 미생물·세포·분자 수준으로 축소해 바라보고, 작은 규모에서만 드러나는 원리로 도약하라.',
  '원문을 도시·행성·우주 규모로 확대해 바라보고, 거대한 규모에서 나타나는 현상으로 도약하라.',
  '원문을 쓰레기·폐기물·잔해·부산물의 관점에서 바라보고, 버려진 것이 순환하는 경로로 도약하라.',
  '원문 뒤에 숨은 운송·저장·배관·표준·유지보수에서 시작해, 보이지 않는 기반시설로 도약하라.',
  '원문을 소유하는 자와 배제되는 자, 규칙과 통제의 관점에서 재해석하고, 권력의 작동 방식으로 도약하라.',
  '원문을 선물·교환·빚·희소성의 관점에서 재해석하고, 뜻밖의 경제적 관습과 거래 방식으로 도약하라.',
  '원문을 놀이·속임수·위장·모방의 관점에서 바라보고, 진짜와 가짜의 경계를 넘나들며 도약하라.',
  '원문을 신화·금기·장례·통과의례의 관점에서 재해석하고, 서로 먼 문화의 실제 관습으로 도약하라.',
  '원문을 확률·우연·잡음·예측 불가능성의 관점에서 바라보고, 통제가 무너질 때 생기는 현상으로 도약하라.',
  '원문에서 경계·틈·문턱·접촉면을 찾아 출발하고, 서로 다른 세계가 만날 때 생기는 현상으로 도약하라.',
  '원문을 리듬·주기·지연·동기화의 관점에서 재해석하고, 시간을 조직하는 뜻밖의 현상으로 도약하라.',
  '원문을 기억·망각·흔적·복원의 관점에서 바라보고, 부재한 것이 남기는 실제 증거로 도약하라.',
  '원문의 겉모습 대신 재료의 변형·마찰·균열·상전이를 따라가며, 물질의 성질이 바뀌는 지점으로 도약하라.',
  '원문의 중심 대신 주변부·예외·소수 사례를 출발점으로 삼고, 통념을 깨는 실제 현상으로 도약하라.',
]);
const EMPTY_RESULTS_ERROR = "Google hasn't returned any results for this query.";

function limitConcurrency(limit, signal) {
  let active = 0;
  const queue = [];
  signal.addEventListener('abort', () => {
    for (const job of queue.splice(0)) job.reject(signal.reason);
  }, { once: true });

  function drain() {
    while (!signal.aborted && active < limit && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return task();
      }).then(resolve, reject).finally(() => {
        active--;
        drain();
      });
    }
  }

  return (task) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    queue.push({ task, resolve, reject });
    drain();
  });
}

function collectResults(pages, target, limit) {
  target.length = 0;
  const seenUrls = new Set();
  for (const [page, data] of [...pages].sort(([a], [b]) => a - b)) {
    for (const [index, row] of (data.organic_results ?? []).entries()) {
      if (target.length === limit) return;
      if (typeof row?.link !== 'string' || !row.link.trim() || seenUrls.has(row.link)) continue;
      seenUrls.add(row.link);
      target.push({
        url: row.link,
        title: typeof row.title === 'string' ? row.title : '',
        description: typeof row.snippet === 'string' ? row.snippet : '',
        image: typeof row.thumbnail === 'string' ? row.thumbnail : '',
        rank: (page - 1) * 10
          + (Number.isInteger(row.position) && row.position > 0 ? row.position : index + 1),
      });
    }
  }
}

export async function search(query, {
  apiKey,
  llmProvider = DEFAULT_LLM_PROVIDER,
  anthropicApiKey,
  anthropicModel,
  openaiApiKey,
  openaiModel,
  goodCount = COUNT_PARAMETERS.goodCount.defaultValue,
  awesomeCount = COUNT_PARAMETERS.awesomeCount.defaultValue,
  awesomeQueryCount = COUNT_PARAMETERS.awesomeQueryCount.defaultValue,
  awesomeDirection = '',
  fetchImpl = globalThis.fetch,
  lookupImpl,
  timeoutMs = 120_000,
  signal: requestSignal,
} = {}) {
  const result = { good: [], awesome: {} };
  const awesomeEnabled = awesomeCount > 0 && awesomeQueryCount > 0;
  if (goodCount === 0 && !awesomeEnabled) return result;

  const controller = new AbortController();
  const { signal } = controller;
  const abortRequest = () => controller.abort(requestSignal.reason);
  if (requestSignal?.aborted) abortRequest();
  else requestSignal?.addEventListener('abort', abortRequest, { once: true });
  const runSerp = limitConcurrency(5, signal);
  const good = { query, count: goodCount, pages: new Map(), results: result.good };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  async function fetchPage(searchQuery, page) {
    const url = new URL('https://serpapi.com/search.json');
    url.search = new URLSearchParams({
      engine: 'google', q: searchQuery, hl: 'ko', gl: 'kr', tbs: 'li:1', no_cache: 'true', api_key: apiKey,
      ...(page > 1 ? { start: String((page - 1) * 10) } : {}),
    }).toString();
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error('SerpApi HTTP error');
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid SerpApi response');
    }
    const emptySuccess = data.search_metadata?.status === 'Success'
      && data.search_information?.organic_results_state === 'Fully empty'
      && data.error === EMPTY_RESULTS_ERROR;
    if ((data.error && !emptySuccess) || data.search_metadata?.status === 'Error') {
      throw new Error('SerpApi search error');
    }
    if (data.organic_results !== undefined && !Array.isArray(data.organic_results)) {
      throw new Error('Invalid SerpApi organic results');
    }
    if (Array.isArray(data.organic_results)) {
      for (const row of data.organic_results) {
        if (row && typeof row.link === 'string') {
          row.link = unwrapDirectGoogleRedirectParam(row.link.trim());
        }
      }
    }
    return data;
  }

  async function fetchGroup(group) {
    for (let page = 1; page <= Math.ceil(group.count / 10); page++) {
      const data = await runSerp(() => fetchPage(group.query, page));
      signal.throwIfAborted();
      group.pages.set(page, data);
      collectResults(group.pages, group.results, group.count);
      if (group.results.length === group.count || !data.organic_results?.length) break;
    }
  }

  async function fetchAwesome() {
    if (!awesomeEnabled) return;
    const queries = await generateQueries(query, {
      llmProvider, anthropicApiKey, anthropicModel, openaiApiKey, openaiModel, awesomeQueryCount,
      awesomeDirection: awesomeDirection.trim() || AWESOME_DIRECTIONS[Math.floor(Math.random() * AWESOME_DIRECTIONS.length)],
      fetchImpl, signal,
    });
    signal.throwIfAborted();
    // fromEntries safely supports search terms such as "__proto__".
    result.awesome = Object.fromEntries(queries.map((value, index) => [
      value, { rank: index + 1, results: [] },
    ]));
    const awesomeGroups = queries.map((value) => ({
      query: value, count: awesomeCount, pages: new Map(), results: result.awesome[value].results,
    }));
    await Promise.all(awesomeGroups.map(fetchGroup));
  }

  try {
    await Promise.all([fetchGroup(good), fetchAwesome()]);
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener('abort', abortRequest);
    controller.abort();
  }
  return result;
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

const STATIC_FILES = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/API_SPEC.html', ['API_SPEC.html', 'text/html; charset=utf-8']],
]);

async function serveStatic(request, response, [file, contentType]) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(response, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
  }
  try {
    const body = await readFile(new URL(file, import.meta.url));
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    json(response, 500, { error: 'Unable to load frontend asset' });
  }
}

const FRONTEND_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function serveFrontend(request, response, pathname, frontendDir) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return json(response, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
  }
  try {
    const decoded = decodeURIComponent(pathname);
    // Only the entry point and Vite's generated assets are public.
    if (decoded !== '/' && decoded !== '/index.html' && !decoded.startsWith('/assets/')) {
      return json(response, 404, { error: 'Not found' });
    }
    if (decoded.includes('\\') || decoded.includes('\0') ||
        decoded.split('/').some(part => part === '..' || part.startsWith('.'))) {
      return json(response, 404, { error: 'Not found' });
    }
    const root = await realpath(frontendDir);
    const file = await realpath(resolve(root, decoded === '/' ? 'index.html' : decoded.slice(1)));
    const child = relative(root, file);
    const contentType = FRONTEND_TYPES[extname(file)];
    if (child.startsWith('..') || isAbsolute(child) || !contentType) {
      return json(response, 404, { error: 'Not found' });
    }
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': contentType, 'Content-Length': body.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error instanceof URIError || ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
      return json(response, 404, { error: 'Not found' });
    }
    return json(response, 500, { error: 'Unable to load frontend asset' });
  }
}

const DECONSTRUCT_ROUTES = new Set(['/deconstruct', '/deconstruct/phrases']);

/** Forwards only the public routes, so the service's health and debug routes stay private. */
function proxyDeconstruct(request, response, pathname, search, origin) {
  if (request.method !== 'GET') {
    return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET만 허용합니다.' } }, { Allow: 'GET' });
  }
  const upstream = httpRequest(new URL(`${pathname}${search}`, origin), {
    method: 'GET',
    headers: { Accept: 'application/json', ...(request.headers['accept-encoding'] ? { 'Accept-Encoding': request.headers['accept-encoding'] } : {}) },
  }, (reply) => {
    const headers = { 'Content-Type': reply.headers['content-type'] ?? 'application/json; charset=utf-8' };
    if (reply.headers['content-encoding']) headers['Content-Encoding'] = reply.headers['content-encoding'];
    if (reply.headers.vary) headers.Vary = reply.headers.vary;
    response.writeHead(reply.statusCode ?? 502, headers);
    reply.pipe(response);
  });
  upstream.once('error', () => {
    if (response.headersSent) return response.destroy();
    if (!response.destroyed) json(response, 502, { error: { code: 'DECONSTRUCT_UNAVAILABLE', message: '분해 서버에 연결하지 못했습니다.' } });
  });
  response.once('close', () => { if (!response.writableEnded) upstream.destroy(); });
  upstream.end();
}

async function handlePreviewRequest(request, response, url, options) {
  if (request.method !== 'GET') {
    return json(response, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }
  const targetUrl = url.searchParams.get('url')?.trim();
  if (!targetUrl) {
    return json(response, 400, { error: 'url is required' });
  }
  const mode = url.searchParams.get('mode')?.trim() || 'html';
  if (mode !== 'inspect' && mode !== 'html') {
    return json(response, 400, { error: 'mode must be inspect or html' });
  }
  const controller = new AbortController();
  const abortRequest = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.once('close', abortRequest);
  try {
    const result = await inspectOrRenderPreview(targetUrl, {
      mode,
      fetchImpl: options.fetchImpl,
      lookupImpl: options.lookupImpl,
      signal: controller.signal,
    });
    if (response.destroyed) return;
    if (result.kind === 'json') {
      return json(response, 200, result.body, {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    }
    const body = Buffer.from(result.html, 'utf8');
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src * data: blob: 'unsafe-inline'; script-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self'",
    });
    response.end(body);
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof UnsafeUrlError) {
      return json(response, 400, { error: error.message });
    }
    return json(response, 502, { error: 'Preview unavailable' });
  } finally {
    response.removeListener('close', abortRequest);
  }
}

export function createSearchServer(options = {}) {
  const remoteBrowser = createRemoteBrowserManager({
    chromeExecutable: options.chromeExecutable,
    lookupImpl: options.lookupImpl,
    fetchImpl: options.fetchImpl,
    sessionFactory: options.remoteSessionFactory,
    allowLoopbackForTest: options.__allowLoopbackForTest === true,
  });
  let nextRequestId = 0;

  const server = createServer(async (request, response) => {
    let logResponse;
    const send = (status, body, headers) => {
      logResponse?.(status, body);
      return json(response, status, body, headers);
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (DECONSTRUCT_ROUTES.has(url.pathname) && options.deconstructOrigin) {
        return proxyDeconstruct(request, response, url.pathname, url.search, options.deconstructOrigin);
      }
      if (url.pathname === '/preview') {
        return await handlePreviewRequest(request, response, url, options);
      }
      if (url.pathname !== '/search' && options.frontendDir) {
        return await serveFrontend(request, response, url.pathname, options.frontendDir);
      }
      if (STATIC_FILES.has(url.pathname)) return await serveStatic(request, response, STATIC_FILES.get(url.pathname));
      if (url.pathname !== '/search') return send(404, { error: 'Not found' });
      if (options.searchLogger) {
        const requestId = ++nextRequestId;
        const startedAt = Date.now();
        const parameters = Object.fromEntries(['query', 'awesomeDirection', ...Object.keys(COUNT_PARAMETERS)]
          .filter((name) => url.searchParams.has(name))
          .map((name) => [name, url.searchParams.get(name)]));
        options.searchLogger(`[search #${requestId}] request ${JSON.stringify({ method: request.method, ...parameters })}`);
        logResponse = (status, body) => {
          const summary = status === 200 ? {
            good: body.good.map(({ rank, title }) => ({ rank, title })),
            awesome: Object.entries(body.awesome)
              .sort(([, a], [, b]) => a.rank - b.rank)
              .map(([query, { rank, results }]) => ({
                query, rank, results: results.map(({ rank, title }) => ({ rank, title })),
              })),
          } : { error: body.error };
          options.searchLogger(`[search #${requestId}] response ${JSON.stringify({
            status, durationMs: Date.now() - startedAt, ...summary,
          }, null, 2)}`);
        };
      }
      if (request.method !== 'GET') {
        return send(405, { error: 'Method not allowed' }, { Allow: 'GET' });
      }
      const query = url.searchParams.get('query')?.trim();
      if (!query) return send(400, { error: 'query is required' });
      const counts = {};
      for (const [name, { defaultValue, max }] of Object.entries(COUNT_PARAMETERS)) {
        const raw = url.searchParams.get(name);
        if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) > max)) {
          return send(400, { error: name + ' must be an integer from 0 to ' + max });
        }
        counts[name] = raw === null ? defaultValue : Number(raw);
      }
      const awesomeDirection = url.searchParams.get('awesomeDirection')?.trim() || '';
      const controller = new AbortController();
      const abortRequest = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', abortRequest);
      try {
        const result = await search(query, { ...options, ...counts, awesomeDirection, signal: controller.signal });
        if (!response.destroyed) send(200, result);
      } finally {
        response.removeListener('close', abortRequest);
      }
    } catch (error) {
      if (response.destroyed) return;
      send(502, {
        error: error instanceof QueryGenerationError ? error.message : 'SerpApi search failed',
      });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/preview-ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ws = upgradeWebSocket(request, socket, head);
    if (!ws) return;
    void remoteBrowser.attachWebSocketClient(ws, url.searchParams);
  });

  server.once('close', () => {
    void remoteBrowser.shutdown();
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  const llmProvider = process.env.LLM_PROVIDER?.trim() || DEFAULT_LLM_PROVIDER;
  const providerConfig = Object.hasOwn(LLM_PROVIDERS, llmProvider) ? LLM_PROVIDERS[llmProvider] : null;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const anthropicModel = process.env.ANTHROPIC_MODEL?.trim() || LLM_PROVIDERS.anthropic.defaultModel;
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  const openaiModel = process.env.OPENAI_MODEL?.trim() || LLM_PROVIDERS.openai.defaultModel;
  const port = Number(process.env.PORT ?? 3000);
  const startupError = !apiKey ? 'SERPAPI_API_KEY is required'
    : !providerConfig ? 'LLM_PROVIDER must be anthropic or openai'
      : !process.env[providerConfig.apiKeyEnv]?.trim() ? providerConfig.apiKeyEnv + ' is required'
        : !Number.isInteger(port) || port < 1 || port > 65535
          ? 'PORT must be an integer from 1 to 65535' : null;
  if (startupError) {
    console.error(startupError);
    process.exitCode = 1;
  } else {
    const server = createSearchServer({
      apiKey, llmProvider, anthropicApiKey, anthropicModel, openaiApiKey, openaiModel,
    });
    server.on('error', (error) => {
      console.error('Server failed to start: ' + (error.code ?? 'unknown error'));
      process.exitCode = 1;
    });
    server.listen(port, () => console.log('Query API listening on http://localhost:' + port));
  }
}
