#!/usr/bin/env node
/**
 * 로컬 실행기. 정적 파일만 내주는 Vite 서버를 띄우고, CORS를 끈 전용 Chrome 프로필로 페이지를 연다.
 *
 *   pnpm local            개발 서버(소스 수정 시 바로 반영)
 *   pnpm local --preview  빌드한 dist/를 내주는 서버
 *   pnpm local --no-open  Chrome을 열지 않고 서버만 띄움
 *
 * 전용 프로필(.chrome-profile/)은 평소 쓰는 Chrome과 완전히 분리된다. 보안 기능을 끈 프로필이므로
 * 이 창에서는 다른 사이트에 로그인하지 말 것. Gemini Nano 모델도 이 프로필에 따로 받는다.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { CHROME_FLAGS } from './chrome-flags.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'apps', 'web');
const args = new Set(process.argv.slice(2));
const port = Number(process.env.WEB_PORT || 5173);
const profileDir = resolve(process.env.CHROME_PROFILE_DIR || join(root, '.chrome-profile'));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function startServer() {
  if (args.has('--preview')) {
    await build({ root: webRoot, configFile: join(webRoot, 'vite.config.ts') });
    return preview({ root: webRoot, configFile: join(webRoot, 'vite.config.ts') });
  }
  const server = await createServer({ root: webRoot, configFile: join(webRoot, 'vite.config.ts') });
  await server.listen();
  return server;
}

const server = await startServer();
const url = `http://127.0.0.1:${port}/`;
console.log(`\n  로컬 페이지: ${url}`);

if (!args.has('--no-open')) {
  const chrome = findChrome();
  if (!chrome) {
    console.error('  Chrome을 찾지 못했습니다. CHROME_PATH 환경 변수로 경로를 지정하세요.');
  } else {
    mkdirSync(profileDir, { recursive: true });
    console.log(`  전용 Chrome 프로필: ${profileDir}`);
    console.log('  (CORS를 끈 프로필입니다. 이 창에서는 다른 사이트에 로그인하지 마세요.)\n');
    const child = spawn(chrome, [`--user-data-dir=${profileDir}`, ...CHROME_FLAGS, url], { stdio: 'ignore', detached: true });
    child.unref();
  }
}

const shutdown = async () => {
  await server.close?.();
  await server.httpServer?.close?.();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
