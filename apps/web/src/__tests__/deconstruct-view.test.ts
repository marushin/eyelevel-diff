import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeconstructResponse } from '../deconstruct-api.ts';
import { createDeconstructView, type DeconstructView } from '../deconstruct-view.ts';

// The real renderer needs a browser; the threads are drawn from the camera and positions alone.
vi.mock('three/addons/renderers/CSS3DRenderer.js', async () => {
  const { Object3D } = await import('three');
  class CSS3DObject extends Object3D {
    constructor(readonly element: unknown) { super(); }
  }
  class CSS3DRenderer {
    domElement = document.createElement('div');
    setSize() {}
    render(_scene: unknown, camera: { updateMatrixWorld(): void }) { camera.updateMatrixWorld(); }
  }
  return { CSS3DObject, CSS3DRenderer };
});

type Listener = (event: unknown) => void;

/** Just enough DOM for the view: children named by a selector exist as soon as they are asked for. */
class FakeElement {
  className = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  disabled = false;
  tabIndex = 0;
  title = '';
  type = '';
  value = '0';
  width = 0;
  height = 0;
  clientWidth = 1000;
  clientHeight = 800;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> = { setProperty() {} };
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly named = new Map<string, FakeElement>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); },
  };
  readonly context = new FakeContext();

  constructor(readonly tagName: string) {}

  getContext() { return this.context; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  removeEventListener() {}
  append(...items: FakeElement[]) { for (const item of items) { item.parent = this; this.children.push(item); } }
  insertBefore(item: FakeElement) { this.append(item); }
  replaceChildren(...items: FakeElement[]) { this.children = []; this.append(...items); }
  remove() {}
  focus() {}
  setPointerCapture() {}
  querySelector(selector: string) {
    let child = this.named.get(selector);
    if (!child) {
      child = new FakeElement(selector.startsWith('.') ? 'section' : selector);
      if (selector.startsWith('.')) child.className = selector.slice(1);
      child.parent = this;
      this.named.set(selector, child);
    }
    return child;
  }
  querySelectorAll(selector: string) { return this.children.filter((child) => child.matches(selector)); }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      if (part.startsWith('.')) return this.className.split(' ').includes(part.slice(1));
      const data = /^\[data-(.+)\]$/.exec(part);
      return data ? data[1]! in this.dataset : this.tagName === part;
    });
  }
  closest(selector: string) {
    let node: FakeElement | null = this;
    while (node && !node.matches(selector)) node = node.parent;
    return node;
  }
  /** Listeners sit on the view, so events reach it directly with the original target. */
  fire(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, ...event });
  }
}

/** Keeps only what the latest clearRect left behind, which is what the canvas is showing. */
class FakeContext {
  strokeStyle = '';
  lineWidth = 0;
  lines: { style: string; width: number }[] = [];
  setTransform() {}
  clearRect() { this.lines = []; }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() { this.lines.push({ style: this.strokeStyle, width: this.lineWidth }); }
}

const COUNT = 8;
const SELECTED_LINE_WIDTH = 1.4;
const NEIGHBOR_LIMIT = 5;
const AUTO_SWITCH_SECONDS = 2.7;
const HIGHEST_DENSITY_STEP = '7';

function fixture(): DeconstructResponse {
  const weights: DeconstructResponse['weights'] = [];
  for (let a = 0; a < COUNT; a++) for (let b = a + 1; b < COUNT; b++) weights.push([a, b, .5 + (a + b) / 40]);
  return { contents: Array.from({ length: COUNT }, (_, i) => ({ type: 'text', content: `조각 ${i}` })), weights };
}

