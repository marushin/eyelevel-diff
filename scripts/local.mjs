#!/usr/bin/env node
/**
 * 로컬 실행기. 정적 파일만 내주는 Vite 서버를 띄우고, CORS를 끈 전용 Chrome 프로필로 페이지를 연다.
 *
 *   pnpm local            개발 서버(소스 수정 시 바로 반영)
 *   pnpm local --preview  빌드한 dist/를 내주는 서버
 *   pnpm local --no-open  Chrome을 열지 않고 서버만 띄움
 *   pnpm local --no-copy-model  평소 Chrome의 Gemini Nano 모델을 전용 프로필로 복사하지 않음
 *
 * 전용 프로필(.chrome-profile/)은 평소 쓰는 Chrome과 완전히 분리된다. 보안 기능을 끈 프로필이므로
 * 이 창에서는 다른 사이트에 로그인하지 말 것. Gemini Nano 모델도 이 프로필에 따로 받는다.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** 평소 쓰는 Chrome 프로필 폴더(User Data). 모델 파일만 읽어 온다. */
function defaultChromeUserData() {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return join(homedir(), '.config', 'google-chrome');
}

const hasFiles = (dir) => existsSync(dir) && readdirSync(dir, { recursive: true }).some((name) => String(name).endsWith('weights.bin'));

/**
 * Gemini Nano 모델(약 4GB)은 프로필마다 따로 받는다. 평소 Chrome에 이미 받아 둔 모델이 있으면
 * 전용 프로필로 복사해 다시 받지 않게 한다. Chrome은 시작할 때 이 폴더를 읽어 모델을 등록한다.
 */
function copyNanoModel() {
  const target = join(profileDir, 'OptGuideOnDeviceModel');
  const source = join(defaultChromeUserData(), 'OptGuideOnDeviceModel');
  // macOS는 평소 Chrome 프로필 폴더 읽기를 EPERM으로 막을 수 있다. 복사는 선택 기능이므로 실패해도 계속 실행한다.
  try {
    if (hasFiles(target) || !hasFiles(source)) return;
    console.log(`  평소 Chrome의 Gemini Nano 모델을 전용 프로필로 복사합니다 (${source})`);
    cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  } catch (error) {
    console.warn(`  모델 복사 실패: ${error.message}. 화면의 '받기' 버튼으로 받으세요.`);
  }
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
    if (!args.has('--no-copy-model')) copyNanoModel();
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
