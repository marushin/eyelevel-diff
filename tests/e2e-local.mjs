#!/usr/bin/env node
/**
 * 실제 Chrome으로 로컬 백엔드를 끝까지 확인한다. 네트워크와 시스템 Chrome이 필요하다.
 *
 *   pnpm test:e2e              헤드리스, 임시 프로필(Gemini Nano 없음 → 대체 경로 확인)
 *   pnpm test:e2e --headed     창을 띄움
 *   pnpm test:e2e --profile    .chrome-profile 사용(그 프로필에 받은 Nano·임베딩 모델을 씀)
 *
 * 각 단계는 원본 API 명세와 같은 응답 모양인지 검사한다.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build, createServer, preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const port = Number(process.env.E2E_PORT ?? 5199);
const chromePath = process.env.CHROME_PATH ?? (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const useProfile = args.has('--profile');
const profile = useProfile ? join(root, '.chrome-profile') : mkdtempSync(join(tmpdir(), 'eyelevel-e2e-'));
const QUERY = process.env.E2E_QUERY ?? '고구마';
const PAGE = process.env.E2E_PAGE ?? 'https://ko.wikipedia.org/wiki/%EA%B3%A0%EA%B5%AC%EB%A7%88';

// --build: 압축된 빌드 결과물로 검사한다(iframe에 문자열로 넣는 수집 함수가 압축 뒤에도 동작하는지).
const viteOptions = { root: join(root, 'apps', 'web'), configFile: join(root, 'apps', 'web', 'vite.config.ts'), logLevel: 'warn' };
let server;
if (args.has('--build')) {
  await build(viteOptions);
  server = await preview({ ...viteOptions, preview: { port, strictPort: true } });
} else {
  server = await createServer({ ...viteOptions, server: { port, strictPort: true, hmr: false, watch: null } });
  await server.listen();
}

// Playwright가 직접 띄우면 OptimizationHints·컴포넌트 업데이트를 꺼서 Gemini Nano가 동작하지 않는다.
// 그래서 pnpm local과 같은 인자로 Chrome을 띄우고 CDP로 붙는다.
const { CHROME_FLAGS } = await import('../scripts/chrome-flags.mjs');
const debugPort = Number(process.env.E2E_DEBUG_PORT ?? 9333);
const chromeProcess = spawn(chromePath, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${debugPort}`,
  '--window-size=1440,900',
  ...(args.has('--headed') ? [] : ['--headless=new']),
  ...CHROME_FLAGS,
  'about:blank',
], { stdio: 'ignore' });
let browser;
for (let attempt = 0; attempt < 50 && !browser; attempt += 1) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
if (!browser) throw new Error('Chrome에 연결하지 못했습니다');
const context = browser.contexts()[0];

const results = [];
const only = process.env.E2E_ONLY?.split(',').map((item) => item.trim()).filter(Boolean);
async function step(name, fn) {
  if (only?.length && !only.some((item) => name.includes(item))) return;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`✓ ${name} (${Date.now() - started}ms)${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: String(error?.message ?? error) });
    console.log(`✗ ${name} — ${error?.stack ?? error}`);
  }
}

try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()) || message.text().startsWith('[local]')) console.log(`  [console.${message.type()}] ${message.text().slice(0, 400)}`);
  });
  page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 500) console.log(`  [http ${response.status()}] ${response.url().slice(0, 200)}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

  const getJson = (path) => page.evaluate(async (target) => {
    const response = await fetch(target);
    return { status: response.status, body: await response.json() };
  }, path);

  await step('진단: 다른 출처 읽기와 Prompt API', async () => {
    const info = await page.evaluate(async () => {
      const cors = await fetch('https://www.bing.com/robots.txt').then(() => true, () => false);
      const lm = globalThis.LanguageModel;
      const availability = lm ? await lm.availability({ expectedInputs: [{ type: 'text' }] }).catch((e) => `error:${e.message}`) : 'no-api';
      return { cors, availability };
    });
    assert.equal(info.cors, true, 'CORS가 꺼져 있어야 합니다');
    return `Prompt API: ${info.availability}`;
  });

  if (args.has('--download-nano')) {
    // 모델이 없으면 create()에 사용자 활성화가 필요하다. 상태 패널의 '받기' 버튼을 실제로 클릭한다.
    await step('Gemini Nano 모델 받기', async () => {
      const availability = () => page.evaluate(() => globalThis.LanguageModel?.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }));
      let state = await availability();
      if (state === 'downloadable') {
        await page.locator('.local-status summary').click();
        await page.locator('.local-status-row', { hasText: 'Gemini Nano' }).locator('button').click();
      }
      const deadline = Date.now() + 40 * 60_000;
      while (state !== 'available' && Date.now() < deadline) {
        await page.waitForTimeout(10_000);
        state = await availability();
        console.log(`  Nano: ${state} ${await page.locator('.local-status-row', { hasText: 'Gemini Nano' }).locator('.local-status-value').textContent()}`);
      }
      assert.equal(state, 'available');
      const image = await page.evaluate(() => globalThis.LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }));
      return `text ${state}, image ${image}`;
    });

    await step('번역 모델 받기 (영→한)', async () => {
      const availability = () => page.evaluate(() => globalThis.Translator?.availability({ sourceLanguage: 'en', targetLanguage: 'ko' }) ?? 'no-api');
      let state = await availability();
      if (state === 'downloadable') {
        if (!(await page.locator('.local-status').getAttribute('open'))) await page.locator('.local-status summary').click();
        await page.locator('.local-status-row', { hasText: '번역' }).locator('button').click();
      }
      const deadline = Date.now() + 10 * 60_000;
      while (state !== 'available' && state !== 'no-api' && state !== 'unavailable' && Date.now() < deadline) {
        await page.waitForTimeout(5_000);
        state = await availability();
      }
      const sample = state === 'available'
        ? await page.evaluate(async () => (await Translator.create({ sourceLanguage: 'en', targetLanguage: 'ko' })).translate('sweet potato fields at dawn'))
        : '';
      return `${state}${sample ? ` — "${sample}"` : ''}`;
    });
  }

  await step('/search', async () => {
    const { status, body } = await getJson(`/search?query=${encodeURIComponent(QUERY)}&goodCount=10&awesomeQueryCount=4&awesomeCount=3`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body.good) && body.good.length > 0, 'good 결과가 있어야 합니다');
    for (const row of body.good) {
      assert.match(row.url, /^https?:\/\//);
      assert.equal(typeof row.title, 'string');
      assert.ok(Number.isInteger(row.rank) && row.rank > 0);
    }
    const groups = Object.entries(body.awesome);
    assert.equal(groups.length, 4, 'awesome 검색어 4개');
    assert.deepEqual(groups.map(([, group]) => group.rank).sort(), [1, 2, 3, 4]);
    return `good ${body.good.length}개, awesome: ${groups.map(([query, group]) => `${query}(${group.results.length})`).join(', ')}`;
  });

  await step('/preview inspect', async () => {
    const { status, body } = await getJson(`/preview?mode=inspect&url=${encodeURIComponent(PAGE)}`);
    assert.equal(status, 200);
    assert.ok(['iframe', 'proxy', 'fallback'].includes(body.mode));
    return `${body.mode} ${body.reason ?? ''}`.trim();
  });

  let fragment = '';
  await step('/deconstruct', async () => {
    const { status, body } = await getJson(`/deconstruct?url=${encodeURIComponent(PAGE)}&query=${encodeURIComponent(QUERY)}`);
    assert.equal(status, 200, JSON.stringify(body));
    const n = body.contents.length;
    assert.ok(n > 5, `조각이 충분해야 합니다 (${n})`);
    assert.equal(body.weights.length, (n * (n - 1)) / 2, 'weights는 모든 쌍');
    for (const [i, j, w] of body.weights.slice(0, 500)) assert.ok(i < j && j < n && w >= 0 && w <= 1);
    assert.equal(body.querySimilarities.length, n);
    const images = body.contents.filter((item) => item.type === 'img');
    fragment = body.contents.filter((item) => item.type === 'text').map((item) => item.content).sort((a, b) => b.length - a.length)[0] ?? '';
    return `조각 ${n}개(이미지 ${images.length}, label ${images.filter((item) => item.label).length}), 간선 ${body.weights.length}`;
  });

  await step('/deconstruct/phrases', async () => {
    const text = fragment.slice(0, 300) || '고구마는 메꽃과의 여러해살이 식물이며, 덩이뿌리를 먹는다.';
    const { status, body } = await getJson(`/deconstruct/phrases?text=${encodeURIComponent(text)}&query=${encodeURIComponent(QUERY)}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.phrases.length > 0);
    for (const phrase of body.phrases) assert.ok(text.replace(/\s+/g, ' ').includes(phrase), `원문에 있는 구절이어야 합니다: ${phrase}`);
    assert.equal(body.querySimilarities?.length, body.phrases.length);
    return `${body.source}: ${body.phrases.slice(0, 5).join(' / ')}`;
  });

  await step('/deconstruct 오류 코드', async () => {
    const bad = await getJson('/deconstruct?url=ftp%3A%2F%2Fexample.com');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_URL');
    const missing = await getJson(`/deconstruct?url=${encodeURIComponent('https://www.wikipedia.org/this-page-does-not-exist-404')}`);
    assert.equal(missing.body.error.code, 'UPSTREAM_STATUS');
    return 'INVALID_URL, UPSTREAM_STATUS';
  });

  // 가짜 OpenAI 서버로 'OpenAI API' 연결을 화면에서 설정하고, 검색어·구절이 그 서버를 거치는지 본다.
  // 실제 키와 요금 없이 연결 선택·요청 모양·응답 처리 전체를 브라우저에서 확인하는 용도다.
  // 화면에는 주소 칸이 없으므로, 주소(baseUrl)만 저장된 설정으로 가짜 서버를 가리킨다.
  await step('LLM 연결: OpenAI API(가짜 서버)', async () => {
    const seen = [];
    const fake = createHttpServer(async (request, response) => {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-headers', '*');
      if (request.method === 'OPTIONS') return response.end();
      const send = (value, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.headers.authorization !== 'Bearer sk-fake-e2e') return send({ error: { message: 'bad key' } }, 401);
      if (request.url === '/v1/models') return send({ data: [{ id: 'fake-model' }, { id: 'other-model' }] });
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || '{}');
      const properties = body.response_format?.json_schema?.schema?.properties ?? {};
      const user = body.messages?.at(-1)?.content;
      seen.push({ model: body.model, keys: Object.keys(properties) });
      let answer;
      if (properties.queries) {
        const { count } = JSON.parse(user);
        answer = { queries: Array.from({ length: count }, (_, i) => `가짜검색어${i + 1}`) };
      } else if (properties.phrases) {
        const text = String(user).replace(/<\/?fragment>/g, '');
        answer = { phrases: text.split(/\s+/).filter((word) => word.length > 1).slice(0, 3) };
      } else if (properties.results) answer = { results: [] };
      else if (properties.description) answer = { description: '가짜 이미지 설명' };
      else answer = { word: '고구마' };
      send({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] });
    });
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${fake.address().port}/v1`;
    try {
      await page.evaluate((url) => {
        localStorage.setItem('local-llm-settings', JSON.stringify({ provider: 'openai', openai: { baseUrl: url, model: '', apiKey: '' } }));
      }, baseUrl);
      await page.reload({ waitUntil: 'load' });
      const panel = page.locator('.local-status');
      // 패널은 상태에 따라 스스로 열리기도 하므로, 요약을 클릭해 토글하지 않고 직접 연다.
      await page.waitForSelector('.local-status .local-llm select', { state: 'attached' });
      await page.evaluate(() => { document.querySelector('.local-status').open = true; });
      assert.equal(await panel.locator('.local-llm select').inputValue(), 'openai');
      assert.equal(await page.locator('.local-status-row', { hasText: 'Gemini Nano' }).isHidden(), true, 'Nano 줄은 숨어야 합니다');

      await panel.locator('.local-llm input[type="password"]').fill('sk-fake-e2e');
      await panel.locator('.local-llm button', { hasText: '목록' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.local-llm datalist option').length === 2, null, { timeout: 10_000 });
      const modelInput = panel.locator('.local-llm input[type="text"]');
      await modelInput.fill('fake-model');
      await modelInput.press('Tab');
      await panel.locator('.local-llm button', { hasText: '연결 테스트' }).click();
      await page.waitForFunction(() => /연결됨|실패/.test(document.querySelector('.local-llm-inline .local-status-value:last-child')?.textContent ?? ''), null, { timeout: 20_000 });
      const testText = await page.locator('.local-llm-inline .local-status-value').last().textContent();
      assert.match(testText, /연결됨/, testText);
      const stored = await page.evaluate(() => localStorage.getItem('local-llm-settings'));
      assert.ok(!stored.includes('sk-fake-e2e'), '기억하기를 켜지 않으면 키를 저장하지 않아야 합니다');

      const search = await getJson(`/search?query=${encodeURIComponent(QUERY)}&goodCount=3&awesomeQueryCount=4&awesomeCount=1`);
      assert.equal(search.status, 200, JSON.stringify(search.body));
      assert.deepEqual(Object.keys(search.body.awesome).sort(), ['가짜검색어1', '가짜검색어2', '가짜검색어3', '가짜검색어4']);
      const text = '고구마는 메꽃과의 여러해살이 식물이며, 덩이뿌리를 먹는다.';
      const phrases = await getJson(`/deconstruct/phrases?text=${encodeURIComponent(text)}`);
      assert.equal(phrases.body.source, 'llm');
      assert.deepEqual(phrases.body.phrases, ['고구마는', '메꽃과의', '여러해살이']);
      assert.ok(seen.every((call) => call.model === 'fake-model'));
      return `요청 ${seen.length}건(${[...new Set(seen.flatMap((call) => call.keys))].join(', ')}), 검색어 ${Object.keys(search.body.awesome).join('/')}`;
    } finally {
      // 다음 단계와 --profile 실행에 영향이 없도록 기본 연결로 되돌린다.
      await page.evaluate(() => localStorage.removeItem('local-llm-settings')).catch(() => {});
      await page.reload({ waitUntil: 'load' }).catch(() => {});
      fake.close();
    }
  });

  await step('화면: 검색 → 카드 → 미리보기 → 분해', async () => {
    await page.reload({ waitUntil: 'load' });
    const input = page.locator('.stack-query input');
    await input.fill(QUERY);
    await input.press('Enter');
    await page.waitForSelector('.search-loading', { state: 'hidden', timeout: 130_000 });
    await page.waitForSelector('[data-page-id]', { timeout: 30_000 });
    const cards = await page.locator('[data-page-id]').count();
    assert.ok(cards > 0, '카드가 그려져야 합니다');
    await page.waitForTimeout(2_000);
    await page.locator('[data-page-id]').first().click({ force: true });
    await page.waitForSelector('.page-preview:not([hidden])', { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('.preview-bar')?.getAttribute('data-loading') === 'false', null, { timeout: 20_000 });
    const previewKind = await page.evaluate(() => document.querySelector('.preview-frame iframe') ? 'iframe' : document.querySelector('.preview-fallback') ? 'summary' : 'empty');
    await page.locator('.stack-detail .decompose').click();
    await page.waitForSelector('.deconstruct-view', { timeout: 600_000 });
    const status = await page.locator('.decompose-status').textContent();
    return `카드 ${cards}장, 미리보기 ${previewKind}${status ? `, 상태: ${status}` : ''}`;
  });
} finally {
  await browser.close().catch(() => {});
  chromeProcess.kill();
  await new Promise((resolve) => chromeProcess.once('exit', resolve).once('error', resolve));
  await server.close();
  if (!useProfile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
