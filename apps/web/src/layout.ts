import { hashString } from '@akl/graph-contract';
import type { SiteFixture } from './data.ts';
export interface Position { x: number; y: number; radius: number }

/** Repulsion, existing-link springs and collision separation; never generate graph edges. */
export function layoutFixture(fixture: SiteFixture): Map<string, Position> {
  const rootId = fixture.root.id;
  const positions = new Map<string, Position>([[rootId, { x: 0, y: 0, radius: 138 }]]);
  const pending = new Map(fixture.pages.map((page) => [page.node.id, page.node]));
  // Start pages near their actual parent, then let the network relax without angular sectors.
  while (pending.size) {
    let added = false;
    for (const [id, node] of pending) {
      const parent = positions.get(node.parentId ?? rootId);
      if (!parent) continue;
      const noise = hashString(`${fixture.query}:${id}`) / 0xffffffff;
      const heading = node.parentId === rootId ? noise * Math.PI * 2
        : Math.atan2(parent.y, parent.x) + (noise - 0.5) * 2.8;
      const distance = parent.radius + 150;
      positions.set(id, { x: parent.x + Math.cos(heading) * distance,
        y: parent.y + Math.sin(heading) * distance, radius: 40 });
      pending.delete(id); added = true;
    }
    if (!added) {
      for (const [id] of pending) {
        const angle = hashString(id) / 0xffffffff * Math.PI * 2;
        positions.set(id, { x: Math.cos(angle) * 450, y: Math.sin(angle) * 450, radius: 40 });
      }
      pending.clear();
    }
  }
  const ids = [...positions.keys()];
  const velocity = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
  const degree = new Map(ids.map((id) => [id, 0]));
  const edges = fixture.edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target));
  for (const edge of edges) {
    degree.set(edge.source, degree.get(edge.source)! + 1);
    degree.set(edge.target, degree.get(edge.target)! + 1);
  }
  const separate = (padding: number) => {
    let overlap = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]!)!; const b = positions.get(ids[j]!)!;
        let dx = b.x - a.x; let dy = b.y - a.y;
        if (dx === 0 && dy === 0) { dx = 0.01; dy = 0.01; }
        const distance = Math.hypot(dx, dy);
        const penetration = a.radius + b.radius + padding - distance;
        if (penetration <= 0) continue;
        overlap = Math.max(overlap, penetration);
        const share = ids[i] === rootId ? 1 : 0.5;
        const x = dx / distance * penetration; const y = dy / distance * penetration;
        if (share !== 1) { a.x -= x * share; a.y -= y * share; }
        b.x += x * share; b.y += y * share;
      }
    }
    return overlap;
  };
  for (let tick = 0; tick < 650; tick++) {
    const forces = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]!)!; const b = positions.get(ids[j]!)!;
        const dx = b.x - a.x; const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const strength = 14000 / (distance * distance);
        const x = dx / distance * strength; const y = dy / distance * strength;
        const fa = forces.get(ids[i]!)!; const fb = forces.get(ids[j]!)!;
        fa.x -= x; fa.y -= y; fb.x += x; fb.y += y;
      }
    }
    for (const edge of edges) {
      const a = positions.get(edge.source)!; const b = positions.get(edge.target)!;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const strength = (distance - a.radius - b.radius - 120) * 0.045 /
        Math.sqrt(Math.max(degree.get(edge.source)!, degree.get(edge.target)!));
      const x = dx / distance * strength; const y = dy / distance * strength;
      const fa = forces.get(edge.source)!; const fb = forces.get(edge.target)!;
      fa.x += x; fa.y += y; fb.x -= x; fb.y -= y;
    }
    const cooling = 1 - tick / 800;
    for (const id of ids) {
      if (id === rootId) continue;
      const p = positions.get(id)!; const v = velocity.get(id)!; const f = forces.get(id)!;
      v.x = (v.x + f.x - p.x * 0.0008) * 0.65;
      v.y = (v.y + f.y - p.y * 0.0008) * 0.65;
      p.x += Math.max(-10, Math.min(10, v.x)) * cooling;
      p.y += Math.max(-10, Math.min(10, v.y)) * cooling;
    }
    separate(48);
  }
  // Final constraint pass protects circles and the 9px URL rings after springs settle.
  for (let pass = 0; pass < 300 && separate(48) > 0.01; pass++) { /* relax contacts */ }
  return positions;
}
