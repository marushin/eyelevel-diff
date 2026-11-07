import type { SiteFixture } from './data.ts';
import { pageRecord } from './data.ts';

/** Namespace one search batch and bind its query origin to the selected existing page. */
export function appendSearch(current: SiteFixture, incoming: SiteFixture, anchorId: string, generation: number): SiteFixture {
  const anchor = current.pages.find((page) => page.node.id === anchorId)?.node;
  if (!anchor) throw new Error('이어갈 카드를 찾을 수 없습니다');
  const ids = new Map(incoming.pages.map((page) => [page.node.id, `search-${generation}:${page.node.id}`]));
  const remap = (id: string) => ids.get(id) ?? anchorId;
  const pages = incoming.pages.map((page) => pageRecord({ ...page.node,
    id: remap(page.node.id), parentId: remap(page.node.parentId ?? incoming.root.id),
    depth: anchor.depth + page.node.depth,
    branchId: `search-${generation}:${page.node.branchId}`,
  }));
  return { ...current, query: incoming.query, pages: [...current.pages, ...pages],
    edges: [...current.edges, ...incoming.edges.map((edge) => ({ ...edge,
      id: `search-${generation}:${edge.id}`, source: remap(edge.source), target: remap(edge.target),
      branchId: `search-${generation}:${edge.branchId}`,
    }))],
  };
}
