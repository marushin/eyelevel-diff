import { describe, expect, it } from 'vitest';
import { CrawlSession, TOPOLOGY_PRESETS } from '@akl/graph-contract';
import { createSiteFixture, shortenLink, visitedHistory, fixtureEvents } from '../data.ts';
import { layoutFixture } from '../layout.ts';

describe('existing simulator display adapter', () => {
  it.each(TOPOLOGY_PRESETS)('composes exactly 10 + 8 pages with valid relations for %s', (topology) => {
    const options = { query: '사과 만드는 법', seed: 4201, topology };
    const fixture = createSiteFixture(options);
    expect(fixture.pages).toHaveLength(18);
    expect(fixture.pages.filter(page => page.group === 'drift').map(page => page.relevanceLevel).sort()).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(fixture.pages.filter((page) => page.group === 'original')).toHaveLength(10);
    expect(fixture.pages.filter((page) => page.group === 'drift')).toHaveLength(8);
    expect(fixture.pages.every((page) => page.href === page.node.url)).toBe(true);
    const ids = new Set([fixture.root.id, ...fixture.pages.map((page) => page.node.id)]);
    expect(ids.size).toBe(19);
    expect(fixture.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(fixture.pages.every((page) => fixture.edges.some((edge) =>
      edge.target === page.node.id && edge.source === page.node.parentId))).toBe(true);
    const session = new CrawlSession();
    try {
      session.prepareExternalRun(options);
      session.enqueue(fixtureEvents(fixture, options)); session.flush();
      expect(session.getSnapshot().nodes).toHaveLength(19);
      expect(visitedHistory(session.getSnapshot())).toHaveLength(18);
    } finally { session.dispose(); }
  });

  it('shortens long visible URLs without changing the link target', () => {
    expect(shortenLink('https://example.com/a/long/path', 20)).toBe('https://example.com…');
    expect(shortenLink('https://a.co')).toBe('https://a.co');
  });

  it.each(TOPOLOGY_PRESETS)('lays out %s without overlaps or new connections', (topology) => {
    const fixture = createSiteFixture({ query: '연결', seed: 42, topology });
    const before = JSON.stringify(fixture);
    const positions = layoutFixture(fixture);
    expect(layoutFixture(fixture)).toEqual(positions);
    expect(positions.size).toBe(fixture.pages.length + 1);
    expect(positions.get(fixture.root.id)).toEqual({ x: 0, y: 0, radius: 138 });
    expect([...positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    const points = [...positions.values()];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!; const b = points[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.radius + b.radius + 20);
      }
    }
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it('lists actual visits newest first and excludes unvisited frontier discoveries', async () => {
    const session = new CrawlSession();
    try {
      await session.startRun({ query: '사과', seed: 4201, immediate: true });
      const snapshot = session.getSnapshot();
      const history = visitedHistory(snapshot);
      expect(history.length).toBeGreaterThan(0);
      expect(history.every((entry) => entry.action !== 'frontier-offered')).toBe(true);
      expect(history[0]).toEqual(snapshot.history.filter((entry) =>
        entry.nodeId && ['inversion-pick', 'hop-visited', 'dead-end', 'branch-awakened'].includes(entry.action)).at(-1));
      const frontier = snapshot.nodes.find((node) => node.state === 'frontier')!;
      expect(history.some((entry) => entry.nodeId === frontier.id)).toBe(false);
    } finally { session.dispose(); }
  });
});


describe('concurrent trunk and branch growth', () => {
  it.each([1, 42, 4201, 9999])('interleaves awesome before good finishes with seed %s', (seed) => {
    const options = { query: '사과', seed };
    const fixture = createSiteFixture(options);
    const events = fixtureEvents(fixture, options);
    const visits = events.flatMap((event) => event.type === 'NODE_UPSERT' && event.node.state !== 'query-root' ? [event.node] : []);
    const originals = new Set(fixture.pages.filter((page) => page.group === 'original').map((page) => page.node.id));
    const firstAwesome = visits.findIndex((node) => !originals.has(node.id));
    const lastGood = visits.findLastIndex((node) => originals.has(node.id));
    expect(firstAwesome).toBeGreaterThan(0);
    expect(firstAwesome).toBeLessThan(lastGood);
    expect(visits).toHaveLength(18);
    const seen = new Set([fixture.root.id]);
    for (const node of visits) {
      expect(seen.has(node.parentId!)).toBe(true);
      seen.add(node.id);
    }
    expect(fixtureEvents(fixture, options)).toEqual(events);
  });
});
