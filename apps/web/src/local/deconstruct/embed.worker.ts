/// <reference lib="webworker" />
/**
 * 원본 apps/deconstruct/src/embed/localEmbedder.js를 Web Worker로 옮겼다. 같은 모델(bge-m3)을 쓰므로
 * 유사도 척도가 원본 서버와 같다. f16을 지원하는 WebGPU가 있으면 q4f16으로 먼저 쓰고, 실패하면 WASM q8로 내려간다.
 * 모델 파일은 처음 한 번만 받고 브라우저 Cache Storage에 남는다.
 */
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

interface LoadRequest { type: 'load'; modelId: string; dtype: { webgpu: string; wasm: string }; pooling: 'cls' | 'mean'; device?: 'webgpu' | 'wasm' }
interface EmbedRequest { type: 'embed'; id: number; texts: string[]; batchSize: number }
type Request = LoadRequest | EmbedRequest;

env.allowLocalModels = false;
env.useBrowserCache = true;

let extractor: Promise<FeatureExtractionPipeline> | null = null;
let pooling: 'cls' | 'mean' = 'cls';
let device = 'wasm';

const post = (message: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);

async function hasF16WebGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) return false;
  const adapter = await gpu.requestAdapter().catch(() => null);
  return !!adapter?.features.has('shader-f16');
}

function load({ modelId, dtype, pooling: nextPooling, device: forced }: LoadRequest): Promise<FeatureExtractionPipeline> {
  pooling = nextPooling;
  extractor ??= (async () => {
    const progress_callback = (event: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (event.status === 'progress') post({ type: 'progress', file: event.file, loaded: event.loaded, total: event.total });
    };
    const gpu = forced ? forced === 'webgpu' : await hasF16WebGpu();
    const attempts: ('webgpu' | 'wasm')[] = gpu ? ['webgpu', 'wasm'] : ['wasm'];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const created = await pipeline('feature-extraction', modelId, {
          dtype: dtype[attempt] as 'q8',
          device: attempt,
          progress_callback,
        });
        // 로드는 되지만 실행이 실패하는 조합이 있어 한 번 돌려 본다.
        await created(['warmup'], { pooling, normalize: true });
        device = `${attempt}/${dtype[attempt]}`;
        return created;
      } catch (error) {
        lastError = error;
        console.warn(`[embed] ${attempt} 실패, 다음 장치로`, error);
      }
    }
    throw lastError;
  })().catch((error) => {
    extractor = null;
    throw error;
  });
  return extractor;
}

self.addEventListener('message', async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
      await load(request);
      post({ type: 'ready', device });
      return;
    }
    const extract = await extractor;
    if (!extract) throw new Error('model not loaded');
    const vectors: number[][] = [];
    for (let start = 0; start < request.texts.length; start += request.batchSize) {
      const output = await extract(request.texts.slice(start, start + request.batchSize), { pooling, normalize: true });
      vectors.push(...(output.tolist() as number[][]));
      output.dispose?.();
    }
    post({ type: 'result', id: request.id, vectors });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post(request.type === 'load' ? { type: 'load-error', message } : { type: 'error', id: request.id, message });
  }
});
