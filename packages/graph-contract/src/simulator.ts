import {
  type CanonicalEdge,
  type CanonicalNode,
  type ContentLang,
  type CrawlEvent,
  type CrawlRunStats,
  type EdgeKind,
  type JudgementLens,
  type NodeContent,
  type NodeState,
  type PersonaPreset,
  type TopologyPreset,
  type TransportPreset,
} from './contract.ts';
import { createRng, type DeterministicRng, hashString } from './prng.ts';

export interface SimulatorOptions {
  query: string;
  seed: number;
  topology?: TopologyPreset;
  persona?: PersonaPreset;
  transport?: TransportPreset;
  /** Optional deterministic epoch base. Defaults to a seed-derived constant for snapshot parity. */
  baseTimestamp?: number;
}

export interface BranchSimulationOptions {
  parentNode: CanonicalNode;
  branchId: string;
  query: string;
  seed: number;
  persona: PersonaPreset;
  topology: TopologyPreset;
  existingNodeCount: number;
  existingEdgeCount: number;
  baseTimestamp: number;
}

interface DomainEntry {
  domain: string;
  pathTemplates: readonly string[];
  island: number;
}

const PERIPHERAL_DOMAINS: readonly DomainEntry[] = [
  {
    domain: 'sobaek-sky.pe.kr',
    pathTemplates: [
      '/~hl2kqy/log/1999-winter.htm',
      '/obs/meteor-scatter-notes.html',
      '/bbs/zboard.php?id=night_sky&no=412',
      '/archive/antenna-diy-balun.htm',
    ],
    island: 0,
  },
  {
    domain: 'namo-relic.neocities.org',
    pathTemplates: [
      '/diary/2002_rainy_season.html',
      '/guestbook/page_17.htm',
      '/links/forgotten_rings.html',
      '/midi_room/index_frame.htm',
    ],
    island: 0,
  },
  {
    domain: 'hyangto-archive.or.kr',
    pathTemplates: [
      '/gunji/1984/vol3_watermill.html',
      '/folklore/salt-road-oral-history.jsp',
      '/photo/ferry_crossing_1978.htm',
      '/index/missing_villages.html',
    ],
    island: 1,
  },
  {
    domain: 'moss-and-lichen.net',
    pathTemplates: [
      '/fieldnotes/jeju-gotjawal-spore.html',
      '/herbarium/specimen_088.htm',
      '/soundwalk/damp_basalt_recording.html',
      '/links/amateur_bryology.htm',
    ],
    island: 1,
  },
  {
    domain: 'zero-bbs.mireene.com',
    pathTemplates: [
      '/zboard/view.php?id=synth_diy&no=89',
      '/zboard/view.php?id=tape_loop&no=104',
      '/pds/schematic_scan_rev2.htm',
      '/profile/webmaster_1998.htm',
    ],
    island: 2,
  },
  {
    domain: 'webzine-drift.co.kr',
    pathTemplates: [
      '/issue07/alleyway_typographics.html',
      '/issue03/midnight_shortwave.html',
      '/editorial/why_we_dont_seo.htm',
      '/backnumber/1997_manifesto.html',
    ],
    island: 2,
  },
  {
    domain: 'drift-buoy-77.jp',
    pathTemplates: [
      '/telemetry/tsushima_current_2004.html',
      '/log/hydrophone_fragment.htm',
      '/memo/lighthouse_keeper.html',
      '/links/maritime_amateurs.html',
    ],
    island: 3,
  },
  {
    domain: 'tilde.town',
    pathTemplates: [
      '/~archivist/gopher-bridge.html',
      '/~solstice/hypertext-garden.html',
      '/~kestrel/dead-webring-map.html',
      '/~ echo/low-tech-solar-log.html',
    ],
    island: 3,
  },
];

const CONSENSUS_NOISE_TITLES: readonly string[] = [
  'Top 10 Ultimate Guides & Sponsored Buying Picks (2026 Updated)',
  'Official Wikipedia Overview — Mainstream Consensus Entry',
  ' viral-trend-hub.com: Everything You Need To Know Right Now',
  'AI Generated SEO Summary — 50 Best Tips Ranked',
  'Enterprise Solutions Portal — Book a Demo Today',
  'Breaking Aggregator Feed — Curated For Your Profile',
];

