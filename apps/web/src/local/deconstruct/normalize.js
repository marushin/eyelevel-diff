/**
 * 프레임별 노드를 하나로 합치고 정리한다. 브라우저 없이 테스트할 수 있도록 순수 함수로 둔다.
 * meta는 뒤 단계(의미 분할, 이미지 설명)가 쓰는 내부 데이터이며 API 응답에는 나가지 않는다.
 */
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function imageKey(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return `img:${parsed.href}`;
}

export function normalizeNodes(frames, { maxContents }) {
  const seen = new Map();
  const nodes = [];
  let dropped = 0;

  for (const frame of frames) {
    for (const node of frame.nodes) {
      // NFC로 맞춘다. 맥에서 만든 콘텐츠의 NFD 한글이 같은 글자로 비교되지 않는 문제를 막는다.
      const content = node.type === "text" ? node.content.normalize("NFC") : node.content;
      if (node.type === "text" && !HAS_LETTER_OR_NUMBER.test(content)) continue; // "|", "·" 같은 구분자

      const key = node.type === "text" ? `text:${content.toLowerCase()}` : imageKey(content);
      const existing = seen.get(key);
      if (existing) {
        existing.meta.occurrences += node.meta.occurrences ?? 1;
        continue;
      }
      if (nodes.length >= maxContents) {
        dropped += 1;
        continue;
      }
      const normalized = { type: node.type, content, meta: { ...node.meta, occurrences: node.meta.occurrences ?? 1, frame: node.meta.frame ?? frame.url } };
      seen.set(key, normalized);
      nodes.push(normalized);
    }
  }
  return { nodes, dropped };
}

/** 프론트엔드와 합의한 스키마로 변환한다. */
export function toPublicContents(nodes) {
  return nodes.map(({ type, content, meta }) => (type === "img" && meta?.label ? { type, content, label: meta.label } : { type, content }));
}
