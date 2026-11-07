/**
 * 터미널에서 추출 결과를 내부 메타데이터까지 확인하는 도구.
 * 사용법: npm run extract -- https://example.com
 * 전체 결과는 output/ 아래 JSON으로 저장한다.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { BrowserManager } from "../src/extract/browserManager.js";
import { createPipeline } from "../src/pipeline.js";
import { createServices } from "../src/services.js";

const manager = new BrowserManager(config.browser);
const input = process.argv[2];
if (!input) {
  console.error("사용법: npm run extract -- <url>");
  process.exit(1);
}

try {
  const startedAt = Date.now();
  const deconstruct = createPipeline({ config, browserManager: manager, ...createServices(config) });
  const result = await deconstruct(input);
  const count = (predicate) => result.nodes.filter(predicate).length;

  console.log(`최종 URL : ${result.finalUrl}`);
  console.log(`소요 시간: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`노드     : 텍스트 ${count((n) => n.type === "text")}, 이미지 ${count((n) => n.type === "img")}`);
  console.log(`통계     : ${JSON.stringify(result.stats)}`);
  console.log(`경고     : ${result.warnings.join(", ") || "없음"}`);
  console.log("");
  for (const [index, node] of result.nodes.slice(0, 40).entries()) {
    const part = node.meta.segment ? ` ${node.meta.segment.method} ${node.meta.segment.part + 1}/${node.meta.segment.parts}` : "";
    const label = node.type === "text" ? `${node.meta.kind}/${node.meta.region ?? "-"}${part}` : node.meta.origin;
    console.log(`${String(index).padStart(3)} [${node.type}] (${label}) ${node.content.slice(0, 90)}`);
  }
  if (result.nodes.length > 40) console.log(`... ${result.nodes.length - 40}개 더 있음`);

  await mkdir("output", { recursive: true });
  const file = `output/${new URL(result.finalUrl).hostname}.json`;
  const nodes = result.nodes.map(({ embedding, ...node }) => node); // 벡터는 파일을 수십 MB로 키운다.
  const { weights, ...summary } = result; // 전체 쌍과 벡터는 파일을 수십 MB로 키우므로 저장하지 않는다.
  await writeFile(file, JSON.stringify({ ...summary, nodes }, null, 2));
  console.log(`\n전체 결과: ${file}`);
} catch (error) {
  console.error(`실패: ${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await manager.close();
}
