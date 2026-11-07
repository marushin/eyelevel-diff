import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import { DisposableScope } from '@akl/lab-kit';
import { isWebImage, type DeconstructContent, type DeconstructResponse, type PhraseResult } from './deconstruct-api.ts';
import {
  boundsOf, emphasisWithin, emphasize, fragmentBox, layoutCloud, layoutHelix, layoutMeaning, layoutOrbit, layoutQueryShell, layoutReading,
  layoutSplit, nearestNeighbors, phraseSource, rankPairs, researchQuery, selectThreads,
  type Emphasis, type FragmentBox, type Neighbor, type Point, type Thread,
} from './deconstruct-layout.ts';

type Mode = 'reading' | 'meaning' | 'query';

export interface DeconstructViewOptions {
  title: string;
  query: string;
  result: DeconstructResponse;
  onAssemble(): void;
  onResearch(query: string): void;
  loadPhrases(text: string, signal: AbortSignal): Promise<PhraseResult>;
}

export interface DeconstructView {
  /** Reveals the prepared page and starts the fragments flying out. */
  enter(): void;
  /** Flies every fragment back to the centre; resolves when they are gone. */
  assemble(): Promise<void>;
  dispose(): void;
}

const MODES: { id: Mode; label: string; needsQuery?: boolean }[] = [
  { id: 'reading', label: '읽는 순서' },
  { id: 'meaning', label: '상호 유사도' },
  { id: 'query', label: '검색어 유사도', needsQuery: true },
];
const FLAT_VIEW = { azimuth: .1, elevation: -.39 };
const ORBIT_VIEW = { azimuth: 0, elevation: -.16 };
const DEPTH_ELEVATION = .22;
const AUTO_ROTATE_SPEED = .14;
const DENSITY_STEPS = [0, .05, .1, .2, .5, 1, 2, 5];
const DEFAULT_DENSITY_STEP = 0;
// Automatic framing starts a little closer than the whole page; double-clicking shows all of it.
const DEFAULT_ZOOM = .68;
const NEIGHBOR_LIMIT = 5;
const FOV = 40;
const TAN_Y = Math.tan(FOV * Math.PI / 360);
const REVEAL_SPREAD_SECONDS = .5;
const READING_HOLD_SECONDS = 2.2;
const ASSEMBLE_MS = 480;

interface Fragment {
  element: HTMLElement;
  object: CSS3DObject;
  box: FragmentBox;
  data: DeconstructContent;
  emphasis: Emphasis;
  target: Required<Point>;
  lift: number;
  delay: number;
  shown: boolean;
  similarity: number | undefined;
  /** The fragment this piece was split from, and where it sits relative to it. */
  parent: number | null;
  offset: Required<Point>;
  /** Replaced on screen by its pieces; it stays in place so that its threads keep an anchor. */
  split: boolean;
  removed: boolean;
}

function template(title: string): HTMLElement {
  const view = document.createElement('section');
  view.className = 'deconstruct-view';
  view.tabIndex = -1;
  view.setAttribute('role', 'dialog');
  view.setAttribute('aria-modal', 'true');
  view.setAttribute('aria-label', '페이지 분해');
  view.innerHTML = `
    <canvas class="deconstruct-threads" aria-hidden="true"></canvas>
    <header class="deconstruct-head">
      <p class="deconstruct-title"></p>
      <p class="deconstruct-summary" role="status"></p>
      <div class="deconstruct-modes" role="group" aria-label="보기 방식"></div>
    </header>
    <button type="button" class="deconstruct-assemble">조립</button>
    <label class="deconstruct-density">연결 상위 <output></output>
      <input type="range" min="0" max="${DENSITY_STEPS.length - 1}" step="1" value="${DEFAULT_DENSITY_STEP}" aria-label="표시할 연결의 비율" />
    </label>
    <section class="deconstruct-focus" hidden aria-label="선택한 조각">
      <p class="deconstruct-focus-content"></p>
      <p class="deconstruct-focus-similarity"></p>
      <div class="deconstruct-focus-actions">
        <button type="button" class="deconstruct-research">이 조각으로 다시 검색</button>
        <button type="button" class="deconstruct-break">더 잘게 분해</button>
      </div>
      <button type="button" class="deconstruct-merge" hidden>원래 문장으로 합치기</button>
      <p class="deconstruct-phrase-status" role="status" hidden></p>
      <p class="deconstruct-focus-label">가까운 조각</p>
      <ol class="deconstruct-neighbors"></ol>
    </section>`;
  view.querySelector('.deconstruct-title')!.textContent = `분해: ${title}`;
  return view;
}

