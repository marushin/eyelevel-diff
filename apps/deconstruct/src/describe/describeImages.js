/**
 * 이미지 노드에 meta.description을 채운다. alt나 캡션이 있으면 그대로 쓰고, 없는 이미지 중
 * 큰 것부터 페이지당 정해진 개수만 Vision으로 설명한다. 실패해도 요청을 실패시키지 않는다.
 */
import { createHash } from "node:crypto";
import { BLANK_IMAGE, fetchImage, toVisionImage } from "./fetchImage.js";

const VECTOR_FILE = /\.svgz?($|\?)/i;

const GENERIC_WORDS = new Set([
  "image", "img", "photo", "picture", "pic", "banner", "icon", "thumbnail", "thumb", "logo", "untitled", "default", "placeholder", "alt",
  "이미지", "사진", "그림", "배너", "썸네일", "아이콘", "로고", "대체텍스트",
]);

/**
 * 사이트가 넣은 글자가 이미지를 설명하는지 판별한다. `2611_RM` 같은 관리 코드나 파일명, "image" 같은
 * 일반 단어를 믿으면 Vision을 건너뛰게 되어 임베딩이 코드 모양끼리 비슷해진다.
 * 규칙 기반이라 코드처럼 생긴 제품명은 Vision으로 넘어가고, 내용과 다른 문장은 잡지 못한다.
 */
export function isMeaningfulText(raw) {
  const text = (raw ?? "").trim();
  if (text.length < 2 || !/\p{L}/u.test(text)) return false;
  if (/^(https?:\/\/|www\.)/i.test(text) || /\.[a-z0-9]{2,5}$/i.test(text) && !/\s/.test(text)) return false;
  // 번호를 뗀 나머지가 일반 단어면 뜻이 없다: "image1", "이미지 2", "Banner_03"
  const withoutNumbers = text.toLowerCase().replace(/[\s_\-.()\d]+/g, "");
  if (GENERIC_WORDS.has(withoutNumbers)) return false;
  if (/\s/.test(text)) return true;
  // 띄어쓰기 없는 글자 중 관리 코드의 특징: 밑줄, 소문자 슬러그, 라틴 글자와 숫자의 조합
  if (text.includes("_")) return false;
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(text)) return false;
  return !(text.length >= 6 && /\d/.test(text) && /[a-z]/i.test(text));
}

const declaredDescription = (meta) =>
  [meta.alt, meta.caption, meta.ariaLabel, meta.title]
    .map((value) => (value ?? "").trim())
    .filter(isMeaningfulText)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(" ");

export function createImageDescriber({ describer, policy, store, limits }) {
  const cacheKey = (url) => createHash("sha256").update(`${describer?.cacheKey}\0${url}`).digest("base64");

  async function prepare(node, referer) {
    const buffer = await fetchImage(node.content, {
      policy, referer, timeoutMs: limits.fetchTimeoutMs, maxBytes: limits.maxImageBytes,
    });
    return toVisionImage(buffer, { maxEdge: limits.maxEdge, minEdge: limits.minEdge });
  }

  return async function describeImages(nodes, pageUrl) {
    store.reload();
    store.data.images ??= {};
    const stats = { declared: 0, vision: 0, cached: 0, none: 0, skipped: 0, failed: 0, calls: 0 };
    const warnings = [];
    const candidates = [];

    for (const node of nodes) {
      if (node.type !== "img") continue;
      const declared = declaredDescription(node.meta);
      if (declared) {
        node.meta.description = declared;
        node.meta.descriptionSource = "declared";
        stats.declared += 1;
        continue;
      }
      const cached = describer && store.data.images[cacheKey(node.content)];
      if (cached) {
        node.meta.description = cached;
        node.meta.descriptionSource = "vision";
        stats.cached += 1;
      } else if (describer && !VECTOR_FILE.test(node.content)) {
        candidates.push(node);
      } else {
        stats.none += 1;
      }
    }

    const area = (node) => (node.meta.width && node.meta.height ? node.meta.width * node.meta.height : limits.unknownArea);
    candidates.sort((a, b) => area(b) - area(a));
    const selected = candidates.slice(0, limits.maxPerPage);
    stats.skipped = candidates.length - selected.length;

    const prepared = await Promise.all(
      selected.map(async (node) => {
        try {
          return { node, base64: await prepare(node, pageUrl) };
        } catch {
          stats.failed += 1;
          return { node, base64: null };
        }
      }),
    );
    const blank = new Set(prepared.filter((item) => item.base64 === BLANK_IMAGE).map((item) => item.node));
    stats.blank = blank.size;
    const ready = prepared.filter((item) => item.base64 && item.base64 !== BLANK_IMAGE);
    stats.none += prepared.length - ready.length - blank.size;

    for (let start = 0; start < ready.length; start += limits.batchSize) {
      const batch = ready.slice(start, start + limits.batchSize);
      stats.calls += 1;
      try {
        const { descriptions } = await describer.find(batch.map((item, id) => ({ id, base64: item.base64 })));
        store.reload(); // 호출하는 사이 다른 프로세스가 저장했을 수 있다.
        store.data.images ??= {};
        batch.forEach((item, id) => {
          const description = descriptions.get(id)?.trim();
          if (!description) {
            stats.failed += 1;
            return;
          }
          item.node.meta.description = description;
          item.node.meta.descriptionSource = "vision";
          store.data.images[cacheKey(item.node.content)] = description;
          stats.vision += 1;
        });
        store.save();
      } catch (error) {
        stats.failed += batch.length;
        stats.lastError = error?.constructor?.name ?? "Error";
      }
    }

    if (stats.lastError === "BudgetExhaustedError") warnings.push("llm-budget-exhausted");
    if (stats.skipped) warnings.push(`vision-skipped:${stats.skipped}`);
    if (stats.failed) warnings.push(`vision-failed:${stats.failed}`);
    // 화면에 아무것도 보이지 않는 이미지는 노드로 남길 이유가 없다.
    return { nodes: nodes.filter((node) => !blank.has(node)), stats, warnings };
  };
}
