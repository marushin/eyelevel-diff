/**
 * 원문을 자르기만 하는 순수 함수들. 모든 분할은 applyBreaks를 거치므로 글자가 바뀌거나 새로 생기지 않는다.
 */
const SEPARATOR = /\s+[|│]\s+/g;
const CLAUSE = /[,;:，、；：]\s+|\s+[—–·]\s+/g;
const LONG_TOKEN_CHARS = 16;

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** 공백 단위 토큰. 띄어쓰기 없는 중국어, 일본어를 위해 긴 토큰은 단어로 더 나눈다. */
export function tokenize(text) {
  const tokens = [];
  for (const match of text.matchAll(/\S+/g)) {
    if (match[0].length <= LONG_TOKEN_CHARS) {
      tokens.push({ text: match[0], start: match.index });
      continue;
    }
    let pending = null;
    for (const { segment, index } of wordSegmenter.segment(match[0])) {
      // 구두점은 앞 토큰에 붙여, 구두점 앞에서 끊을 수 없게 한다.
      if (pending && !/[\p{L}\p{N}]/u.test(segment)) {
        pending.text += segment;
        continue;
      }
      pending = { text: segment, start: match.index + index };
      tokens.push(pending);
    }
  }
  return tokens;
}

/** 글자 위치 목록대로 자른다. minChars보다 짧은 조각은 이웃에 붙인다. */
export function applyBreaks(text, offsets, { minChars }) {
  const points = [...new Set(offsets)].filter((at) => at > 0 && at < text.length).sort((a, b) => a - b);
  const bounds = [0, ...points, text.length];
  const pieces = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const piece = text.slice(bounds[i], bounds[i + 1]).trim();
    if (!piece) continue;
    const previous = pieces.at(-1);
    if (previous && (piece.length < minChars || previous.short)) {
      const end = bounds[i + 1];
      previous.text = text.slice(previous.start, end).trim();
      previous.short = previous.text.length < minChars;
    } else {
      pieces.push({ text: piece, start: bounds[i], short: piece.length < minChars });
    }
  }
  return pieces.map((piece) => piece.text);
}

/** LLM 없이 찾는 경계: 문장 끝, 구분 기호, 그리고 지나치게 긴 문장의 절 경계. */
export function ruleBreaks(text, { maxSentenceChars }) {
  const offsets = [];
  for (const match of text.matchAll(SEPARATOR)) offsets.push(match.index + match[0].length);
  for (const { segment, index } of sentenceSegmenter.segment(text)) {
    offsets.push(index);
    if (segment.length <= maxSentenceChars) continue;
    for (const match of segment.matchAll(CLAUSE)) offsets.push(index + match.index + match[0].length);
  }
  return offsets;
}