function createFragmentElement(data: DeconstructContent, box: FragmentBox, emphasis: Emphasis, index: number): HTMLElement {
  const hit = document.createElement('div');
  hit.className = 'deconstruct-fragment';
  hit.dataset.index = String(index);
  hit.dataset.type = data.type;
  hit.tabIndex = 0;
  hit.style.width = `${box.width}px`;
  hit.style.height = `${box.height}px`;
  hit.style.setProperty('--emphasis-opacity', emphasis.opacity.toFixed(3));
  if (data.type === 'text') {
    // Page text is untrusted, so it is only ever assigned as text.
    const copy = document.createElement('p');
    copy.textContent = data.content;
    copy.style.fontSize = `${box.fontSize.toFixed(1)}px`;
    copy.style.webkitLineClamp = String(box.lines);
    hit.append(copy);
    hit.setAttribute('aria-label', data.content);
  } else {
    hit.setAttribute('aria-label', data.label ?? `이미지 조각 ${index + 1}`);
    const missing = () => {
      const note = document.createElement('p');
      note.className = 'deconstruct-missing';
      note.textContent = data.label ?? '이미지를 불러오지 못했습니다';
      hit.querySelector('img')?.remove();
      hit.append(note);
    };
    if (isWebImage(data.content)) {
      const image = document.createElement('img');
      image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.draggable = false;
      image.addEventListener('error', missing, { once: true });
      image.src = data.content;
      hit.append(image);
    } else missing();
  }
  return hit;
}