const KO_ANCHOR_PHRASES: readonly string[] = [
  '예전 개인 홈페이지 링크모음에서 건져올린 글',
  '주인장이 2003년에 남긴 바깥 고리',
  '관련 비망록 (깨진 프레임 복원본)',
  '이웃 관측소 교신 일지 보러가기',
  '향토사료관 각주 [14] 원문 링크',
  '더 이상 갱신되지 않는 웹링 다음 칸 →',
  '구버전 제로보드 자료실 백업 사본',
  '우연히 마주친 변방의 채집 기록',
  '답글에 첨부된 외부 참고 주소',
];

const POLYGLOT_TEMPLATES: readonly {
  lang: ContentLang;
  makeTitle: (q: string, n: number) => string;
  makeSnippet: (q: string) => string;
  anchor: string;
}[] = [
  {
    lang: 'ko',
    makeTitle: (q, n) => `[비망록 #${n}] ${q}에 관한 심야 단파수신 및 변방 하이퍼텍스트 채집기 — 폐쇄된 사설 게시판 복원문서`,
    makeSnippet: (q) => `검색 상위권에서는 결코 포착되지 않는 '${q}'의 주변부 흔적과 수작업 HTML 표류 기록.`,
    anchor: '변방 사료실 색인 §3.2',
  },
  {
    lang: 'ja',
    makeTitle: (q, n) => `忘却された個人サイト巡礼記 №${n}：「${q}」をめぐる深夜のハイパーリンク漂流と観測ノート`,
    makeSnippet: (q) => `1999年から更新が止まったまま残存する「${q}」関連の私設アーカイブ断片。`,
    anchor: '相互リンク集（旧館）→',
  },
  {
    lang: 'en',
    makeTitle: (q, n) => `§${n}.4 // Counterfactual Cartography of "${q}" — Notes from an Unindexed Small-Web Observatory (1998–2005)`,
    makeSnippet: (q) => `Hand-coded HTML field dossier tracing peripheral citations around "${q}" beyond algorithmic ranking.`,
    anchor: 'cf. marginalia index [↗]',
  },
  {
    lang: 'mixed',
    makeTitle: (q, n) => `الأرشيف المفقود ∷ ${q} // Fragment_${n} [RTL/CJK Interleave ⌘ 漂流記]`,
    makeSnippet: (q) => `دفتر ملاحظات رقمي قديم حول "${q}" — 교차 언어 색인 실험실 기록.`,
    anchor: '⌘ cross-script relay →',
  },
  {
    lang: 'en',
    makeTitle: (_q, n) => `?${n}`,
    makeSnippet: (q) => `Minimalist plain-text directory node referencing ${q}.`,
    anchor: '[..]',
  },
  {
    lang: 'mojibake',
    makeTitle: (q, _n) => `뷁쀍?— [EUC-KR 헤더 손상 복원본: ${q} 1999년 여름 관측소 일지]`,
    makeSnippet: (q) => `인코딩 경계에서 반쯤 부식된 채 살아남은 '${q}' 관련 구형 웹문서 조각.`,
    anchor: '깨진 문자셋 원문 열기',
  },
];

const LENSES: readonly JudgementLens[] = [
  'the-unseen',
  'counterfactual-self',
  'meaningful-disconnection',
];

