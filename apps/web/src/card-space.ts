import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import type { CrawlSnapshot } from '@akl/graph-contract';
import type { DisposableScope } from '@akl/lab-kit';
import { fitOverview, OVERVIEW_DIRECTION } from './camera-layout.ts';
import { layoutStacks, placeContinuation, type StackPlacement } from './stack-layout.ts';
import { groupOf, type SiteFixture, visitedHistory } from './data.ts';

export function createCardSpace(stage: HTMLElement, scope: DisposableScope, onSelect: (id: string) => void) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 30000);
  const renderer = new CSS3DRenderer();
  renderer.domElement.className = 'card-space-renderer';
  renderer.domElement.style.cssText += 'position:absolute;inset:0;z-index:1;';
  stage.append(renderer.domElement);
  const objects = new Map<string, CSS3DObject>();
  const floor = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  floor.setAttribute('aria-hidden', 'true');
  floor.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  stage.append(floor);
  const shadowLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  shadowLayer.setAttribute('fill', '#000');
  shadowLayer.setAttribute('opacity', '0.09');
  shadowLayer.style.filter = 'blur(4px)';
  floor.append(shadowLayer);
  const shadows = new Map<string, SVGPolygonElement>();
  const arrows = new Map<string, { path: SVGPathElement; source: string; target: string }>();
  const destination = new THREE.Vector3(0, 150, 0);
  const target = destination.clone();
  let distance = 1900;
  let fixture: SiteFixture | null = null;
  let placements = new Map<string, StackPlacement>();
  let visibleCount = 0;
  let completionPending = false;
  let completionSeen = false;
  let autoFrame = true;
  let followLatest = true;
  let renderedDistance = 1900;
  let overview = { target: destination.clone(), distance, autoFrame, followLatest };
  const frameAll = (allowZoomIn = false) => {
    const frame = fitOverview([...objects.values()].filter((object) => object.parent).map((object) => object.position), camera.aspect);
    destination.copy(frame.center);
    distance = allowZoomIn ? frame.distance : Math.max(distance, frame.distance);
  };
  const resize = () => {
    camera.aspect = Math.max(1, stage.clientWidth) / Math.max(1, stage.clientHeight);
    camera.updateProjectionMatrix(); renderer.setSize(stage.clientWidth, stage.clientHeight);
    if (autoFrame && !followLatest) frameAll(true);
  };
  const observer = new ResizeObserver(resize); observer.observe(stage);
  scope.add(() => observer.disconnect());
  const clear = () => {
    for (const object of objects.values()) { scene.remove(object); object.element.remove(); }
    objects.clear(); completionPending = false; completionSeen = false; placements.clear(); shadowLayer.replaceChildren(); shadows.clear(); floor.replaceChildren(shadowLayer); arrows.clear();
  };
  scope.add(() => { clear(); floor.remove(); renderer.domElement.remove(); });
  scope.trackRaf((_time, _wrapped, dt) => {
    const easing = 1 - Math.exp(-1.7 * dt);
    target.lerp(destination, easing);
    renderedDistance += (distance - renderedDistance) * easing;
    camera.position.copy(target).addScaledVector(OVERVIEW_DIRECTION, renderedDistance);
    for (const object of objects.values()) {
      const lift = Number(object.userData.lift ?? 0);
      object.userData.lift = lift + ((object.userData.hover ? 180 : 0) - lift) * .15;
      object.userData.appearance = Math.min(1, Number(object.userData.appearance ?? 0) + dt * 2.5);
      (object.element.firstElementChild as HTMLElement).style.opacity = String(object.userData.appearance);
      (object.element.firstElementChild as HTMLElement).style.transform = `translateY(${-object.userData.lift}px)`;
    }
    // Wait for the final card's fade-in before easing out to the full scene.
    if (completionPending && autoFrame && followLatest) {
      const visible = [...objects.values()].filter(object => object.parent);
      if (visible.length && visible.every(object => Number(object.userData.appearance) >= 1)) {
        completionPending = false; followLatest = false; frameAll();
      }
    }
    camera.lookAt(target); renderer.render(scene, camera);
    const width = stage.clientWidth; const height = stage.clientHeight;
    floor.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const project = (x: number, y: number, z: number) => {
      const point = new THREE.Vector3(x, y, z).project(camera);
      return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 };
    };
    // A soft floor projection from the camera's light position; edges remain on y=0.
    for (const [id, shadow] of shadows) {
      const object = objects.get(id);
      if (!object?.parent) { shadow.setAttribute('visibility', 'hidden'); continue; }
      shadow.removeAttribute('visibility');
      const lift = Number(object.userData.lift ?? 0);
      const ground = (x: number, h: number) => {
        const ratio = h / Math.max(300, camera.position.y - h);
        return project(x + (x - camera.position.x) * ratio, 0,
          object.position.z + (object.position.z - camera.position.z) * ratio);
      };
      const left = object.position.x - 230; const right = object.position.x + 230;
      const points = [ground(left, lift), ground(right, lift), ground(right, lift + 300), ground(left, lift + 300)];
      shadow.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
      shadow.setAttribute('opacity', String(Number(object.userData.appearance ?? 1) * (1 - lift / 600)));
    }
    for (const arrow of arrows.values()) {
      const from = objects.get(arrow.source)!; const to = objects.get(arrow.target)!;
      const side = to.position.x >= from.position.x ? 1 : -1;
      const startX = from.position.x + side * 230;
      const endX = to.position.x - side * 230;
      const end = { x: endX, z: to.position.z };
      const bend = { x: (startX + endX) / 2, z: (from.position.z + end.z) / 2 + side * 100 };
      const points = [project(startX, 0, from.position.z), project(bend.x, 0, bend.z), project(end.x, 0, end.z)];
      const dx = end.x - bend.x; const dz = end.z - bend.z;
      const length = Math.max(1, Math.hypot(dx, dz));
      const ux = dx / length; const uz = dz / length;
      const headA = project(end.x - ux * 26 - uz * 10, 0, end.z - uz * 26 + ux * 10);
      const headB = project(end.x - ux * 26 + uz * 10, 0, end.z - uz * 26 - ux * 10);
      const tip = points[2]!;
      arrow.path.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') +
        ` M${headA.x},${headA.y} L${tip.x},${tip.y} L${headB.x},${headB.y}`);
    }
  });
  let drag: { x: number; y: number } | null = null;
  let dragged = false;
  scope.trackListener(stage, 'pointerdown', (event) => {
    const e = event as PointerEvent;
    if ((e.target as Element).closest('a,button,input,.page-preview,.stack-query') || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY }; dragged = false;
  });
  scope.trackListener(stage, 'pointermove', (event) => {
    const e = event as PointerEvent;
    if (!drag) return;
    if (!dragged && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    if (!dragged) stage.setPointerCapture(e.pointerId);
    dragged = true; autoFrame = false;
    destination.x -= (e.clientX - drag.x) * distance / 800;
    destination.z -= (e.clientY - drag.y) * distance / 500;
    drag = { x: e.clientX, y: e.clientY };
  });
  scope.trackListener(stage, 'pointerup', () => { drag = null; });
  scope.trackListener(stage, 'pointercancel', () => { drag = null; });
  scope.trackListener(stage, 'wheel', (event) => {
    const e = event as WheelEvent;
    if ((e.target as Element).closest('input,button,.page-preview,.stack-query')) return;
    e.preventDefault(); autoFrame = false; distance = THREE.MathUtils.clamp(distance + e.deltaY * 1.5, 650, 24000);
  }, { passive: false });
  scope.trackListener(stage, 'click', (event) => {
    if (dragged || (event.target as Element).closest('a,button,input,.page-preview,.stack-query')) return;
    const id = (event.target as Element).closest<HTMLElement>('[data-page-id]')?.dataset.pageId;
    if (id) onSelect(id);
  });
  scope.trackListener(stage, 'dblclick', (event) => {
    if (!(event.target as Element).closest('[data-page-id],a,button,input,.page-preview,.stack-query')) { autoFrame = true; followLatest = false; frameAll(true); }
  });
  scope.trackListener(stage, 'keydown', (event) => {
    const e = event as KeyboardEvent;
    const id = (e.target as HTMLElement).dataset.pageId;
    if (id && e.key === 'Enter') { e.preventDefault(); onSelect(id); }
  });
  for (const type of ['pointerover', 'pointerout']) {
    scope.trackListener(stage, type, (event) => {
      const e = event as PointerEvent;
      const element = (e.target as Element).closest<HTMLElement>('[data-page-id]');
      if (!element || (e.relatedTarget instanceof Node && element.contains(e.relatedTarget))) return;
      const object = objects.get(element.dataset.pageId!);
      if (object) object.userData.hover = type === 'pointerover';
    });
  }
  function begin(next: SiteFixture) {
    clear(); fixture = next; visibleCount = 0; autoFrame = true; followLatest = true; distance = 1900; renderedDistance = 1900;
    destination.set(0, 150, 0); target.copy(destination); resize();
    placements = layoutStacks(next);
    addCards(next.pages);
  }
  function addCards(pages: SiteFixture['pages']) {
    for (const page of pages) {
      const element = document.createElement('div');
      element.className = 'stack-card-hit';
      const face = document.createElement('article'); face.className = 'stack-card'; element.append(face); element.tabIndex = 0; element.dataset.pageId = page.node.id;
      element.setAttribute('aria-label', page.node.content?.title ?? page.node.domain);
      const title = document.createElement('strong'); title.textContent = page.node.content?.title ?? page.node.domain;
      const link = document.createElement('span'); link.className = 'stack-card-url';
      link.textContent = page.href; link.title = page.href;
      const copy = document.createElement('p'); copy.textContent = page.node.content?.snippet ?? '';
      const content = document.createElement('div'); content.className = 'stack-card-content';
      content.append(title, link, copy); face.append(content);
      const object = new CSS3DObject(element);
      const placement = placements.get(page.node.id)!;
      element.dataset.stackId = placement.stack;
      if (page.group === 'original') {
        const marker = document.createElement('div'); marker.className = 'original-stack-marker';
        marker.textContent = 'aligned';
        marker.setAttribute('aria-label', '정방향 스택'); face.prepend(marker);
      }
      if (page.group === 'drift') {
        const marker = document.createElement('div'); marker.className = 'original-stack-marker awesome-stack-marker';
        marker.dataset.level = String(page.relevanceLevel ?? 1);
        marker.textContent = `${String(page.relevanceLevel ?? 1).padStart(2, '0')} skewed`;
        marker.setAttribute('aria-label', `연관도 ${marker.textContent}`); face.prepend(marker);
      }
      if (placement.branchFrom) element.dataset.branchFrom = placement.branchFrom;
      object.position.set(placement.x, 150, placement.z);
      objects.set(page.node.id, object);
      const shadow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      shadow.setAttribute('visibility', 'hidden'); shadowLayer.append(shadow);
      shadows.set(page.node.id, shadow);
    }
  }
  function update(snapshot: CrawlSnapshot) {
    if (!fixture) return;
    if (snapshot.status === 'complete' && !completionSeen) {
      completionSeen = true; completionPending = true;
    }
    const visits = visitedHistory(snapshot);
    for (const entry of visits) {
      const object = objects.get(entry.nodeId!);
      if (object && !object.parent) { object.userData.appearance = 0; scene.add(object); }
    }
    for (const edge of snapshot.edges) {
      if (arrows.has(edge.id)) continue;
      const targetNode = snapshot.nodeMap.get(edge.target);
      if (!targetNode || groupOf(targetNode) !== 'drift') continue;
      const from = objects.get(edge.source); const to = objects.get(edge.target);
      if (!from?.parent || !to?.parent) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('data-edge-id', edge.id);
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#ff0000');
      path.setAttribute('stroke-width', '1');
      floor.append(path); arrows.set(edge.id, { path, source: edge.source, target: edge.target });
    }
    if (visits.length !== visibleCount) {
      visibleCount = visits.length;
      if (autoFrame) {
        const latest = objects.get(visits[0]?.nodeId ?? '');
        if (followLatest && latest) {
          destination.copy(latest.position); destination.x += 70; destination.z += 100; distance = 1900;
        } else frameAll();
      }
    }
  }
  return {
    begin, update,
    visitStack(ids: string[]) {
      const cards = ids.map(id => objects.get(id)).filter((object): object is CSS3DObject => Boolean(object?.parent));
      if (!cards.length) return;
      const frame = fitOverview(cards.map(object => object.position), camera.aspect);
      autoFrame = false; followLatest = false;
      destination.copy(frame.center); distance = frame.distance;
    },
    reset() { clear(); fixture = null; visibleCount = 0; },
    append(next: SiteFixture, anchorId: string) {
      completionPending = false; completionSeen = false;
      const retained = new Set(next.pages.map((page) => page.node.id));
      for (const [id, object] of objects) {
        if (!retained.has(id)) { scene.remove(object); object.element.remove(); objects.delete(id); placements.delete(id); shadows.get(id)?.remove(); shadows.delete(id); }
      }
      const pages = next.pages.filter((page) => !objects.has(page.node.id));
      const anchor = next.pages.find((page) => page.node.id === anchorId)!.node;
      const batch = { ...next, root: anchor, pages };
      const additions = placeContinuation(placements, batch, anchorId);
      for (const [id, point] of additions) placements.set(id, point);
      fixture = next; addCards(pages); autoFrame = true; followLatest = true;
      destination.copy(objects.get(anchorId)!.position); destination.z += 100; distance = 1900;
    },
    focus(id: string) {
      const object = objects.get(id);
      if (!object) return;
      overview = { target: destination.clone(), distance, autoFrame, followLatest };
      autoFrame = false;
      destination.copy(object.position); distance = 850;
    },
    back() { autoFrame = overview.autoFrame; followLatest = overview.followLatest; destination.copy(overview.target); distance = overview.distance; if (autoFrame && !followLatest) frameAll(true); },
  };
}