export function createDeconstructView(host: HTMLElement, options: DeconstructViewOptions): DeconstructView {
  const scope = new DisposableScope();
  const { result, query } = options;
  const isLive = (fragment: Fragment | undefined) => Boolean(fragment && !fragment.removed && !fragment.split);
  const view = template(options.title);
  // Hidden until enter(): building 500 fragments and layouts must not hitch the burst itself.
  view.style.visibility = 'hidden';
  host.append(view);
  scope.add(() => view.remove());

  const canvas = view.querySelector<HTMLCanvasElement>('.deconstruct-threads')!;
  const context = canvas.getContext('2d');
  const summary = view.querySelector<HTMLElement>('.deconstruct-summary')!;
  const modes = view.querySelector<HTMLElement>('.deconstruct-modes')!;
  const density = view.querySelector<HTMLElement>('.deconstruct-density')!;
  const densityInput = density.querySelector('input')!;
  const densityOutput = density.querySelector('output')!;
  const focusPanel = view.querySelector<HTMLElement>('.deconstruct-focus')!;
  const focusContent = view.querySelector<HTMLElement>('.deconstruct-focus-content')!;
  const focusSimilarity = view.querySelector<HTMLElement>('.deconstruct-focus-similarity')!;
  const researchButton = view.querySelector<HTMLButtonElement>('.deconstruct-research')!;
  const neighborList = view.querySelector<HTMLOListElement>('.deconstruct-neighbors')!;
  const breakButton = view.querySelector<HTMLButtonElement>('.deconstruct-break')!;
  const phraseStatus = view.querySelector<HTMLElement>('.deconstruct-phrase-status')!;
  const mergeButton = view.querySelector<HTMLButtonElement>('.deconstruct-merge')!;
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasSimilarities = Boolean(result.querySimilarities?.length);
  const availableModes = MODES.filter((mode) => !mode.needsQuery || hasSimilarities);
  for (const mode of availableModes) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.mode = mode.id; button.textContent = mode.label;
    modes.append(button);
  }
  const depthToggle = document.createElement('button');
  depthToggle.type = 'button'; depthToggle.className = 'deconstruct-depth'; depthToggle.textContent = '3D';
  depthToggle.setAttribute('aria-pressed', 'false');
  modes.append(depthToggle);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 400000);
  const renderer = new CSS3DRenderer();
  renderer.domElement.className = 'deconstruct-renderer';
  view.insertBefore(renderer.domElement, canvas.nextSibling);
  scope.add(() => renderer.domElement.remove());

  const destination = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const identity = new THREE.Quaternion();
  let distance = 2400; let renderedDistance = 2400;
  let azimuth = FLAT_VIEW.azimuth; let elevation = FLAT_VIEW.elevation;
  let azimuthTarget = azimuth; let elevationTarget = elevation;
  let billboard = 0;
  let threads: Thread[] = [];
  let mode: Mode = 'reading';
  let depth = false;
  let selected: number | null = null;
  let hovered: number | null = null;
  let threadAlpha = 0;
  let holdUntil: number | null = null;
  let clock = 0;
  let dirty = true;
  let autoFit = true; let autoRotate = false;
  let entered = false; let assembling = false;
  let width = 1; let height = 1;
  const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);

  const ranked = rankPairs(result.weights);
  const count = result.contents.length;
  const neighbors: Neighbor[][] = nearestNeighbors(ranked, count, NEIGHBOR_LIMIT);
  const emphasis = emphasize(result.querySimilarities, count);
  const boxes = result.contents.map((data, i) => fragmentBox(data, emphasis[i]!.scale));

  // Spring layouts take a noticeable moment on large pages, so only those actually opened are computed.
  const computed = new Map<string, Point[]>();
  const layoutFor = (id: Mode, inDepth: boolean): Point[] => {
    const key = `${id}:${inDepth}`;
    const cached = computed.get(key);
    if (cached) return cached;
    const points = id === 'reading' ? (inDepth ? layoutHelix(boxes) : layoutReading(boxes))
      : id === 'meaning' ? (inDepth ? layoutCloud(boxes, ranked) : layoutMeaning(boxes, ranked))
        : inDepth ? layoutQueryShell(boxes, emphasis) : layoutOrbit(boxes, emphasis);
    computed.set(key, points);
    return points;
  };
  layoutFor('meaning', false);

  const fragments: Fragment[] = result.contents.map((data, i) => {
    const element = createFragmentElement(data, boxes[i]!, emphasis[i]!, i);
    const object = new CSS3DObject(element);
    const reading = layoutFor('reading', false)[i]!;
    scene.add(object);
    return {
      element, object, box: boxes[i]!, data, emphasis: emphasis[i]!,
      target: { x: reading.x, y: reading.y, z: 0 }, lift: 0,
      delay: reducedMotion ? 0 : (i / Math.max(1, count)) * REVEAL_SPREAD_SECONDS, shown: false,
      similarity: result.querySimilarities?.[i], parent: null, offset: { x: 0, y: 0, z: 0 }, split: false, removed: false,
    };
  });
  scope.add(() => { for (const fragment of fragments) { scene.remove(fragment.object); fragment.element.remove(); } });

  // The search term sits at the centre of the target view; it is the one fragment-free mark on the page.
  const queryMark = document.createElement('div');
  queryMark.className = 'deconstruct-query-mark'; queryMark.textContent = query;
  const queryObject = new CSS3DObject(queryMark);
  scene.add(queryObject);
  scope.add(() => { scene.remove(queryObject); queryMark.remove(); });

  const fit = (whole = false) => {
    const points = layoutFor(mode, depth);
    const aspect = width / height;
    const zoom = whole ? 1 : DEFAULT_ZOOM;
    if (depth) {
      const reach = Math.max(...points.map((point) => Math.hypot(point.x, point.y, point.z ?? 0))) + 200;
      destination.set(0, 0, 0);
      distance = Math.max(500, reach / (TAN_Y * Math.min(1, aspect)) * 1.1 * zoom);
    } else {
      const bounds = boundsOf(points, boxes);
      destination.set((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, 0);
      // The head and the tilt both cost screen area, which the margin accounts for.
      distance = Math.max(500, Math.max((bounds.maxY - bounds.minY) / (2 * TAN_Y), (bounds.maxX - bounds.minX) / (2 * TAN_Y * aspect)) * 1.3 * zoom);
    }
    dirty = true;
  };
  const resize = () => {
    width = Math.max(1, view.clientWidth); height = Math.max(1, view.clientHeight);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    if (autoFit) fit();
    dirty = true;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(view);
  scope.add(() => observer.disconnect());
  resize();

  const projected: { x: number; y: number; visible: boolean }[] = [];
  const point = new THREE.Vector3();
  const drawThreads = () => {
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    if (threadAlpha < .01 || !fragments.length) return;
    projected.length = 0;
    for (const fragment of fragments) {
      point.copy(fragment.object.position).project(camera);
      projected.push({ x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, visible: point.z < 1 });
    }
    const active = selected ?? hovered;
    const stroke = (a: number, b: number, alpha: number, lineWidth: number) => {
      const from = projected[a]!; const to = projected[b]!;
      if (!from.visible || !to.visible) return;
      context.strokeStyle = `rgba(255,0,0,${alpha})`;
      context.lineWidth = lineWidth;
      context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
    };
    // The focus panel lists these partners, so they stay visible below the density threshold too.
    if (active !== null) {
      for (const { index } of partnersOf(active)) stroke(active, index, threadAlpha, 1.4);
      return;
    }
    for (const thread of threads) stroke(thread.a, thread.b, (.28 + thread.strength * .6) * threadAlpha, 1 + thread.strength * .5);
  };

  /** Partners still on screen: one that has been split is shown as its pieces instead. */
  const partnersOf = (index: number) => (neighbors[index] ?? []).filter((item) => isLive(fragments[item.index]));

  const applyHighlight = () => {
    const active = selected ?? hovered;
    view.classList.toggle('has-active-fragment', active !== null);
    const near = new Set<number>();
    if (active !== null) {
      near.add(active);
      for (const { index } of partnersOf(active)) near.add(index);
      const family = fragments[active]!.parent;
      if (family !== null) fragments.forEach((fragment, i) => { if (fragment.parent === family && isLive(fragment)) near.add(i); });
    }
    fragments.forEach((fragment, i) => {
      fragment.element.classList.toggle('is-near', near.has(i));
      fragment.element.classList.toggle('is-active', i === active);
    });
    dirty = true;
  };

  let researchTerm = '';
  let phraseRequest: AbortController | null = null;
  scope.add(() => phraseRequest?.abort());
  const clearPhrases = () => {
    phraseRequest?.abort(); phraseRequest = null;
    phraseStatus.hidden = true; phraseStatus.textContent = '';
  };
  const showPhraseStatus = (message: string) => { phraseStatus.textContent = message; phraseStatus.hidden = !message; };
  const placePieces = () => {
    fragments.forEach((fragment) => {
      if (fragment.parent === null || fragment.removed) return;
      const base = fragments[fragment.parent]!.target;
      fragment.target = { x: base.x + fragment.offset.x, y: base.y + fragment.offset.y, z: base.z + (depth ? fragment.offset.z : 0) };
    });
  };
  /** Replaces a text fragment with its phrases, in place; an image stays and gains them around it. */
  const splitFragment = (index: number, phrases: readonly string[], similarities: readonly number[] | undefined) => {
    const parent = fragments[index]!;
    const items = phrases.map((phrase, i): { data: DeconstructContent; similarity: number | undefined; emphasis: Emphasis } => {
      const similarity = similarities?.[i];
      return {
        data: { type: 'text', content: phrase }, similarity,
        emphasis: similarity !== undefined && result.querySimilarities ? emphasisWithin(similarity, result.querySimilarities) : parent.emphasis,
      };
    });
    const pieceBoxes = items.map((item) => fragmentBox(item.data, item.emphasis.scale));
    const offsets = layoutSplit(pieceBoxes);
    // Images keep their place, so their label's pieces gather beside them rather than on top.
    const clearance = parent.data.type === 'img' ? parent.box.height / 2 + pieceBoxes[0]!.height : 0;
    const first = fragments.length;
    items.forEach((item, i) => {
      const element = createFragmentElement(item.data, pieceBoxes[i]!, item.emphasis, fragments.length);
      const object = new CSS3DObject(element);
      object.position.copy(parent.object.position);
      scene.add(object);
      const offset = { ...offsets[i]!, y: offsets[i]!.y - clearance };
      fragments.push({
        element, object, box: pieceBoxes[i]!, data: item.data, emphasis: item.emphasis,
        target: { x: parent.target.x + offset.x, y: parent.target.y + offset.y, z: parent.target.z + (depth ? offset.z : 0) },
        lift: 0, delay: 0, shown: false, similarity: item.similarity, parent: index, offset, split: false, removed: false,
      });
      // Pieces have no measured distance to the rest of the page, so they inherit their source's partners.
      neighbors.push(neighbors[index] ?? []);
    });
    if (parent.data.type === 'text') { parent.split = true; parent.element.classList.add('is-split'); }
    applyDensity();
    showFocus(first, false);
    autoFit = false;
    // Sits below centre so the pieces land above the focus panel rather than behind it.
    destination.set(parent.target.x, parent.target.y - 220, parent.target.z);
    distance = Math.min(distance, 1500);
  };
  const removePieces = (index: number) => {
    fragments.forEach((fragment, i) => {
      if (fragment.parent !== index || fragment.removed) return;
      removePieces(i);
      fragment.removed = true;
      scene.remove(fragment.object); fragment.element.remove();
    });
  };
  const mergeInto = (index: number) => {
    removePieces(index);
    const fragment = fragments[index]!;
    fragment.split = false; fragment.element.classList.remove('is-split');
    applyDensity();
    showFocus(index, false);
  };
  const phraseResults = new Map<string, PhraseResult>();
  const breakFragment = async (index: number) => {
    const text = phraseSource(fragments[index]!.data);
    if (!text) return;
    clearPhrases();
    const request = new AbortController(); phraseRequest = request;
    breakButton.disabled = true;
    showPhraseStatus('구절로 나누는 중입니다');
    try {
      const loaded = phraseResults.get(text) ?? await options.loadPhrases(text, request.signal);
      if (request.signal.aborted || scope.disposed) return;
      phraseResults.set(text, loaded);
      if (loaded.phrases.length < 2) { showPhraseStatus('더 나눌 구절이 없습니다'); return; }
      splitFragment(index, loaded.phrases, loaded.querySimilarities);
      if (loaded.source === 'rule') showPhraseStatus('규칙으로 나눴습니다');
    } catch (error) {
      if (request.signal.aborted || scope.disposed) return;
      showPhraseStatus(error instanceof Error ? error.message : '구절로 나누지 못했습니다.');
    } finally {
      if (phraseRequest === request) breakButton.disabled = false;
    }
  };

  const showFocus = (index: number | null, moveCamera = true) => {
    selected = index;
    applyHighlight();
    clearPhrases();
    breakButton.disabled = false;
    focusPanel.hidden = index === null;
    if (index === null) return;
    autoRotate = false;
    const fragment = fragments[index]!;
    focusContent.textContent = fragment.data.type === 'text' ? fragment.data.content : fragment.data.label ?? `이미지 조각 ${index + 1}`;
    const similarity = fragment.similarity;
    focusSimilarity.textContent = similarity === undefined ? '' : `검색어 "${query}"와의 유사도 ${similarity.toFixed(2)}`;
    researchTerm = researchQuery(fragments.map((item) => item.data), index, neighbors[index]);
    researchButton.hidden = !researchTerm;
    researchButton.title = researchTerm;
    breakButton.hidden = !phraseSource(fragment.data);
    mergeButton.hidden = fragment.parent === null;
    neighborList.replaceChildren(...partnersOf(index).map(({ index: other, weight }) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.neighbor = String(other);
      const data = fragments[other]!.data;
      const label = data.type === 'text' ? data.content : data.label ?? `이미지 조각 ${other + 1}`;
      button.textContent = `${weight.toFixed(2)}  ${Array.from(label).slice(0, 48).join('')}`;
      item.append(button);
      return item;
    }));
    if (moveCamera) {
      autoFit = false;
      destination.set(fragment.target.x, fragment.target.y, fragment.target.z);
      distance = Math.min(distance, 1300);
    }
  };

  const setMode = (next: Mode) => {
    if (assembling) return;
    mode = next; holdUntil = null;
    modes.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === next));
    });
    applyArrangement();
  };
  const setDepth = (next: boolean) => {
    if (assembling) return;
    depth = next; holdUntil = null;
    depthToggle.setAttribute('aria-pressed', String(next));
    applyArrangement();
  };
  const applyArrangement = () => {
    autoFit = true;
    layoutFor(mode, depth).forEach((target, i) => { fragments[i]!.target = { x: target.x, y: target.y, z: target.z ?? 0 }; });
    placePieces();
    view.classList.toggle('is-orbit', mode === 'query');
    view.classList.toggle('is-depth', depth);
    autoRotate = depth && !reducedMotion;
    if (depth) { elevationTarget = DEPTH_ELEVATION; azimuthTarget = azimuth + .5; }
    else { const flat = mode === 'query' ? ORBIT_VIEW : FLAT_VIEW; azimuthTarget = flat.azimuth; elevationTarget = flat.elevation; }
    showFocus(null, false);
    fit();
  };
  const applyDensity = () => {
    const percent = DENSITY_STEPS[Number(densityInput.value)] ?? 0;
    densityOutput.textContent = `${percent}%`;
    threads = selectThreads(ranked, percent);
    const live = fragments.filter(isLive);
    const images = live.filter((item) => item.data.type === 'img').length;
    const basis = hasSimilarities ? ` · 기준 검색어 "${query}"` : '';
    summary.textContent = `조각 ${live.length}개 · 글 ${live.length - images} · 이미지 ${images} · 연결 ${threads.length}개${basis}`;
    dirty = true;
  };
  applyDensity();

  const easingFor = (rate: number, dt: number) => reducedMotion ? 1 : 1 - Math.exp(-rate * dt);
  const angleEpsilon = .0005;
  scope.trackRaf((_time, _wrapped, dt) => {
    if (!entered) return;
    clock += dt;
    if (holdUntil !== null && clock >= holdUntil) setMode('meaning');
    let moving = false;
    const travel = easingFor(assembling ? 7 : 2.6, dt);
    const active = selected ?? hovered;
    fragments.forEach((fragment, i) => {
      if (fragment.removed) return;
      if (clock < fragment.delay) { moving = true; return; }
      if (!fragment.shown) { fragment.shown = true; fragment.element.classList.add('is-shown'); }
      const position = fragment.object.position;
      const lifted = i === active && !depth ? 70 : 0;
      const dx = fragment.target.x - position.x; const dy = fragment.target.y - position.y;
      const dz = fragment.target.z + lifted - position.z;
      if (Math.abs(dx) > .3 || Math.abs(dy) > .3 || Math.abs(dz) > .3) {
        moving = true;
        position.x += dx * travel; position.y += dy * travel; position.z += dz * travel;
      }
    });
    if (autoRotate) { azimuthTarget += dt * AUTO_ROTATE_SPEED; moving = true; }
    const cameraEasing = easingFor(2.2, dt);
    if (Math.abs(azimuthTarget - azimuth) > angleEpsilon || Math.abs(elevationTarget - elevation) > angleEpsilon) {
      moving = true;
      azimuth += (azimuthTarget - azimuth) * cameraEasing;
      elevation += (elevationTarget - elevation) * cameraEasing;
    }
    if (lookTarget.distanceTo(destination) > .3 || Math.abs(distance - renderedDistance) > .3) {
      moving = true;
      lookTarget.lerp(destination, cameraEasing);
      renderedDistance += (distance - renderedDistance) * cameraEasing;
    }
    const billboardTarget = depth ? 1 : 0;
    if (Math.abs(billboardTarget - billboard) > .002) {
      moving = true;
      billboard += (billboardTarget - billboard) * easingFor(3, dt);
    } else billboard = billboardTarget;
    // Hidden only while the opening hold lasts, so anything that cancels the hold brings them back.
    // Only the meaning view keeps related fragments close; elsewhere the threads span the page and tangle.
    const threadTarget = assembling || holdUntil !== null ? 0 : mode === 'meaning' ? 1 : .3;
    if (Math.abs(threadTarget - threadAlpha) > .005) {
      moving = true;
      threadAlpha += (threadTarget - threadAlpha) * easingFor(2, dt);
    }
    // A settled scene stops rewriting 500 transforms per frame.
    if (!moving && !dirty) return;
    dirty = false;
    direction.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    camera.position.copy(lookTarget).addScaledVector(direction, renderedDistance);
    camera.lookAt(lookTarget);
    // In depth views the text always faces the viewer, otherwise it would turn edge-on and vanish.
    for (const fragment of fragments) fragment.object.quaternion.slerpQuaternions(identity, camera.quaternion, billboard);
    queryObject.quaternion.slerpQuaternions(identity, camera.quaternion, billboard);
    renderer.render(scene, camera);
    drawThreads();
  });

  let drag: { x: number; y: number } | null = null;
  let dragged = false;
  const isControl = (target: EventTarget | null) => target instanceof Element &&
    Boolean(target.closest('button,a,input,label,.deconstruct-focus,.deconstruct-head'));
  scope.trackListener(view, 'pointerdown', (event) => {
    const e = event as PointerEvent;
    dragged = false;
    if (e.button !== 0 || isControl(e.target)) return;
    drag = { x: e.clientX, y: e.clientY };
  });
  scope.trackListener(view, 'pointermove', (event) => {
    const e = event as PointerEvent;
    if (!drag) return;
    if (!dragged && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    if (!dragged) view.setPointerCapture(e.pointerId);
    dragged = true; autoFit = false; holdUntil = null;
    if (depth) {
      // Depth views orbit under the pointer; flat views slide like paper on a table.
      autoRotate = false;
      azimuthTarget -= (e.clientX - drag.x) * .006;
      elevationTarget = THREE.MathUtils.clamp(elevationTarget + (e.clientY - drag.y) * .006, -1.35, 1.35);
    } else {
      const worldPerPixel = 2 * renderedDistance * TAN_Y / height;
      destination.x -= (e.clientX - drag.x) * worldPerPixel;
      destination.y += (e.clientY - drag.y) * worldPerPixel;
    }
    drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => { drag = null; };
  scope.trackListener(view, 'pointerup', endDrag);
  scope.trackListener(view, 'pointercancel', endDrag);
  scope.trackListener(view, 'wheel', (event) => {
    const e = event as WheelEvent;
    if (isControl(e.target)) return;
    e.preventDefault(); autoFit = false;
    distance = THREE.MathUtils.clamp(distance * Math.exp(e.deltaY * .0012), 350, 120000);
  }, { passive: false });
  scope.trackListener(view, 'click', (event) => {
    if (assembling) return;
    const target = event.target as Element;
    if (target.closest('.deconstruct-assemble')) return options.onAssemble();
    if (target.closest('.deconstruct-research')) { if (researchTerm) options.onResearch(researchTerm); return; }
    if (target.closest('.deconstruct-break')) { if (selected !== null) void breakFragment(selected); return; }
    if (target.closest('.deconstruct-merge')) {
      const parent = selected === null ? null : fragments[selected]!.parent;
      if (parent !== null) mergeInto(parent);
      return;
    }
    if (target.closest('.deconstruct-depth')) return setDepth(!depth);
    const neighbor = target.closest<HTMLElement>('[data-neighbor]');
    if (neighbor) return showFocus(Number(neighbor.dataset.neighbor));
    const modeButton = target.closest<HTMLElement>('[data-mode]');
    if (modeButton) return setMode(modeButton.dataset.mode as Mode);
    if (dragged || isControl(target)) return;
    const fragment = target.closest<HTMLElement>('.deconstruct-fragment');
    if (fragment) { holdUntil = null; showFocus(Number(fragment.dataset.index)); } else showFocus(null, false);
  });
  scope.trackListener(view, 'dblclick', (event) => {
    if (!(event.target as Element).closest('.deconstruct-fragment') && !isControl(event.target)) { autoFit = true; fit(true); }
  });
  scope.trackListener(view, 'keydown', (event) => {
    const e = event as KeyboardEvent;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (selected !== null) showFocus(null, false); else if (!assembling) options.onAssemble();
    } else if (e.key === 'Enter') {
      const fragment = (e.target as Element).closest?.<HTMLElement>('.deconstruct-fragment');
      if (fragment) { e.preventDefault(); holdUntil = null; showFocus(Number(fragment.dataset.index)); }
    }
  });
  for (const type of ['pointerover', 'pointerout']) {
    scope.trackListener(view, type, (event) => {
      const e = event as PointerEvent;
      if (drag) return;
      const fragment = (e.target as Element).closest<HTMLElement>('.deconstruct-fragment');
      if (!fragment || (e.relatedTarget instanceof Node && fragment.contains(e.relatedTarget))) return;
      hovered = type === 'pointerover' ? Number(fragment.dataset.index) : null;
      applyHighlight();
    });
  }
  scope.trackListener(densityInput, 'input', applyDensity);

  return {
    enter() {
      if (entered) return;
      entered = true;
      view.style.visibility = ''; view.focus();
      clock = 0;
      if (reducedMotion) setMode('meaning');
      else { setMode('reading'); holdUntil = REVEAL_SPREAD_SECONDS + READING_HOLD_SECONDS; }
      // The camera opens on the whole page and eases in, so the default zoom reads as a gesture.
      fit(true); renderedDistance = distance; lookTarget.copy(destination);
      fit();
    },
    assemble() {
      assembling = true; holdUntil = null; autoRotate = false;
      showFocus(null, false);
      for (const fragment of fragments) { fragment.target = { x: destination.x, y: destination.y, z: destination.z }; fragment.delay = 0; }
      view.classList.add('is-assembling');
      if (reducedMotion) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, ASSEMBLE_MS);
        scope.add(() => { clearTimeout(timer); resolve(); });
      });
    },
    dispose: () => scope.dispose(),
  };
}