function buildNodeContent(
  rng: DeterministicRng,
  persona: PersonaPreset,
  query: string,
  domain: string,
  path: string,
  state: NodeState,
  serial: number,
  reverseRank?: number,
): NodeContent | undefined {
  if (persona === 'bare-url-only') {
    return undefined;
  }

  const cleanQ = query.trim() || '보이지 않는 웹';

  if (persona === 'polyglot-wild') {
    const tpl = rng.pick(POLYGLOT_TEMPLATES);
    return {
      title: tpl.makeTitle(cleanQ, serial),
      snippet: tpl.makeSnippet(cleanQ),
      anchorText: tpl.anchor,
      lang: tpl.lang,
      tags: ['polyglot', tpl.lang, state === 'frontier' ? 'unchosen-horizon' : 'traversed'],
      outboundCount: rng.int(2, 19),
    };
  }

  if (persona === 'visual-archive') {
    const specimenCode = `SPEC-${String(serial).padStart(3, '0')}-${hashString(domain + path).toString(16).slice(0, 4).toUpperCase()}`;
    const remoteSpecimenUrl = `https://specimen.invalid/${encodeURIComponent(domain)}${path}?q=${encodeURIComponent(cleanQ)}&code=${specimenCode}`;
    return {
      title: `[채집 표본 ${specimenCode}] ${cleanQ} — 주변부 시각 아카이브 슬라이드`,
      snippet: `${domain}에서 발굴된 저해상도 스캔 도판과 수작업 캡션 기록 (${reverseRank ? `역순 #${reverseRank}` : `표류 단계 ${serial}`}).`,
      anchorText: rng.pick(KO_ANCHOR_PHRASES),
      lang: 'ko',
      tags: ['visual-specimen', domain.split('.')[0] ?? 'archive', specimenCode.toLowerCase()],
      imageUrl: `/api/img-proxy?url=${encodeURIComponent(remoteSpecimenUrl)}`,
      outboundCount: rng.int(3, 14),
    };
  }

  // Default: 'ko-periphery'
  if (rng.chance(0.14)) {
    return {
      title: `뷁쀍? [EUC-KR 복원 단편] ${cleanQ} — ${domain} 구버전 개인자료실`,
      snippet: `문자 인코딩이 어긋난 2000년대 초반 개인 웹페이지에서 복원한 '${cleanQ}' 관련 비망록과 외부 웹링 목록.`,
      anchorText: rng.pick(KO_ANCHOR_PHRASES),
      lang: 'mojibake',
      tags: ['euc-kr-relic', 'personal-web', 'unindexed'],
      outboundCount: rng.int(1, 9),
    };
  }

  const koTitles = [
    `${cleanQ} — 소백산 아마추어 무선·야간 관측 비망록 (${1998 + (serial % 9)}년)`,
    `[${domain}] '${cleanQ}'에 대하여 아무도 묻지 않았던 개인 홈페이지 일기장`,
    `향토사료관 미정리 철: ${cleanQ} 주변의 사라진 간이역과 구술 채록`,
    `제로보드 소모임 백업 — ${cleanQ} 관련 자작 회로도 및 테이프 루프 실험`,
    `웹진 드리프트 과월호: 알고리즘 바깥에서 읽는 '${cleanQ}'의 풍경`,
    `이끼와 현무암 채집첩 — ${cleanQ} 현장 답사 메모 (#${serial})`,
    `심야 단파수신 일지 HL2KQY: ${cleanQ} 교신 파편 기록`,
    `오래된 웹링의 마지막 정거장 — ${cleanQ} 관련 수작업 링크 색인`,
  ];

  const koSnippets = [
    `포털 검색 첫 페이지에서는 지워진 '${cleanQ}'의 개인적 기억과 하이퍼링크 흔적을 손수 엮어 둔 정적 HTML 문서.`,
    `마지막 수정일 2004년 11월. 깨진 배너 이미지 아래로 '${cleanQ}'와 연결된 낯선 이웃 사이트들의 주소가 남아 있다.`,
    `방문자 카운터 000418에서 멈춘 변방 페이지. '${cleanQ}'에서 출발해 전혀 다른 사유로 건너가는 징검다리 문장들.`,
    `상업적 추천 피드 대신 웹마스터가 직접 주석을 달아 둔 '${cleanQ}' 주변부 아카이브 연결망.`,
  ];

  const includeSpecimenImage = rng.chance(0.28);
  const imgUrl = includeSpecimenImage
    ? `/api/img-proxy?url=${encodeURIComponent(`https://relic.invalid/${domain}${path}?q=${encodeURIComponent(cleanQ)}&n=${serial}`)}`
    : undefined;

  return {
    title: rng.pick(koTitles),
    snippet: rng.pick(koSnippets),
    anchorText: rng.pick(KO_ANCHOR_PHRASES),
    lang: 'ko',
    tags: [
      reverseRank ? `tail-#${reverseRank}` : 'drift-hop',
      state === 'frontier' ? 'counterfactual' : 'visited-trace',
      domain.split('.')[0] ?? 'web',
    ],
    ...(imgUrl ? { imageUrl: imgUrl } : {}),
    outboundCount: rng.int(2, 16),
  };
}

function computeStats(nodes: readonly CanonicalNode[], branches: Set<string>, elapsedMs: number): CrawlRunStats {
  let visitedCount = 0;
  let frontierCount = 0;
  let deadCount = 0;
  let redirectedCount = 0;
  let maxDepth = 0;

  for (const n of nodes) {
    if (n.depth > maxDepth) maxDepth = n.depth;
    if (n.state === 'visited' || n.state === 'tail-seed') visitedCount++;
    else if (n.state === 'frontier') frontierCount++;
    else if (n.state === 'dead') deadCount++;
    else if (n.state === 'redirected') redirectedCount++;
  }

  return {
    totalNodes: nodes.length,
    visitedCount,
    frontierCount,
    deadCount,
    redirectedCount,
    branchCount: branches.size,
    maxDepth,
    elapsedMs,
  };
}

