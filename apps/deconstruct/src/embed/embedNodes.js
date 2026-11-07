/** 텍스트와 이미지를 같은 벡터 공간에 넣는다. 이미지는 설명 글자로 근사하며 시각 정보를 직접 쓰지는 않는다. */
import { errors } from "../errors.js";

const NEARBY_CHARS = 200;

/** 설명이 없는 이미지는 문서에서 앞뒤에 있는 글자로 대신한다. */
function nearbyText(nodes, index) {
  const parts = [];
  for (const step of [-1, 1]) {
    for (let i = index + step; i >= 0 && i < nodes.length; i += step) {
      if (nodes[i].type === "text") {
        parts.push(nodes[i].content);
        break;
      }
    }
  }
  return parts.join(" ").slice(0, NEARBY_CHARS);
}

export function embeddingInput(nodes, index) {
  const node = nodes[index];
  if (node.type === "text") return { text: node.content, source: "text" };
  if (node.meta.description) return { text: node.meta.description, source: node.meta.descriptionSource };
  const nearby = nearbyText(nodes, index);
  if (nearby) return { text: nearby, source: "nearby" };
  const fileName = decodeURIComponent(new URL(node.content).pathname.split("/").pop() || "image");
  return { text: fileName, source: "filename" };
}

export async function embedNodes(nodes, embedder) {
  const inputs = nodes.map((_, index) => embeddingInput(nodes, index));
  let vectors;
  try {
    vectors = await embedder.embed(inputs.map((input) => input.text));
  } catch {
    throw errors.embeddingFailed();
  }
  nodes.forEach((node, index) => {
    node.embedding = vectors[index];
    node.meta.embeddingSource = inputs[index].source;
    // 재검색어로 쓸 수 있는 이미지의 뜻. 파일명은 뜻이 아니므로 내보내지 않는다.
    if (node.type === "img" && inputs[index].source !== "filename") node.meta.label = inputs[index].text;
  });
  return { dim: vectors[0]?.length ?? 0, model: embedder.name };
}

export async function embedQuery(query, embedder) {
  try {
    const [vector] = await embedder.embed([query]);
    return vector;
  } catch {
    throw errors.embeddingFailed();
  }
}
