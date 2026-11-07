#!/usr/bin/env node
// Renders a deterministic motion HTML to an animated WebP (or GIF).
// The page must define window.renderAt(seconds) and window.MOTION_DURATION.
//
// usage: node render-motion.mjs <input.html> <output.webp|output.gif> [--fps=20] [--width=960] [--height=540] [--quality=60] [--lossless]
//
// --lossless: for flat, mostly white motions. Lossy WebP leaves faint ghosts of erased content between
// frames; lossless does not, and on this kind of image it is also smaller.
//
// Requires ffmpeg on PATH, and Playwright Chromium and sharp from apps/deconstruct.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
if (positional.length !== 2) {
  console.error('usage: node render-motion.mjs <input.html> <output.webp|output.gif> [--fps=20] [--width=960] [--height=540] [--quality=60]');
  process.exit(2);
}
const [html, output] = positional.map((p) => resolve(p));
const fps = opt('fps', 20);
const width = opt('width', 960);
const height = opt('height', 540);
const quality = opt('quality', 60);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'apps/deconstruct/package.json'));
const { chromium } = require('playwright');
const sharp = require('sharp');

const work = mkdtempSync(join(tmpdir(), 'render-motion-'));
try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(pathToFileURL(html).href);
  await page.evaluate(() => window.motionReady ?? document.fonts.ready);
  const duration = await page.evaluate(() => window.MOTION_DURATION);
  if (!(duration > 0)) throw new Error('window.MOTION_DURATION is missing');
  const total = Math.round(duration * fps);
  for (let i = 0; i < total; i += 1) {
    await page.evaluate((t) => window.renderAt(t), i / fps);
    await page.screenshot({ path: join(work, `f${String(i).padStart(5, '0')}.png`) });
  }
  await browser.close();
  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join('; ')}`);

  const gif = join(work, 'out.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(work, 'f%05d.png'),
    '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-loop', '0', gif]);

  if (extname(output).toLowerCase() === '.gif') {
    copyFileSync(gif, output);
  } else {
    await sharp(gif, { animated: true, limitInputPixels: false })
      .webp(args.includes('--lossless') ? { lossless: true, effort: 6, loop: 0 } : { quality, effort: 4, loop: 0 })
      .toFile(output);
  }
  console.log(JSON.stringify({ output, frames: total, fps, seconds: duration, kb: Math.round(statSync(output).size / 1024) }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