/**
 * Generates the complete deterministic sequence of `CrawlEvent`s for a simulation run.
 * Zero `Math.random()` or wall-clock `Date.now()` calls are used.
 */
export function generateSimulatedEvents(options: SimulatorOptions): CrawlEvent[] {
  const query = options.query.trim() || '보이지 않는 웹';
  const seed = options.seed >>> 0;
  const topology: TopologyPreset = options.topology ?? 'rhizome-drift';
  const persona: PersonaPreset = options.persona ?? 'ko-periphery';
  const transport: TransportPreset = options.transport ?? 'ritual-stream';

  const rng = createRng(seed, `${query}::${topology}::${persona}`);
  const baseTs = options.baseTimestamp ?? 1_762_000_000_000 + (seed % 500_000) * 1000;
  let clockOffsetMs = 0;
  const nextTs = (stepMs = 120): number => {
    clockOffsetMs += stepMs;
    return baseTs + clockOffsetMs;
  };

  const events: CrawlEvent[] = [];
  const nodes: CanonicalNode[] = [];
  const branches = new Set<string>(['trunk']);
  let nodeSerial = 0;
  let edgeSerial = 0;

  const totalSearchHits = rng.int(142_000, 4_890_000);
  const tailWindowStart = 170;
  const tailWindowEnd = 200;

  events.push({
    type: 'RUN_START',
    query,
    seed,
    totalSearchHits,
    tailWindowStart,
    tailWindowEnd,
    topology,
    persona,
    transport,
  });

  // 1. Query Root Node (depth 0)
  const rootNode: CanonicalNode = {
    id: 'node-root',
    url: `query://${encodeURIComponent(query)}`,
    domain: 'reverse-index.local',
    path: `/?q=${encodeURIComponent(query)}`,
    parentId: null,
    depth: 0,
    state: 'query-root',
    branchId: 'trunk',
    discoveredAt: nextTs(20),
    visitedAt: baseTs + 20,
    httpStatus: 200,
    latencyMs: 12,
    ...(persona === 'bare-url-only'
      ? {}
      : {
          content: {
            title: `역순 질의: "${query}"`,
            snippet: `상위 1~169위 알고리즘 합의를 건너뛰고 #${tailWindowStart}~#${tailWindowEnd} 심해 변방에서 출발합니다.`,
            lang: 'ko',
            tags: ['query-origin', topology],
          },
        }),
  };
  nodes.push(rootNode);
  events.push({ type: 'NODE_UPSERT', node: rootNode });

  // 2. Dramatic Inversion Dive Progress (#001 -> #198)
  const rankCheckpoints = [1, 18, 47, 89, 134, 168, 183, 196, 198];
  for (let i = 0; i < rankCheckpoints.length; i++) {
    const rank = rankCheckpoints[i]!;
    const sampleTitle =
      rank < 165
        ? rng.pick(CONSENSUS_NOISE_TITLES)
        : `[변방 포착 #${rank}] ${query} — 색인 경계 바깥의 개인 아카이브`;
    events.push({
      type: 'INVERSION_PROGRESS',
      currentRank: rank,
      totalRanks: tailWindowEnd,
      sampleTitle,
    });
  }

  const makeNode = (params: {
    parentId: string;
    depth: number;
    state: NodeState;
    branchId?: string;
    reverseRank?: number;
    preferredIsland?: number;
    forceDead?: boolean;
  }): CanonicalNode => {
    nodeSerial += 1;
    const id = `node-${String(nodeSerial).padStart(3, '0')}`;
    const islandCandidates =
      params.preferredIsland !== undefined
        ? PERIPHERAL_DOMAINS.filter((d) => d.island === params.preferredIsland)
        : PERIPHERAL_DOMAINS;
    const domainEntry = rng.pick(islandCandidates.length > 0 ? islandCandidates : PERIPHERAL_DOMAINS);
    const basePath = rng.pick(domainEntry.pathTemplates);
    const suffix = basePath.includes('?') ? `&ref=${nodeSerial}` : `#frag-${nodeSerial}`;
    const path = `${basePath}${ nodeSerial > 8 ? suffix : '' }`;
    const url = `https://${domainEntry.domain}${path}`;

    const finalState: NodeState = params.forceDead ? 'dead' : params.state;
    const httpStatus =
      finalState === 'dead'
        ? rng.pick([404, 410, 504] as const)
        : finalState === 'redirected'
          ? 301
          : 200;

    const discoveredAt = nextTs(65);
    const visitedAt =
      finalState === 'visited' || finalState === 'tail-seed'
        ? discoveredAt + rng.int(18, 95)
        : undefined;

    const lens = rng.pick(LENSES);
    const content = buildNodeContent(
      rng,
      persona,
      query,
      domainEntry.domain,
      basePath,
      finalState,
      nodeSerial,
      params.reverseRank,
    );

    const node: CanonicalNode = {
      id,
      url,
      domain: domainEntry.domain,
      path,
      parentId: params.parentId,
      depth: params.depth,
      ...(params.reverseRank !== undefined ? { reverseRank: params.reverseRank } : {}),
      state: finalState,
      branchId: params.branchId ?? 'trunk',
      discoveredAt,
      ...(visitedAt !== undefined ? { visitedAt } : {}),
      httpStatus,
      latencyMs: finalState === 'dead' ? rng.int(950, 2400) : rng.int(38, 420),
      judgement: {
        connection: rng.float(0.24, 0.94),
        novelty: rng.float(0.48, 0.99),
        lens,
      },
      ...(content ? { content } : {}),
    };

    nodes.push(node);
    return node;
  };

  const emitNodeAndEdge = (
    node: CanonicalNode,
    sourceId: string,
    kind: EdgeKind,
    traversed: boolean,
  ): void => {
    edgeSerial += 1;
    const edge: CanonicalEdge = {
      id: `edge-${String(edgeSerial).padStart(3, '0')}`,
      source: sourceId,
      target: node.id,
      kind,
      traversed,
      ...(node.content?.anchorText ? { anchorText: node.content.anchorText } : {}),
      branchId: node.branchId,
      order: edgeSerial,
    };
    events.push({ type: 'NODE_UPSERT', node });
    events.push({ type: 'EDGE_UPSERT', edge });
  };

  const emitCycleEdge = (sourceId: string, targetId: string, branchId = 'trunk'): void => {
    edgeSerial += 1;
    const edge: CanonicalEdge = {
      id: `edge-${String(edgeSerial).padStart(3, '0')}`,
      source: sourceId,
      target: targetId,
      kind: 'cycle-backlink',
      traversed: true,
      anchorText: '순환 역참조 고리 (Webring Loop)',
      branchId,
      order: edgeSerial,
    };
    events.push({ type: 'EDGE_UPSERT', edge });
  };

  // 3. Topology-specific graph synthesis
  if (topology === 'deep-abyss-chain') {
    const seedNode = makeNode({
      parentId: rootNode.id,
      depth: 1,
      state: 'tail-seed',
      reverseRank: 197,
    });
    emitNodeAndEdge(seedNode, rootNode.id, 'tail-inversion', true);

    let cursor = seedNode;
    for (let depth = 2; depth <= 22; depth++) {
      const hop = makeNode({
        parentId: cursor.id,
        depth,
        state: depth === 22 && rng.chance(0.4) ? 'dead' : 'visited',
      });
      emitNodeAndEdge(hop, cursor.id, 'hyperlink', hop.state !== 'dead');

      // Offer 1 counterfactual frontier every 2 hops so the abyss still shows unchosen doors
      if (depth % 2 === 0) {
        const side = makeNode({
          parentId: cursor.id,
          depth,
          state: 'frontier',
        });
        emitNodeAndEdge(side, cursor.id, 'counterfactual-link', false);
      }
      cursor = hop;
    }
  } else if (topology === 'nav-starburst') {
    const hubSeed = makeNode({
      parentId: rootNode.id,
      depth: 1,
      state: 'tail-seed',
      reverseRank: 191,
    });
    emitNodeAndEdge(hubSeed, rootNode.id, 'tail-inversion', true);

    const directoryHub = makeNode({
      parentId: hubSeed.id,
      depth: 2,
      state: 'visited',
    });
    emitNodeAndEdge(directoryHub, hubSeed.id, 'hyperlink', true);

    // Emit 84 frontier links + 4 visited spokes to test drip backpressure & label culling
    for (let i = 0; i < 88; i++) {
      const isVisitedSpoke = i < 4;
      const spoke = makeNode({
        parentId: directoryHub.id,
        depth: 3,
        state: isVisitedSpoke ? 'visited' : 'frontier',
      });
      emitNodeAndEdge(
        spoke,
        directoryHub.id,
        isVisitedSpoke ? 'hyperlink' : 'counterfactual-link',
        isVisitedSpoke,
      );
    }
  } else if (topology === 'ouroboros-loop') {
    const tailRanks = [194, 179];
    const ringNodes: CanonicalNode[] = [];

    for (const rank of tailRanks) {
      const seedNode = makeNode({
        parentId: rootNode.id,
        depth: 1,
        state: 'tail-seed',
        reverseRank: rank,
      });
      emitNodeAndEdge(seedNode, rootNode.id, 'tail-inversion', true);
      ringNodes.push(seedNode);

      let prev = seedNode;
      for (let d = 2; d <= 6; d++) {
        const hop = makeNode({
          parentId: prev.id,
          depth: d,
          state: 'visited',
        });
        emitNodeAndEdge(hop, prev.id, 'hyperlink', true);
        ringNodes.push(hop);

        const frontier = makeNode({
          parentId: prev.id,
          depth: d,
          state: 'frontier',
        });
        emitNodeAndEdge(frontier, prev.id, 'counterfactual-link', false);
        prev = hop;
      }
      // Close loop back to tail-seed
      emitCycleEdge(prev.id, seedNode.id);
    }

    // Cross-link the two rings into an ouroboros weave
    if (ringNodes.length >= 10) {
      emitCycleEdge(ringNodes[4]!.id, ringNodes[1]!.id);
      emitCycleEdge(ringNodes[9]!.id, ringNodes[3]!.id);
      emitCycleEdge(ringNodes[11]!.id, ringNodes[6]!.id);
    }
  } else if (topology === 'dead-end-ruins') {
    const ranks = [199, 188, 176];
    for (const rank of ranks) {
      const seedNode = makeNode({
        parentId: rootNode.id,
        depth: 1,
        state: 'tail-seed',
        reverseRank: rank,
      });
      emitNodeAndEdge(seedNode, rootNode.id, 'tail-inversion', true);

      let prev = seedNode;
      for (let d = 2; d <= 5; d++) {
        const redirectedOrVisited: NodeState = rng.chance(0.25) ? 'redirected' : 'visited';
        const hop = makeNode({
          parentId: prev.id,
          depth: d,
          state: redirectedOrVisited,
        });
        emitNodeAndEdge(
          hop,
          prev.id,
          redirectedOrVisited === 'redirected' ? 'redirect' : 'hyperlink',
          true,
        );

        // Decayed 404 ruins & surviving counterfactual frontiers (~45%+ dead across graph)
        const deadA = makeNode({ parentId: prev.id, depth: d, state: 'dead', forceDead: true });
        emitNodeAndEdge(deadA, prev.id, 'hyperlink', true);

        const deadB = makeNode({ parentId: hop.id, depth: d + 1, state: 'dead', forceDead: true });
        emitNodeAndEdge(deadB, hop.id, 'hyperlink', true);

        const survivor = makeNode({ parentId: prev.id, depth: d, state: 'frontier' });
        emitNodeAndEdge(survivor, prev.id, 'counterfactual-link', false);

        prev = hop;
      }
    }
  } else if (topology === 'archipelago-jump') {
    const islands = [0, 1, 2, 3];
    let previousBridgeNode: CanonicalNode | null = null;

    for (let idx = 0; idx < islands.length; idx++) {
      const island = islands[idx]!;
      const entryNode =
        idx === 0
          ? makeNode({
              parentId: rootNode.id,
              depth: 1,
              state: 'tail-seed',
              reverseRank: 195,
              preferredIsland: island,
            })
          : makeNode({
              parentId: previousBridgeNode!.id,
              depth: idx * 2 + 1,
              state: 'visited',
              preferredIsland: island,
            });

      if (idx === 0) {
        emitNodeAndEdge(entryNode, rootNode.id, 'tail-inversion', true);
      } else {
        emitNodeAndEdge(entryNode, previousBridgeNode!.id, 'hyperlink', true);
      }

      // Local cluster inside the same domain island
      const localVisited = makeNode({
        parentId: entryNode.id,
        depth: entryNode.depth + 1,
        state: 'visited',
        preferredIsland: island,
      });
      emitNodeAndEdge(localVisited, entryNode.id, 'hyperlink', true);

      for (let f = 0; f < 3; f++) {
        const localFrontier = makeNode({
          parentId: entryNode.id,
          depth: entryNode.depth + 1,
          state: 'frontier',
          preferredIsland: island,
        });
        emitNodeAndEdge(localFrontier, entryNode.id, 'counterfactual-link', false);
      }

      previousBridgeNode = localVisited;
    }
  } else {
    // Default: 'rhizome-drift' — balanced 3 tail seeds (#196, #183, #174), multi-hop spines,
    // rich counterfactual frontiers, cross-domain leaps, a redirect, a 404 ruin, and a cycle!
    const tailRanks = [196, 183, 174];
    const spineTips: CanonicalNode[] = [];

    for (let s = 0; s < tailRanks.length; s++) {
      const rank = tailRanks[s]!;
      const tailSeed = makeNode({
        parentId: rootNode.id,
        depth: 1,
        state: 'tail-seed',
        reverseRank: rank,
        preferredIsland: s,
      });
      emitNodeAndEdge(tailSeed, rootNode.id, 'tail-inversion', true);

      let current = tailSeed;
      const chainLength = s === 0 ? 4 : 3;

      for (let hopIdx = 0; hopIdx < chainLength; hopIdx++) {
        const depth = current.depth + 1;
        const isRedirect = s === 1 && hopIdx === 1;
        const nextVisited = makeNode({
          parentId: current.id,
          depth,
          state: isRedirect ? 'redirected' : 'visited',
        });
        emitNodeAndEdge(
          nextVisited,
          current.id,
          isRedirect ? 'redirect' : 'hyperlink',
          true,
        );

        // 2 counterfactual frontiers offered at each hop
        const frontierCount = hopIdx === 0 ? 3 : 2;
        for (let f = 0; f < frontierCount; f++) {
          const frontierNode = makeNode({
            parentId: current.id,
            depth,
            state: 'frontier',
          });
          emitNodeAndEdge(frontierNode, current.id, 'counterfactual-link', false);
        }

        // Occasional meaningful dead-end 404 relic on first spine
        if (s === 0 && hopIdx === 2) {
          const deadRelic = makeNode({
            parentId: current.id,
            depth,
            state: 'dead',
            forceDead: true,
          });
          emitNodeAndEdge(deadRelic, current.id, 'hyperlink', true);
        }

        current = nextVisited;
      }

      spineTips.push(current);
    }

    // Subtle serendipitous backlink between spine 2 tip and spine 0 tail-seed
    if (spineTips.length >= 3) {
      const targetSeed = nodes.find((n) => n.state === 'tail-seed');
      if (targetSeed) {
        emitCycleEdge(spineTips[2]!.id, targetSeed.id);
      }
    }
  }

  events.push({
    type: 'RUN_COMPLETE',
    stats: computeStats(nodes, branches, clockOffsetMs),
  });

  return events;
}

