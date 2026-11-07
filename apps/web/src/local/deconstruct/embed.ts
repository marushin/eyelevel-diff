/**
 * 임베딩 Worker의 클라이언트와 원본 apps/deconstruct/src/embed/embedNodes.js의 노드 임베딩.
 * 벡터는 길이 1로 정규화되어 있어 내적이 곧 코사인 유사도다.
 */
import { errors } from '../errors.ts';
import { config } from './config.ts';
import type { PageNode } from './extract.ts';

export interface Embedder { name: string; embed(texts: string[]): Promise<number[][]> }
export type EmbedderState =
  | { status: 'idle' }
  | { status: 'loading'; loaded: number; total: number }
  | { status: 'ready'; device: string }
  | { status: 'error'; message: string };

type Listener = (state: EmbedderState) => void;

class WorkerEmbedder implements Embedder {
  readonly name = `local:${config.embed.modelId}`;
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve(vectors: number[][]): void; reject(error: Error): void }>();
  private files = new Map<string, { loaded: number; total: number }>();
  private listeners = new Set<Listener>();
  state: EmbedderState = { status: 'idle' };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(state: EmbedderState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  load(): Promise<void> {
    this.loading ??= new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      this.setState({ status: 'loading', loaded: 0, total: 0 });
      worker.addEventListener('message', (event: MessageEvent) => {
        const message = event.data;
        if (message.type === 'progress' && message.file) {
          this.files.set(message.file, { loaded: message.loaded ?? 0, total: message.total ?? 0 });
          let loaded = 0;
          let total = 0;
          for (const file of this.files.values()) {
            loaded += file.loaded;
            total += file.total;
          }
          this.setState({ status: 'loading', loaded, total });
        } else if (message.type === 'ready') {
          this.setState({ status: 'ready', device: message.device });
          resolve();
        } else if (message.type === 'load-error') {
          this.setState({ status: 'error', message: message.message });
          this.loading = null;
          worker.terminate();
          reject(new Error(message.message));
        } else if (message.type === 'result' || message.type === 'error') {
          const job = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.type === 'result') job?.resolve(message.vectors);
          else job?.reject(new Error(message.message));
        }
      });
      worker.postMessage({ type: 'load', modelId: config.embed.modelId, dtype: config.embed.dtype, pooling: config.embed.pooling });
    });
    return this.loading;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    await this.load();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'embed', id, texts, batchSize: config.embed.batchSize });
    });
  }
}

export const embedder = new WorkerEmbedder();

const NEARBY_CHARS = 200;

/** 설명이 없는 이미지는 문서에서 앞뒤에 있는 글자로 대신한다. */
function nearbyText(nodes: PageNode[], index: number): string {
  const parts: string[] = [];
  for (const step of [-1, 1]) {
    for (let i = index + step; i >= 0 && i < nodes.length; i += step) {
      if (nodes[i]!.type === 'text') {
        parts.push(nodes[i]!.content);
        break;
      }
    }
  }
  return parts.join(' ').slice(0, NEARBY_CHARS);
}

export function embeddingInput(nodes: PageNode[], index: number): { text: string; source: string } {
  const node = nodes[index]!;
  if (node.type === 'text') return { text: node.content, source: 'text' };
  if (node.meta.description) return { text: node.meta.description, source: node.meta.descriptionSource };
  const nearby = nearbyText(nodes, index);
  if (nearby) return { text: nearby, source: 'nearby' };
  let fileName = 'image';
  try {
    fileName = decodeURIComponent(new URL(node.content).pathname.split('/').pop() || 'image');
  } catch {
    // 잘못된 인코딩은 기본 이름으로 둔다.
  }
  return { text: fileName, source: 'filename' };
}

export async function embedNodes(nodes: PageNode[], target: Embedder): Promise<{ dim: number; model: string }> {
  const inputs = nodes.map((_, index) => embeddingInput(nodes, index));
  let vectors: number[][];
  try {
    vectors = await target.embed(inputs.map((input) => input.text));
  } catch (error) {
    console.warn('[local] 임베딩 실패', error);
    throw errors.embeddingFailed();
  }
  nodes.forEach((node, index) => {
    node.embedding = vectors[index];
    node.meta.embeddingSource = inputs[index]!.source;
    // 재검색어로 쓸 수 있는 이미지의 뜻. 파일명은 뜻이 아니므로 내보내지 않는다.
    if (node.type === 'img' && inputs[index]!.source !== 'filename') node.meta.label = inputs[index]!.text;
  });
  return { dim: vectors[0]?.length ?? 0, model: target.name };
}

export async function embedQuery(query: string, target: Embedder): Promise<number[]> {
  try {
    const [vector] = await target.embed([query]);
    return vector!;
  } catch {
    throw errors.embeddingFailed();
  }
}
