import { describe, expect, it, vi } from 'vitest';
import {
  DisposableScope,
  GraphLayoutEngine,
  LabBroadcastBus,
  measureMultilineText,
  parseLabUrlState,
  runMountStressTest,
  serializeLabUrlState,
} from '../index.ts';

describe('@akl/lab-kit', () => {
  it('disposes tracked WebGL renderers (including forceContextLoss), workers, audio, and listeners in LIFO order', () => {
    const order: string[] = [];
    const scope = new DisposableScope();

    const worker = {
      terminate: vi.fn(() => order.push('worker')),
    };
    const audio = {
      dispose: vi.fn(() => order.push('audio')),
    };
    const renderer = {
      dispose: vi.fn(() => order.push('renderer.dispose')),
      forceContextLoss: vi.fn(() => order.push('renderer.forceContextLoss')),
    };

    scope.trackWorker(worker);
    scope.trackAudio(audio);
    scope.trackThreeRenderer(renderer);

    const target = new EventTarget();
    let clicks = 0;
    scope.trackListener(target, 'ping', () => {
      clicks += 1;
    });

    target.dispatchEvent(new Event('ping'));
    expect(clicks).toBe(1);

    scope.dispose();
    target.dispatchEvent(new Event('ping'));
    expect(clicks).toBe(1);

    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(audio.dispose).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(order).toEqual(['renderer.dispose', 'renderer.forceContextLoss', 'audio', 'worker']);
  });

  it('passes 20x mount/dispose stress test and detects lingering leaks if present', async () => {
    let mountedCounter = 0;
    const report = await runMountStressTest(
      async (container) => {
        mountedCounter += 1;
        const fakeChild = { id: mountedCounter };
        container.appendChild(fakeChild as unknown as Node);
        return {
          dispose() {
            container.removeChild(fakeChild as unknown as Node);
          },
        };
      },
      20,
      { holdMs: 1 },
    );

    expect(mountedCounter).toBe(20);
    expect(report.passed).toBe(true);
    expect(report.lingeringChildCount).toBe(0);
  });

  it('parses, serializes, and broadcasts synchronized Lab state across peers', async () => {
    const qs = serializeLabUrlState({
      query: '폐교 천문대',
      seed: 8812,
      topology: 'ouroboros-loop',
      persona: 'polyglot-wild',
      transport: 'burst-and-stall',
      preset: 'sonar-night',
      debug: true,
      muted: false,
    });

    const parsed = parseLabUrlState(qs);
    expect(parsed.query).toBe('폐교 천문대');
    expect(parsed.seed).toBe(8812);
    expect(parsed.topology).toBe('ouroboros-loop');
    expect(parsed.persona).toBe('polyglot-wild');
    expect(parsed.transport).toBe('burst-and-stall');
    expect(parsed.preset).toBe('sonar-night');
    expect(parsed.debug).toBe(true);
    expect(parsed.muted).toBe(false);

    const busA = new LabBroadcastBus('workbench', 'akl-test-chan');
    const busB = new LabBroadcastBus('proto-01', 'akl-test-chan');

    const received = new Promise<string>((resolve) => {
      busB.subscribe((msg) => {
        if (msg.type === 'RUN_COMMAND') resolve(msg.query);
      });
    });

    busA.publish({
      type: 'RUN_COMMAND',
      senderId: busA.id,
      query: '역순 동기화 테스트',
      seed: 99,
      topology: 'rhizome-drift',
      persona: 'ko-periphery',
      transport: 'ritual-stream',
    });

    expect(await received).toBe('역순 동기화 테스트');
    busA.dispose();
    busB.dispose();
  });

  it('measures Korean/CJK multiline blocks and computes both d3-force-3d and elkjs layouts', async () => {
    const measured = measureMultilineText(
      '소백산 아마추어 무선 관측소에서 기록한 1999년 겨울 유성우 산란 비망록',
      { maxWidth: 140, lineHeight: 16, maxLines: 3 },
    );
    expect(measured.lines.length).toBeGreaterThanOrEqual(2);
    expect(measured.lines.length).toBeLessThanOrEqual(3);
    expect(measured.collisionRadius).toBeGreaterThan(20);

    const engine = new GraphLayoutEngine();
    const sampleNodes = [
      { id: 'node-root', parentId: null, depth: 0, state: 'query-root' as const, branchId: 'trunk' },
      { id: 'n1', parentId: 'node-root', depth: 1, state: 'tail-seed' as const, branchId: 'trunk' },
      { id: 'n2', parentId: 'n1', depth: 2, state: 'visited' as const, branchId: 'trunk' },
      { id: 'n3', parentId: 'n1', depth: 2, state: 'frontier' as const, branchId: 'trunk' },
    ];
    const sampleEdges = [
      { id: 'e1', source: 'node-root', target: 'n1', kind: 'tail-inversion' as const, traversed: true },
      { id: 'e2', source: 'n1', target: 'n2', kind: 'hyperlink' as const, traversed: true },
      { id: 'e3', source: 'n1', target: 'n3', kind: 'counterfactual-link' as const, traversed: false },
    ];

    const forceRes = await engine.compute({
      type: 'COMPUTE_LAYOUT',
      requestId: 1,
      mode: 'force-2d',
      nodes: sampleNodes,
      edges: sampleEdges,
    });
    expect(forceRes.positions).toHaveLength(4);
    expect(forceRes.positions.find((p) => p.id === 'node-root')).toEqual({
      id: 'node-root',
      x: 0,
      y: 0,
      z: 0,
    });

    const elkRes = await engine.compute({
      type: 'COMPUTE_LAYOUT',
      requestId: 2,
      mode: 'elk-layered',
      nodes: sampleNodes,
      edges: sampleEdges,
    });
    expect(elkRes.positions).toHaveLength(4);
    expect(Object.keys(elkRes.edgeRoutes)).toHaveLength(3);
  });
});