/**
 * Deterministically synthesizes a counterfactual branch expansion (`branch-N`)
 * rooted at `parentNode` without mutating or discarding any existing graph state.
 */
export function generateCounterfactualBranchEvents(
  opts: BranchSimulationOptions,
): CrawlEvent[] {
  const { parentNode, branchId, query, seed, persona, topology } = opts;
  const rng = createRng(
    seed,
    `branch::${branchId}::${parentNode.id}::${query}::${topology}::${persona}`,
  );

  const events: CrawlEvent[] = [];
  let nodeSerial = opts.existingNodeCount;
  let edgeSerial = opts.existingEdgeCount;
  let ts = opts.baseTimestamp + 5_000 + opts.existingNodeCount * 90;

  const branchLabel =
    parentNode.content?.title?.slice(0, 38) || `${parentNode.domain}${parentNode.path}`;

  events.push({
    type: 'BRANCH_AWAKENED',
    fromNodeId: parentNode.id,
    branchId,
    label: branchLabel,
  });

  let cursorId = parentNode.id;
  let cursorDepth = parentNode.depth;

  const hopCount = 3;
  for (let step = 1; step <= hopCount; step++) {
    nodeSerial += 1;
    ts += 85;
    const depth = cursorDepth + step;
    const domainEntry = rng.pick(PERIPHERAL_DOMAINS);
    const basePath = rng.pick(domainEntry.pathTemplates);
    const path = `${basePath}${basePath.includes('?') ? '&' : '?'}branch=${branchId}&hop=${step}`;
    const id = `node-${branchId}-${String(step).padStart(2, '0')}-${nodeSerial}`;

    const isDead = topology === 'dead-end-ruins' && step === hopCount && rng.chance(0.5);
    const state: NodeState = isDead ? 'dead' : 'visited';
    const content = buildNodeContent(
      rng,
      persona,
      query,
      domainEntry.domain,
      basePath,
      state,
      nodeSerial,
    );

    const visitedNode: CanonicalNode = {
      id,
      url: `https://${domainEntry.domain}${path}`,
      domain: domainEntry.domain,
      path,
      parentId: cursorId,
      depth,
      state,
      branchId,
      discoveredAt: ts,
      ...(state === 'visited' ? { visitedAt: ts + 35 } : {}),
      httpStatus: state === 'dead' ? 404 : 200,
      latencyMs: rng.int(45, 360),
      judgement: {
        connection: rng.float(0.35, 0.95),
        novelty: rng.float(0.62, 0.99),
        lens: 'counterfactual-self',
      },
      ...(content ? { content } : {}),
    };

    edgeSerial += 1;
    const visitedEdge: CanonicalEdge = {
      id: `edge-${branchId}-${edgeSerial}`,
      source: cursorId,
      target: visitedNode.id,
      kind: step === 1 ? 'branch-awaken' : 'hyperlink',
      traversed: state !== 'dead',
      ...(visitedNode.content?.anchorText ? { anchorText: visitedNode.content.anchorText } : {}),
      branchId,
      order: edgeSerial,
    };

    events.push({ type: 'NODE_UPSERT', node: visitedNode });
    events.push({ type: 'EDGE_UPSERT', edge: visitedEdge });

    // Emit 2 new counterfactual frontiers branching off this newly awakened hop
    for (let f = 1; f <= 2; f++) {
      nodeSerial += 1;
      ts += 40;
      const fDomain = rng.pick(PERIPHERAL_DOMAINS);
      const fBasePath = rng.pick(fDomain.pathTemplates);
      const fPath = `${fBasePath}#cf-${branchId}-${step}-${f}`;
      const fContent = buildNodeContent(
        rng,
        persona,
        query,
        fDomain.domain,
        fBasePath,
        'frontier',
        nodeSerial,
      );

      const frontierNode: CanonicalNode = {
        id: `node-${branchId}-cf-${step}-${f}-${nodeSerial}`,
        url: `https://${fDomain.domain}${fPath}`,
        domain: fDomain.domain,
        path: fPath,
        parentId: visitedNode.id,
        depth: depth + 1,
        state: 'frontier',
        branchId,
        discoveredAt: ts,
        httpStatus: 200,
        latencyMs: rng.int(50, 310),
        judgement: {
          connection: rng.float(0.2, 0.85),
          novelty: rng.float(0.55, 0.99),
          lens: rng.pick(LENSES),
        },
        ...(fContent ? { content: fContent } : {}),
      };

      edgeSerial += 1;
      const frontierEdge: CanonicalEdge = {
        id: `edge-${branchId}-cf-${edgeSerial}`,
        source: visitedNode.id,
        target: frontierNode.id,
        kind: 'counterfactual-link',
        traversed: false,
        ...(frontierNode.content?.anchorText
          ? { anchorText: frontierNode.content.anchorText }
          : {}),
        branchId,
        order: edgeSerial,
      };

      events.push({ type: 'NODE_UPSERT', node: frontierNode });
      events.push({ type: 'EDGE_UPSERT', edge: frontierEdge });
    }

    if (state === 'dead') {
      break;
    }
    cursorId = visitedNode.id;
  }

  return events;
}

