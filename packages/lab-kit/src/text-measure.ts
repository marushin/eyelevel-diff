import {
  layoutWithLines,
  type PreparedTextWithSegments,
  prepareWithSegments,
  setLocale,
} from '@chenglou/pretext';

export interface MeasuredLine {
  text: string;
  width: number;
}

export interface MeasuredTextBlock {
  lines: MeasuredLine[];
  width: number;
  height: number;
  lineHeight: number;
  collisionRadius: number;
}

export interface MeasureBlockOptions {
  font?: string;
  maxWidth?: number;
  lineHeight?: number;
  maxLines?: number;
  padding?: number;
}

const DEFAULT_FONT = '500 12px "Pretendard Variable", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

const preparedCache = new Map<string, PreparedTextWithSegments>();
const MAX_PREPARED_CACHE = 600;
let localeConfigured = false;

function hasCanvasEnvironment(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' ||
    (typeof document !== 'undefined' && typeof document.createElement === 'function')
  );
}

function estimateCharWidth(codePoint: number, fontSizePx: number): number {
  // CJK Unified Ideographs, Hangul Syllables/Jamo, Hiragana/Katakana, Fullwidth
  if (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60)
  ) {
    return fontSizePx * 0.96;
  }
  if (codePoint <= 0x7f) {
    return fontSizePx * 0.56;
  }
  return fontSizePx * 0.72;
}

function parseFontSizePx(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number.parseFloat(match[1]!) : 12;
}

function fallbackMeasureBlock(
  text: string,
  font: string,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
  padding: number,
): MeasuredTextBlock {
  const fontSize = parseFontSizePx(font);
  const chars = Array.from(text.trim() || '—');
  const lines: MeasuredLine[] = [];
  let current = '';
  let currentWidth = 0;

  for (const ch of chars) {
    const w = estimateCharWidth(ch.codePointAt(0) ?? 0x20, fontSize);
    if (current.length > 0 && currentWidth + w > maxWidth) {
      lines.push({ text: current.trimEnd(), width: Math.round(currentWidth * 10) / 10 });
      current = ch === ' ' ? '' : ch;
      currentWidth = ch === ' ' ? 0 : w;
    } else {
      current += ch;
      currentWidth += w;
    }
  }
  if (current.length > 0 || lines.length === 0) {
    lines.push({ text: current.trimEnd(), width: Math.round(currentWidth * 10) / 10 });
  }

  const clamped = clampLinesWithEllipsis(lines, maxLines, maxWidth);
  const blockWidth = clamped.reduce((m, l) => Math.max(m, l.width), 0);
  const blockHeight = clamped.length * lineHeight;
  const halfW = blockWidth / 2 + padding;
  const halfH = blockHeight / 2 + padding;

  return {
    lines: clamped,
    width: blockWidth,
    height: blockHeight,
    lineHeight,
    collisionRadius: Math.hypot(halfW, halfH),
  };
}

function clampLinesWithEllipsis(
  lines: MeasuredLine[],
  maxLines: number,
  maxWidth: number,
): MeasuredLine[] {
  if (lines.length <= maxLines) return lines;
  const sliced = lines.slice(0, maxLines);
  const last = sliced[maxLines - 1]!;
  const trimmedText = last.text.length > 1 ? `${last.text.slice(0, -1).trimEnd()}…` : `${last.text}…`;
  sliced[maxLines - 1] = {
    text: trimmedText,
    width: Math.min(maxWidth, last.width + 8),
  };
  return sliced;
}

/**
 * Wraps `@chenglou/pretext` (`prepareWithSegments` + `layoutWithLines` LRU cache)
 * for fast Korean/CJK/polyglot multi-line wrapping & node collision radius computation.
 */
export function measureMultilineText(
  rawText: string,
  options: MeasureBlockOptions = {},
): MeasuredTextBlock {
  const text = rawText.trim() || '—';
  const font = options.font ?? DEFAULT_FONT;
  const maxWidth = Math.max(40, options.maxWidth ?? 180);
  const lineHeight = options.lineHeight ?? 16;
  const maxLines = Math.max(1, options.maxLines ?? 3);
  const padding = options.padding ?? 10;

  if (!hasCanvasEnvironment()) {
    return fallbackMeasureBlock(text, font, maxWidth, lineHeight, maxLines, padding);
  }

  try {
    if (!localeConfigured) {
      setLocale('ko');
      localeConfigured = true;
    }

    const cacheKey = `${font}::${text}`;
    let prepared = preparedCache.get(cacheKey);
    if (!prepared) {
      if (preparedCache.size >= MAX_PREPARED_CACHE) {
        const oldestKey = preparedCache.keys().next().value;
        if (oldestKey !== undefined) preparedCache.delete(oldestKey);
      }
      prepared = prepareWithSegments(text, font);
      preparedCache.set(cacheKey, prepared);
    }

    const laidOut = layoutWithLines(prepared, maxWidth, lineHeight);
    const rawLines: MeasuredLine[] =
      laidOut.lines.length > 0
        ? laidOut.lines.map((l) => ({
            text: l.text,
            width: Math.round(l.width * 10) / 10,
          }))
        : [{ text, width: 0 }];

    const lines = clampLinesWithEllipsis(rawLines, maxLines, maxWidth);
    const width = lines.reduce((acc, line) => Math.max(acc, line.width), 0);
    const height = lines.length * lineHeight;
    const halfW = width * 0.5 + padding;
    const halfH = height * 0.5 + padding;

    return {
      lines,
      width,
      height,
      lineHeight,
      collisionRadius: Math.hypot(halfW, halfH),
    };
  } catch {
    return fallbackMeasureBlock(text, font, maxWidth, lineHeight, maxLines, padding);
  }
}

