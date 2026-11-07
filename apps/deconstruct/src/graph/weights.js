/**
 * 콘텐츠 사이의 의미 유사도 그래프. 프론트엔드와 합의한 계약:
 * - 임계값은 프론트엔드가 적용하므로 모든 쌍을 반환한다.
 * - 무향 그래프이므로 i < j인 쌍만 한 번씩 반환한다. 길이는 n(n-1)/2이다.
 * - 값은 코사인 유사도 [-1, 1]을 (1 + cos) / 2로 옮긴 0~1 실수다.
 */
const DECIMALS = 1e4; // 임계값 조절에 충분한 정밀도. 전체 쌍 응답의 크기를 줄인다.

/** 정규화된 벡터의 내적이 곧 코사인이다. 부동소수 오차로 범위를 벗어나지 않게 자른다. */
export function toWeight(cosine) {
  const weight = (1 + cosine) / 2;
  return Math.round(Math.min(1, Math.max(0, weight)) * DECIMALS) / DECIMALS;
}

export function computeWeights(nodes) {
  const vectors = nodes.map((node) => Float32Array.from(node.embedding));
  const weights = [];
  for (let i = 0; i < vectors.length; i += 1) {
    const a = vectors[i];
    for (let j = i + 1; j < vectors.length; j += 1) {
      const b = vectors[j];
      let cosine = 0;
      for (let k = 0; k < a.length; k += 1) cosine += a[k] * b[k];
      weights.push([i, j, toWeight(cosine)]);
    }
  }
  return weights;
}

/** 검색어와 각 노드의 유사도. weights와 같은 0~1 척도이며 contents와 순서가 같다. */
export function computeQuerySimilarities(nodes, queryVector) {
  const query = Float32Array.from(queryVector);
  return nodes.map((node) => {
    let cosine = 0;
    for (let k = 0; k < query.length; k += 1) cosine += query[k] * node.embedding[k];
    return toWeight(cosine);
  });
}

/** 프론트엔드가 임계값을 고를 때 참고할 분포. */
export function summarizeWeights(weights) {
  if (weights.length === 0) return null;
  const values = weights.map((edge) => edge[2]).sort((a, b) => a - b);
  const at = (ratio) => values[Math.floor((values.length - 1) * ratio)];
  return { edges: values.length, min: at(0), p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1) };
}
