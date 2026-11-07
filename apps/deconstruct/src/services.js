/** 외부 API와 모델 등 무거운 의존성을 설정에 따라 만든다. 테스트는 이 파일 대신 가짜를 넣는다. */
import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { createClaudeImageDescriber } from "./describe/claudeImageDescriber.js";
import { createLocalEmbedder } from "./embed/localEmbedder.js";
import { createClaudePhraseFinder, createPhraseRefiner } from "./refine/phrases.js";
import { createClaudeBoundaryFinder } from "./segment/claudeBoundaryFinder.js";
import { CostLedger } from "./usage/costLedger.js";
import { JsonStore } from "./usage/jsonStore.js";

export function createServices(config) {
  const ledger = new CostLedger({
    store: new JsonStore(join(config.dataDir, "usage.json")),
    limitUsd: config.llmBudgetUsd,
  });
  const imageStore = new JsonStore(join(config.dataDir, "image-descriptions.json"));
  const embedder = createLocalEmbedder(config.embed);

  const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const ruleRefine = createPhraseRefiner({ limit: config.refine.maxPhrases });
  if (!hasCredentials) return { ledger, imageStore, embedder, finder: null, describer: null, refine: ruleRefine };

  const client = new Anthropic();
  const finder =
    config.segment.mode === "rule"
      ? null
      : ledger.guard(
          createClaudeBoundaryFinder({
            client, model: config.segment.model, effort: config.segment.effort, timeoutMs: config.segment.batchTimeoutMs,
          }),
          config.segment.model,
        );
  const describer =
    config.vision.maxPerPage > 0
      ? ledger.guard(
          createClaudeImageDescriber({
            client, model: config.vision.model, effort: config.vision.effort,
            timeoutMs: config.vision.batchTimeoutMs, language: config.vision.language,
          }),
          config.vision.model,
        )
      : null;
  // SEGMENT_MODE=rule은 "Claude를 부르지 않는다"는 뜻이므로 재분해에도 그대로 적용한다.
  const refine =
    config.segment.mode === "rule"
      ? ruleRefine
      : createPhraseRefiner({
          limit: config.refine.maxPhrases,
          finder: ledger.guard(
            createClaudePhraseFinder({
              client, model: config.refine.model, effort: config.refine.effort, timeoutMs: config.refine.timeoutMs,
            }),
            config.refine.model,
          ),
        });
  return { ledger, imageStore, embedder, finder, describer, refine };
}
