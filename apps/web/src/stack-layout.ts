import { createRng } from '@akl/graph-contract';
import type { SiteFixture } from './data.ts';
export interface StackPlacement { x: number; z: number; stack: string; index: number; branchFrom?: string }

/** A diagonal good trunk with alternating, seeded branch directions on the same floor. */
export function layoutStacks(fixture: SiteFixture): Map<string, StackPlacement> {
  const placements = new Map<string, StackPlacement>();
  fixture.pages.filter((page) => page.group === 'original').forEach((page, index) => {
    placements.set(page.node.id, { x: -75 * index, z: index * 135, stack: 'good-trunk', index });
  });
  const groups = new Map<string, typeof fixture.pages>();
  for (const page of fixture.pages.filter((item) => item.group === 'drift')) {
    groups.set(page.node.branchId, [...(groups.get(page.node.branchId) ?? []), page]);
  }
  const rng = createRng(4201, `branch-layout:${fixture.query}`);
  let groupIndex = 0;
  for (const [key, pages] of groups) {
    const side = groupIndex % 2 === 0 ? -1 : 1;
    const heading = rng.float(-.32, .32);
    const branchFrom = pages.find((page) => placements.has(page.node.parentId ?? ''))?.node.parentId;
    const anchor = placements.get(branchFrom ?? '') ?? { x: 0, z: 0 };
    pages.forEach((page, index) => {
      const row = Math.floor(index / 3);
      const angle = heading + Math.sin(index * .7 + groupIndex) * .08;
      const across = row === 0 ? 0 : Math.ceil(row / 2) * (row % 2 ? 1 : -1) * 800;
      let outward = 800 + (index % 3) * 580;
      let x = anchor.x + side * outward * Math.cos(angle) - across * Math.sin(angle);
      let z = anchor.z + side * outward * Math.sin(angle) + across * Math.cos(angle);
      // Compact side fans retain clearance without extending into long parallel rows.
      while ([...placements.values()].some((other) => Math.abs(other.x - x) < 540 && Math.abs(other.z - z) < 750)) {
        outward += 160;
        x = anchor.x + side * outward * Math.cos(angle) - across * Math.sin(angle);
        z = anchor.z + side * outward * Math.sin(angle) + across * Math.cos(angle);
      }
      placements.set(page.node.id, { x, z, stack: `awesome:${key}`, index,
        ...(branchFrom ? { branchFrom } : {}),
      });
    });
    groupIndex++;
  }
  return placements;
}

/** Continue directly from the selected face; only awesome cards seek nearby free spaces. */
export function placeContinuation(existing: ReadonlyMap<string, StackPlacement>, batch: SiteFixture, anchorId: string) {
  const anchor = existing.get(anchorId);
  if (!anchor) throw new Error('Missing continuation anchor');
  const local = layoutStacks(batch);
  const placed = new Map<string, StackPlacement>();
  const records = new Map(batch.pages.map((page) => [page.node.id, page]));
  for (const [id, point] of local) {
    const next = { ...point, x: point.x + anchor.x - 105, z: point.z + anchor.z + 155,
      stack: `${anchorId}:${point.stack}` };
    if (records.get(id)?.group === 'drift') {
      const parent = placed.get(records.get(id)!.node.parentId ?? '') ?? anchor;
      const side = next.x < parent.x ? -1 : 1;
      while ([...existing.values(), ...placed.values()].some((old) =>
        Math.abs(next.x - old.x) < 540 && Math.abs(next.z - old.z) < 750)) next.x += side * 160;
    }
    placed.set(id, next);
  }
  return placed;
}
