import { CrawlSession, type StartRunOptions } from '@akl/graph-contract';
import {
  DisposableScope,
  createLabPanel,
  LabBroadcastBus,
  parseLabUrlState,
  runMountStressTest,
  type MountHandle,
} from '@akl/lab-kit';
import presets from '../presets.json';
import { appendSearch } from './continuation.ts';
import { fetchSearchFixture } from './search-api.ts';
import type { SiteFixture } from './data.ts';
import { createFrontend } from './render.ts';
import { createSiteFixture, fixtureEvents } from './data.ts';

const SLUG = '06-card-stack';

export interface MountBlankOptions {
  /** Disable cross-tab communication in lifecycle tests. */
  isolatedTest?: boolean;
  initialQuery?: string;
  initialSeed?: number;
  search?: string;
  apiEndpoint?: string;
  deconstructEndpoint?: string;
}

export interface BlankFrontendHandle extends MountHandle {
  readonly session: CrawlSession;
  readonly ready: Promise<void>;
  startRun(options?: Partial<StartRunOptions>): Promise<void>;
  awakenBranch(nodeId: string): string | null;
  continueSearch(nodeId: string): Promise<void>;
}

export function mountBlankFrontend(
  container: HTMLElement,
  options: MountBlankOptions = {},
): BlankFrontendHandle {
  const scope = new DisposableScope();
  const state = parseLabUrlState(options.search);
  const apiEndpoint = options.apiEndpoint ?? (options.isolatedTest ? '' : '/search');
  let runOptions: StartRunOptions = {
    query: options.initialQuery ?? state.query,
    seed: options.initialSeed ?? state.seed,
    topology: state.topology,
    persona: state.persona,
    transport: state.transport,
  };
  let activePreset = state.preset && state.preset in presets.presets
    ? state.preset : presets.defaultPreset;

  // Own only this mount's DOM so teardown cannot remove sibling content.
  const surface = document.createElement('div');
  surface.style.cssText = 'width:100%;height:100%;background:#fff;';
  container.appendChild(surface);
  scope.add(() => surface.parentNode?.removeChild(surface));

  // Disposing the session cancels its stream and scheduled backpressure frames.
  const session = new CrawlSession({ maxEventsPerFrame: 7 });
  scope.add(() => session.dispose());
  let activeStream: AbortController | null = null;
  scope.add(() => activeStream?.abort());
  let currentFixture: SiteFixture | null = null;
  let generation = 0;
  const view = createFrontend(surface, scope, (query) => { void startRun({ query }); }, options.initialQuery ?? '', (nodeId) => { void continueSearch(nodeId); }, () => {
    activeStream?.abort(); activeStream = null; currentFixture = null; generation = 0;
  }, apiEndpoint, options.deconstructEndpoint ?? (options.isolatedTest ? '' : '/deconstruct'));
  scope.add(session.subscribe((snapshot) => view.update(snapshot)));

  const bus = options.isolatedTest ? null : new LabBroadcastBus(`proto-${SLUG}-${crypto.randomUUID()}`);
  if (bus) scope.add(() => bus.dispose());

  const startRun = async (next: Partial<StartRunOptions> = {}, broadcast = true, anchorId?: string): Promise<void> => {
    if (scope.disposed) return;
    runOptions = { ...runOptions, ...next };
    if (broadcast && bus) {
      bus.publish({
        type: 'RUN_COMMAND', senderId: bus.id,
        query: runOptions.query, seed: runOptions.seed,
        topology: runOptions.topology ?? state.topology,
        persona: runOptions.persona ?? state.persona,
        transport: runOptions.transport ?? state.transport,
      });
    }
    activeStream?.abort();
    const controller = new AbortController(); activeStream = controller;
    if (!anchorId) session.prepareExternalRun(runOptions);
    else session.flush();
    view.setStatus?.(''); view.setLoading?.(true);
    let fixture: SiteFixture;
    const deadline = apiEndpoint ? setTimeout(() => controller.abort(), 122_000) : null;
    try {
      // Mock mode previews the same waiting UI; real API mode waits on the response itself.
      if (!apiEndpoint && !options.isolatedTest && !runOptions.immediate) {
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, 1000);
          controller.signal.addEventListener('abort', finish, { once: true });
        });
      }
      if (controller.signal.aborted || scope.disposed) return;
      fixture = apiEndpoint ? await fetchSearchFixture(apiEndpoint, runOptions, controller.signal)
        : createSiteFixture(runOptions);
    } catch (error) {
      if (!scope.disposed && activeStream === controller) {
        view.setStatus?.(controller.signal.aborted ? '검색 요청이 중단되었습니다. 다시 검색해주세요.'
          : error instanceof Error ? error.message : '검색에 실패했습니다');
      }
      return;
    } finally {
      if (deadline !== null) clearTimeout(deadline);
      if (!scope.disposed && activeStream === controller) view.setLoading?.(false);
    }
    if (controller.signal.aborted || scope.disposed) return;
    view.setStatus?.(fixture.pages.length ? '' : '검색 결과가 없습니다');
    let events = fixtureEvents(fixture, runOptions);
    if (anchorId && currentFixture) {
      const snapshot = session.getSnapshot();
      const liveIds = new Set(snapshot.nodes.map((node) => node.id));
      const retained = { ...currentFixture,
        pages: currentFixture.pages.filter((page) => liveIds.has(page.node.id)),
        edges: currentFixture.edges.filter((edge) => liveIds.has(edge.source) && liveIds.has(edge.target)),
      };
      const oldIds = new Set(retained.pages.map((page) => page.node.id));
      const oldEdges = new Set(retained.edges.map((edge) => edge.id));
      fixture = appendSearch(retained, fixture, anchorId, ++generation);
      events = fixtureEvents(fixture, runOptions).filter((event) => (event.type === 'RUN_COMPLETE' || event.type === 'RUN_START') ||
        (event.type === 'NODE_UPSERT' && event.node.id !== fixture.root.id && !oldIds.has(event.node.id)) ||
        (event.type === 'EDGE_UPSERT' && !oldEdges.has(event.edge.id)));
      view.append?.(fixture, anchorId);
    } else {
      generation = 0; view.begin(fixture);
    }
    currentFixture = fixture;
    for (const event of events) {
      if (controller.signal.aborted || scope.disposed) return;
      session.enqueue(event);
      if (runOptions.immediate) session.flush();
      if (!runOptions.immediate && !(options.isolatedTest && runOptions.transport === 'instant-dump') &&
        (event.type === 'NODE_UPSERT' || event.type === 'INVERSION_PROGRESS')) {
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, event.type === 'NODE_UPSERT' ? 850 : 70);
          controller.signal.addEventListener('abort', finish, { once: true });
        });
      }
    }
  };

  const continueSearch = async (nodeId: string): Promise<void> => {
    if (scope.disposed || !session.getSnapshot().nodeMap.has(nodeId)) return;
    const node = session.getSnapshot().nodeMap.get(nodeId)!;
    const keyword = node.content?.title?.trim() || node.domain;
    await startRun({ query: keyword }, false, nodeId);
  };

  const awakenBranch = (nodeId: string, broadcast = true): string | null => {
    if (scope.disposed) return null;
    const branchId = session.awakenBranch(nodeId);
    if (branchId && broadcast && bus) {
      bus.publish({ type: 'AWAKEN_BRANCH', senderId: bus.id, nodeId });
    }
    return branchId;
  };

  const announceReady = () => bus?.publish({
    type: 'PROTOTYPE_READY', senderId: bus.id, slug: SLUG,
    presets: Object.keys(presets.presets), activePreset,
  });

  if (bus) {
    scope.add(bus.subscribe((message) => {
      if (message.type === 'RUN_COMMAND') {
        void startRun({
          query: message.query, seed: message.seed,
          topology: message.topology, persona: message.persona, transport: message.transport,
        }, false);
      } else if (message.type === 'AWAKEN_BRANCH') {
        awakenBranch(message.nodeId, false);
      } else if (message.type === 'PRESET_SELECT') {
        if ((!message.targetSlug || message.targetSlug === SLUG) && message.presetId in presets.presets) {
          activePreset = message.presetId;
          announceReady();
        }
      } else if (message.type === 'STRESS_TEST' && (!message.targetSlug || message.targetSlug === SLUG)) {
        void runMountStressTest(
          (host) => mountBlankFrontend(host, { isolatedTest: true }),
          message.iterations,
        ).then((report) => console.info(`[${SLUG}] mount stress test`, report));
      }
    }));
    announceReady();
  }

  if (!options.isolatedTest) {
    createLabPanel({
      title: 'Hyperlink Drift', slug: SLUG, scope, container: surface,
      onRunLeakTest: () => runMountStressTest(
        (host) => mountBlankFrontend(host, { isolatedTest: true, initialQuery: '수명 주기 검사' }), 20,
      ),
    });
  }
  // Wait for a query on the entry screen. URL queries still support workbench embeds.
  const queryProvided = options.initialQuery || (state.embed && state.query) || (options.isolatedTest && state.query);
  const ready = queryProvided ? startRun({}, false) : Promise.resolve();
  return { session, ready, startRun, awakenBranch, continueSearch, dispose: () => scope.dispose() };
}