export const measureTextBlock = measureMultilineText;

export interface StampSlot {
  key: string;
  /** Pixel X in the backing atlas canvas */
  sx: number;
  /** Pixel Y in the backing atlas canvas */
  sy: number;
  /** Pixel width in the backing atlas canvas */
  sw: number;
  /** Pixel height in the backing atlas canvas */
  sh: number;
  /** Logical CSS width */
  logicalWidth: number;
  /** Logical CSS height */
  logicalHeight: number;
  lastUsedTick: number;
}

export interface StampAtlasOptions {
  /** Backing atlas dimension (strictly clamped to <= 4096 per stability guardrail). */
  atlasSize?: number;
  cellWidth?: number;
  cellHeight?: number;
  dpr?: number;
}

export const MAX_STAMP_ATLAS_SIZE = 4096;

/**
 * Fixed-ceiling (`<= 4096x4096`) LRU OffscreenCanvas Stamp Atlas for crisp CJK/polyglot
 * text badges in Canvas2D / WebGL2 texture uploads without unbounded VRAM growth.
 */
export class LruStampAtlas {
  readonly size: number;
  readonly dpr: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cols: number;
  readonly rows: number;
  readonly capacity: number;
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;

  private readonly ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private readonly entries = new Map<string, { slotIndex: number; slot: StampSlot }>();
  private readonly slotKeys: (string | null)[];
  private tick = 0;
  private dirty = false;

  constructor(options: StampAtlasOptions = {}) {
    this.dpr = Math.min(options.dpr ?? (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1), 2);
    this.size = Math.min(MAX_STAMP_ATLAS_SIZE, Math.max(512, options.atlasSize ?? 2048));
    this.cellWidth = Math.floor((options.cellWidth ?? 220) * this.dpr);
    this.cellHeight = Math.floor((options.cellHeight ?? 64) * this.dpr);
    this.cols = Math.max(1, Math.floor(this.size / this.cellWidth));
    this.rows = Math.max(1, Math.floor(this.size / this.cellHeight));
    this.capacity = this.cols * this.rows;
    this.slotKeys = new Array<string | null>(this.capacity).fill(null);

    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(this.size, this.size);
      const ctx = this.canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to acquire 2D context on OffscreenCanvas');
      this.ctx = ctx;
    } else if (typeof document !== 'undefined') {
      const el = document.createElement('canvas');
      el.width = this.size;
      el.height = this.size;
      const ctx = el.getContext('2d');
      if (!ctx) throw new Error('Failed to acquire 2D context on HTMLCanvasElement');
      this.canvas = el;
      this.ctx = ctx;
    } else {
      throw new Error('LruStampAtlas requires OffscreenCanvas or HTMLCanvasElement');
    }
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
  }

  acquire(
    key: string,
    drawFn: (
      ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
      logicalW: number,
      logicalH: number,
    ) => { width: number; height: number } | void,
  ): StampSlot {
    this.tick += 1;
    const hit = this.entries.get(key);
    if (hit) {
      hit.slot.lastUsedTick = this.tick;
      return hit.slot;
    }

    const slotIndex = this.allocateSlotIndex();
    const col = slotIndex % this.cols;
    const row = Math.floor(slotIndex / this.cols);
    const sx = col * this.cellWidth;
    const sy = row * this.cellHeight;
    const logicalMaxW = this.cellWidth / this.dpr;
    const logicalMaxH = this.cellHeight / this.dpr;

    this.ctx.save();
    this.ctx.clearRect(sx, sy, this.cellWidth, this.cellHeight);
    this.ctx.beginPath();
    this.ctx.rect(sx, sy, this.cellWidth, this.cellHeight);
    this.ctx.clip();
    this.ctx.translate(sx, sy);
    this.ctx.scale(this.dpr, this.dpr);

    const measured = drawFn(this.ctx, logicalMaxW, logicalMaxH);
    this.ctx.restore();

    const logicalWidth = Math.min(logicalMaxW, measured?.width ?? logicalMaxW);
    const logicalHeight = Math.min(logicalMaxH, measured?.height ?? logicalMaxH);

    const slot: StampSlot = {
      key,
      sx,
      sy,
      sw: Math.ceil(logicalWidth * this.dpr),
      sh: Math.ceil(logicalHeight * this.dpr),
      logicalWidth,
      logicalHeight,
      lastUsedTick: this.tick,
    };

    this.slotKeys[slotIndex] = key;
    this.entries.set(key, { slotIndex, slot });
    this.dirty = true;
    return slot;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.entries.clear();
    this.slotKeys.fill(null);
    this.dirty = true;
  }

  private allocateSlotIndex(): number {
    for (let i = 0; i < this.capacity; i++) {
      if (this.slotKeys[i] === null) return i;
    }
    // Evict least-recently-used slot
    let oldestKey: string | null = null;
    let oldestIndex = 0;
    let oldestTick = Number.POSITIVE_INFINITY;

    for (const [k, record] of this.entries) {
      if (record.slot.lastUsedTick < oldestTick) {
        oldestTick = record.slot.lastUsedTick;
        oldestKey = k;
        oldestIndex = record.slotIndex;
      }
    }

    if (oldestKey !== null) {
      this.entries.delete(oldestKey);
      this.slotKeys[oldestIndex] = null;
    }
    return oldestIndex;
  }
}
