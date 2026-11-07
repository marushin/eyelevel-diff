import { buildApp } from "./app.js";
import { config } from "./config.js";
import { BrowserManager } from "./extract/browserManager.js";
import { createServices } from "./services.js";

const browserManager = new BrowserManager(config.browser);
const services = createServices(config);
const app = buildApp({ config, browserManager, services });
app.log.info(
  {
    segmentation: services.finder?.cacheKey ?? "rule-only",
    vision: services.describer?.cacheKey ?? "off",
    embedding: services.embedder.name,
    budget: services.ledger.summary(),
  },
  "services configured",
);
// 첫 요청이 느려지지 않도록 미리 불러온다. 실패하면 요청 시 다시 시도한다.
services.embedder.load().then(
  () => app.log.info("embedding model ready"),
  (error) => app.log.error({ err: error }, "embedding model failed to load"),
);

async function shutdown(signal) {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await browserManager.close();
  process.exit(0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await app.listen({ port: config.port, host: config.host });