describe('deconstruct view threads', () => {
  let host: FakeElement;
  let root: FakeElement;
  let deconstruct: DeconstructView;
  let nextFrame: FrameRequestCallback | null;
  let now: number;
  const fragments: FakeElement[] = [];

  const advance = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 60); i++) {
      now += 1000 / 60;
      const frame = nextFrame!;
      nextFrame = null;
      frame(now);
    }
  };
  const canvas = () => root.querySelector('.deconstruct-threads');
  const lines = () => canvas().context.lines;
  const modeButton = (id: string) => root.querySelector('.deconstruct-modes').children.find((child) => child.dataset.mode === id)!;
  const pressed = (id: string) => modeButton(id).attributes.get('aria-pressed');
  const raiseDensity = () => {
    const density = root.querySelector('.deconstruct-density').querySelector('input');
    density.value = HIGHEST_DENSITY_STEP;
    density.fire('input');
  };

  beforeEach(() => {
    now = 0; nextFrame = null; fragments.length = 0;
    host = new FakeElement('div');
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        const element = new FakeElement(tag);
        fragments.push(element);
        return element;
      },
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = null; });
    deconstruct = createDeconstructView(host as unknown as HTMLElement, {
      title: '페이지', query: '검색어', result: fixture(),
      onAssemble() {}, onResearch() {},
      loadPhrases: () => Promise.reject(new Error('구절 요청은 이 테스트에서 쓰지 않습니다')),
    });
    root = host.children[0]!;
  });
  afterEach(() => {
    deconstruct.dispose();
    vi.unstubAllGlobals();
  });

  const fragment = (index: number) => fragments.find((item) => item.className === 'deconstruct-fragment' && item.dataset.index === String(index))!;

  it('draws no threads and switches to the meaning view on its own when left alone', () => {
    deconstruct.enter();
    raiseDensity();
    advance(AUTO_SWITCH_SECONDS - .2);
    expect(lines()).toHaveLength(0);
    expect(pressed('reading')).toBe('true');
    advance(1);
    expect(pressed('meaning')).toBe('true');
    expect(lines().length).toBeGreaterThan(0);
  });

  it('draws the nearest fragments at once when one is clicked before the automatic switch', () => {
    deconstruct.enter();
    advance(1);
    root.fire('click', { target: fragment(0) });
    advance(.5);
    expect(lines()).toHaveLength(NEIGHBOR_LIMIT);
    expect(lines().every((line) => line.width === SELECTED_LINE_WIDTH)).toBe(true);
    expect(root.querySelector('.deconstruct-neighbors').children).toHaveLength(NEIGHBOR_LIMIT);
  });

  it('still cancels the automatic switch when a fragment is clicked', () => {
    deconstruct.enter();
    advance(1);
    root.fire('click', { target: fragment(0) });
    advance(AUTO_SWITCH_SECONDS + 1);
    expect(pressed('reading')).toBe('true');
    expect(pressed('meaning')).toBe('false');
    expect(lines()).toHaveLength(NEIGHBOR_LIMIT);
  });

  it('draws the nearest fragments when one is chosen with the keyboard before the switch', () => {
    deconstruct.enter();
    advance(1);
    root.fire('keydown', { key: 'Enter', target: fragment(3) });
    advance(.5);
    expect(lines()).toHaveLength(NEIGHBOR_LIMIT);
    expect(pressed('reading')).toBe('true');
  });

  it('shows the threads once dragging cancels the automatic switch', () => {
    deconstruct.enter();
    raiseDensity();
    advance(1);
    root.fire('pointerdown', { button: 0, clientX: 0, clientY: 0, target: root });
    root.fire('pointermove', { clientX: 20, clientY: 0, pointerId: 1, target: root });
    root.fire('pointerup', { target: root });
    advance(.5);
    expect(lines().length).toBeGreaterThan(0);
    advance(AUTO_SWITCH_SECONDS);
    expect(pressed('reading')).toBe('true');
  });

  it('shows the threads once the 3D toggle cancels the automatic switch', () => {
    deconstruct.enter();
    raiseDensity();
    advance(1);
    root.fire('click', { target: root.querySelector('.deconstruct-modes').children.find((child) => child.className === 'deconstruct-depth')! });
    advance(.5);
    expect(lines().length).toBeGreaterThan(0);
  });

  it('fades the threads out while assembling', () => {
    deconstruct.enter();
    raiseDensity();
    advance(AUTO_SWITCH_SECONDS + 1);
    expect(lines().length).toBeGreaterThan(0);
    void deconstruct.assemble();
    advance(4);
    expect(lines()).toHaveLength(0);
  });
});