/**
 * Streams simulated CrawlEvents according to the selected `TransportPreset`
 * (`ritual-stream`, `instant-dump`, or `burst-and-stall`).
 */
export async function streamSimulatedEvents(
  options: SimulatorOptions,
  onEvent: (event: CrawlEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const events = generateSimulatedEvents(options);
  const transport = options.transport ?? 'ritual-stream';

  if (transport === 'instant-dump') {
    for (const ev of events) {
      if (signal?.aborted) return;
      onEvent(ev);
    }
    return;
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  if (transport === 'burst-and-stall') {
    let idx = 0;
    const burstSize = 14;
    while (idx < events.length && !signal?.aborted) {
      const end = Math.min(idx + burstSize, events.length);
      for (; idx < end; idx++) {
        onEvent(events[idx]!);
      }
      if (idx < events.length) {
        await sleep(220);
      }
    }
    return;
  }

  // Default: 'ritual-stream'
  for (const ev of events) {
    if (signal?.aborted) return;
    onEvent(ev);
    if (ev.type === 'INVERSION_PROGRESS') {
      await sleep(55);
    } else if (ev.type === 'NODE_UPSERT') {
      const delay = ev.node.state === 'frontier' ? 18 : 52;
      await sleep(delay);
    } else if (ev.type === 'RUN_START') {
      await sleep(30);
    }
  }
}
