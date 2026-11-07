import { LabBroadcastBus, runMountStressTest } from '@akl/lab-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountBlankFrontend } from '../mount.ts';

const { loadingState } = vi.hoisted(() => ({ loadingState: vi.fn() }));

// Pure integration tests isolate rendering; full DOM lifecycle is also checked in the browser.
vi.mock('../render.ts', () => ({ createFrontend: () => ({ begin() {}, update() {}, setLoading: loadingState }) }));
vi.mock('@akl/lab-kit', async (original) => ({
  ...await original<typeof import('@akl/lab-kit')>(), createLabPanel: vi.fn(),
}));

function createElement(): HTMLElement {
  const children: HTMLElement[] = [];
  const element = {
    style: { cssText: '' },
    parentNode: null as HTMLElement | null,
    get childElementCount() { return children.length; },
    appendChild(child: HTMLElement) {
      children.push(child);
      Object.assign(child, { parentNode: element });
      return child;
    },
    removeChild(child: HTMLElement) {
      children.splice(children.indexOf(child), 1);
      Object.assign(child, { parentNode: null });
      return child;
    },
  };
  return element as unknown as HTMLElement;
}

describe('site map session integration', () => {
  beforeEach(() => {
    vi.useFakeTimers(); loadingState.mockClear();
    vi.stubGlobal('document', { createElement, body: createElement() });
    vi.stubGlobal('BroadcastChannel', undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preserves existing mock data and non-destructive branch awakening', async () => {
    const host = createElement();
    const handle = mountBlankFrontend(host, {
      isolatedTest: true, search: '?q=백지&seed=123&transport=instant-dump',
    });
    try {
      await handle.ready;
      await vi.runAllTimersAsync();
      const snapshot = handle.session.getSnapshot();
      expect(snapshot.query).toBe('백지');
      expect(snapshot.seed).toBe(123);
      expect(snapshot.status).toBe('complete');
      expect(snapshot.nodes.length).toBe(19);
      expect(snapshot.edges.length).toBeGreaterThan(0);
      const frontier = snapshot.nodes.find((node) => node.state === 'visited')!;
      expect(handle.awakenBranch(frontier.id)).not.toBeNull();
      await vi.runAllTimersAsync();
      expect(handle.session.getSnapshot().nodeMap.get(frontier.id)?.state).toBe('visited');
      expect(handle.session.getSnapshot().nodes.length).toBeGreaterThan(snapshot.nodes.length);
    } finally {
      handle.dispose();
    }
    expect(host.childElementCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults the application to the same-origin API without a frontend environment variable', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ good: [], awesome: {} }));
    vi.stubGlobal('fetch', fetcher);
    const handle = mountBlankFrontend(createElement(), { initialQuery: '실제 검색' });
    try {
      await vi.runAllTimersAsync();
      await handle.ready;
      expect(fetcher).toHaveBeenCalledTimes(1);
      const request = new URL(fetcher.mock.calls[0]![0] as string);
      expect(request.pathname).toBe('/search');
      expect(request.searchParams.get('query')).toBe('실제 검색');
      expect(handle.session.getSnapshot().nodes).toHaveLength(1);
    } finally { handle.dispose(); }
  });

  it('keeps loading active for the latest request and clears it on success or failure', async () => {
    const pending: ((value: Response) => void)[] = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise<Response>(resolve => pending.push(resolve));
    }));
    const handle = mountBlankFrontend(createElement(), {
      isolatedTest: true, search: '?q=first&transport=instant-dump', apiEndpoint: 'https://api.test',
    });
    try {
      expect(loadingState.mock.calls).toEqual([[true]]);
      const second = handle.startRun({ query: 'second' });
      expect(signals[0]!.aborted).toBe(true);
      pending[0]!(new Response(JSON.stringify({ good: [], awesome: {} })));
      await handle.ready;
      expect(loadingState.mock.calls).toEqual([[true], [true]]);
      pending[1]!(new Response(JSON.stringify({ good: [], awesome: {} })));
      await second;
      expect(loadingState).toHaveBeenLastCalledWith(false);
      const failed = handle.startRun({ query: 'failure' });
      expect(loadingState).toHaveBeenLastCalledWith(true);
      pending[2]!(new Response('', { status: 500 })); await failed;
      expect(loadingState).toHaveBeenLastCalledWith(false);
    } finally { handle.dispose(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues from a selected card without losing prior pages or history', async () => {
    const handle = mountBlankFrontend(createElement(), {
      isolatedTest: true, search: '?q=사과&transport=instant-dump',
    });
    try {
      await handle.ready; await vi.runAllTimersAsync();
      const before = handle.session.getSnapshot();
      const selected = before.nodes.find((node) => node.state === 'visited')!;
      const pending = handle.continueSearch(selected.id);
      await vi.runAllTimersAsync(); await pending;
      const after = handle.session.getSnapshot();
      expect(after.nodes).toHaveLength(37);
      expect(after.query).toBe(selected.content!.title);
      for (const node of before.nodes) expect(after.nodeMap.get(node.id)).toEqual(node);
      expect(after.edges.some((edge) => edge.source === selected.id && edge.target.startsWith('search-1:'))).toBe(true);
      expect(after.history.length).toBeGreaterThan(before.history.length);
      expect(after.status).toBe('complete');
      const again = handle.continueSearch(selected.id);
      await vi.runAllTimersAsync(); await again;
      expect(handle.session.getSnapshot().nodes).toHaveLength(55);
    } finally { handle.dispose(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives 20 mounts with active streams and cancels every timer on dispose', async () => {
    const reportPromise = runMountStressTest((host) => {
      const handle = mountBlankFrontend(host, { isolatedTest: true, initialQuery: '스트레스 검사' });
      return {
        dispose() {
          handle.dispose();
          expect(vi.getTimerCount()).toBe(0);
        },
      };
    }, 20, { container: createElement(), holdMs: 4 });
    await vi.runAllTimersAsync();
    const report = await reportPromise;
    expect(report.passed).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.lingeringChildCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('announces readiness and follows workbench commands without echoing them', async () => {
    const workbench = new LabBroadcastBus('test-workbench');
    const receive = vi.fn();
    workbench.subscribe(receive);
    const host = createElement();
    const handle = mountBlankFrontend(host, { search: '?transport=instant-dump', apiEndpoint: '' });
    try {
      expect(receive).toHaveBeenCalledWith(expect.objectContaining({
        type: 'PROTOTYPE_READY', slug: '06-card-stack', activePreset: 'blank',
      }));
      await handle.ready;
      await vi.runAllTimersAsync();
      receive.mockClear();
      workbench.publish({
        type: 'RUN_COMMAND', senderId: workbench.id, query: '동기화', seed: 99,
        topology: 'rhizome-drift', persona: 'ko-periphery', transport: 'instant-dump',
      });
      await vi.runAllTimersAsync();
      expect(handle.session.getSnapshot().query).toBe('동기화');
      expect(handle.session.getSnapshot().seed).toBe(99);
      const frontier = handle.session.getSnapshot().nodes.find((node) => node.state === 'visited')!;
      workbench.publish({ type: 'AWAKEN_BRANCH', senderId: workbench.id, nodeId: frontier.id });
      await vi.runAllTimersAsync();
      expect(handle.session.getSnapshot().nodeMap.get(frontier.id)?.state).toBe('visited');
      expect(receive).not.toHaveBeenCalled();
    } finally {
      handle.dispose();
      workbench.dispose();
    }
    expect(host.childElementCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
