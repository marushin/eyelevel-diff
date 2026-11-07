/**
 * 서버 안에서 돌리는 다국어 임베딩. API 비용과 키가 필요 없다.
 * 다른 모델이나 멀티모달 API로 바꾸려면 같은 형태의 객체를 만들면 된다: { name, embed(texts) => number[][] }
 * 벡터는 길이 1로 정규화되어 있어 내적이 곧 코사인 유사도다.
 *
 * 2026-11-06 한국어 24개 비교 문항 측정 결과 Xenova/bge-m3가 정확도 24/24에 유사도 간격이 가장 넓었다.
 */
import { env, pipeline } from "@huggingface/transformers";

export function createLocalEmbedder({ modelId, dtype, pooling, cacheDir, batchSize }) {
  env.cacheDir = cacheDir;
  let loading = null;
  const load = () => {
    loading ??= pipeline("feature-extraction", modelId, { dtype }).catch((error) => {
      loading = null;
      throw error;
    });
    return loading;
  };

  return {
    name: `local:${modelId}:${dtype}`,
    load,
    async embed(texts) {
      const extract = await load();
      const vectors = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const output = await extract(texts.slice(start, start + batchSize), { pooling, normalize: true });
        vectors.push(...output.tolist());
        output.dispose?.();
      }
      return vectors;
    },
  };
}
