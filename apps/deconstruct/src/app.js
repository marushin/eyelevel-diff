import compress from "@fastify/compress";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { AppError } from "./errors.js";
import { toPublicContents } from "./extract/normalize.js";
import { createPipeline } from "./pipeline.js";
import { createPhraseRefiner, phraseSimilarities } from "./refine/phrases.js";
import { publicInternetPolicy } from "./security/urlPolicy.js";
import { registerViewer } from "./viewer/routes.js";

/** 프론트엔드와 합의한 DeconstructResponse. 직렬화 스키마가 선언되지 않은 필드를 걸러 준다. */
const deconstructResponse = {
  type: "object",
  required: ["contents", "weights"],
  properties: {
    contents: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "content"],
        properties: {
          type: { type: "string", enum: ["text", "img"] },
          content: { type: "string" },
          label: { type: "string" },
        },
      },
    },
    weights: { type: "array", items: { type: "array", items: { type: "number" } } },
    querySimilarities: { type: "array", items: { type: "number" } },
  },
};

export function buildApp({
  config,
  browserManager,
  policy = publicInternetPolicy,
  services = {},
  extract = createPipeline({ config, browserManager, policy, ...services }),
  refine = services.refine ?? createPhraseRefiner(),
  logger = { level: config.logLevel },
}) {
  const app = Fastify({ logger });
  app.register(cors, { origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",") });
  // 모든 쌍을 담은 응답은 수 MB까지 커진다. brotli 최고 압축은 너무 느려 gzip만 쓴다.
  app.register(compress, { encodings: ["gzip"], threshold: 1024 });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.info({ code: error.code }, "request rejected");
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (error.validation) {
      if (request.routeOptions.url === "/deconstruct/phrases") {
        return reply.status(400).send({ error: { code: "INVALID_TEXT", message: "text는 1~1000자여야 합니다." } });
      }
      return reply.status(400).send({ error: { code: "INVALID_URL", message: "url 쿼리 파라미터가 필요합니다." } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { code: "INTERNAL", message: "서버 오류가 발생했습니다." } });
  });

  const toPublicResponse = (result) => ({
    contents: toPublicContents(result.nodes),
    weights: result.weights,
    ...(result.querySimilarities ? { querySimilarities: result.querySimilarities } : {}),
  });

  // 압축 훅은 플러그인이 로드된 뒤 등록되는 라우트에만 적용되므로 플러그인 안에서 라우트를 만든다.
  app.register(async (routes) => {
    routes.get("/health", async () => ({ status: "ok" }));

    routes.get(
      "/deconstruct",
      {
        schema: {
          querystring: {
            type: "object",
            required: ["url"],
            properties: {
              url: { type: "string", minLength: 1 },
              query: { type: "string", maxLength: 200 },
            },
          },
          response: { 200: deconstructResponse },
        },
      },
      async (request) => {
        const result = await extract(request.query.url, { query: request.query.query });
        request.log.info({ nodes: result.nodes.length, warnings: result.warnings, ...result.stats }, "extracted");
        return toPublicResponse(result);
      },
    );

    routes.get(
      "/deconstruct/phrases",
      {
        schema: {
          querystring: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string", minLength: 1, maxLength: 1000 },
              query: { type: "string", maxLength: 200 },
            },
          },
          response: {
            200: {
              type: "object",
              required: ["phrases", "source"],
              properties: {
                phrases: { type: "array", items: { type: "string" } },
                source: { type: "string", enum: ["llm", "rule"] },
                querySimilarities: { type: "array", items: { type: "number" } },
              },
            },
          },
        },
      },
      async (request) => {
        const result = await refine(request.query.text);
        const querySimilarities = await phraseSimilarities(result.phrases, request.query.query, services.embedder);
        return querySimilarities ? { ...result, querySimilarities } : result;
      },
    );

    if (config.viewerEnabled) registerViewer(routes, { extract, toPublicResponse });
  });

  return app;
}
