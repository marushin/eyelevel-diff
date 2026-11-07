/**
 * 개발 중 추출 결과를 눈으로 확인하는 페이지와 그 데이터 엔드포인트.
 * 합의한 /deconstruct 응답에는 없는 내부 메타데이터를 내보내므로 프로덕션에서는 등록하지 않는다.
 */
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const graphScript = readFileSync(new URL("./graph.js", import.meta.url), "utf8");
const NEIGHBORS = 3;

/** 가중치를 눈으로 확인하기 위한 노드별 최근접 이웃. 프론트엔드가 받는 값과 같은 숫자를 보여 준다. */
function withNeighbors(nodes, weights) {
  const scored = nodes.map(() => []);
  for (const [i, j, weight] of weights) {
    scored[i].push({ index: j, score: weight });
    scored[j].push({ index: i, score: weight });
  }
  return nodes.map(({ embedding, ...node }, index) => ({
    ...node,
    neighbors: scored[index].sort((a, b) => b.score - a.score).slice(0, NEIGHBORS),
  }));
}

export function registerViewer(app, { extract, toPublicResponse }) {
  app.get("/", (request, reply) => reply.type("text/html; charset=utf-8").send(html));
  app.get("/viewer/graph.js", (request, reply) => reply.type("text/javascript; charset=utf-8").send(graphScript));

  app.get(
    "/debug/extract",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => {
      const startedAt = Date.now();
      const result = await extract(request.query.url);
      return {
        finalUrl: result.finalUrl,
        elapsedMs: Date.now() - startedAt,
        warnings: result.warnings,
        stats: result.stats,
        nodes: withNeighbors(result.nodes, result.weights),
        response: toPublicResponse(result),
      };
    },
  );
}
