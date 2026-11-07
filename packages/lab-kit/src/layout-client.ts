import {
  GraphLayoutEngine,
  type LayoutEdgeInput,
  type LayoutMode,
  type LayoutNodeInput,
  type LayoutResultPayload,
} from './layout-engine.ts';
import type { WorkerOutgoingMessage } from './layout-worker.ts';

export interface LayoutClientOptions {
  /** Force in-thread fallback instead of spawning a Web Worker (useful in unit tests). */
  preferInline?: boolean;
  onResult?: (result: LayoutResultPayload) => void;
}

/**
 * Ergonomic client around `layout-worker.ts` (supporting both `d3-force-3d` and `elkjs`),
 * keeping `elkjs` off the main thread unless inline fallback is explicitly requested.
 */
export class LayoutWorkerClient {
  private worker: Worker | null = null;
  private inlineEngine: GraphLayoutEngine | null = null;
  private useInline = false;
  private requestSeq = 0;
  private disposed = false;
  private readonly pending = new Map<
    number,
    { resolve: (res: LayoutResultPayload) => void; reject: (err: Error) => void }
  >();
  private readonly onResultCallback?: (result: LayoutResultPayload) => void;

  constructor(options: LayoutClientOptions = {}) {
    this.onResultCallback = options.onResult;

    if (!options.preferInline && typeof Worker === 'function') {
      try {
        this.worker = new Worker(new URL('./layout-worker.ts', import.meta.url), {
          type: 'module',
        });
        this.worker.onmessage = (ev: MessageEvent<WorkerOutgoingMessage>) => {
          if (this.disposed) return;
          const msg = ev.data;
          if (!msg) return;

          if (msg.type === 'LAYOUT_RESULT') {
            const waiter = this.pending.get(msg.requestId);
            if (waiter) {
              this.pending.delete(msg.requestId);
              waiter.resolve(msg);
            }
            this.onResultCallback?.(msg);
          } else if (msg.type === 'LAYOUT_ERROR') {
            const waiter = this.pending.get(msg.requestId);
            if (waiter) {
              this.pending.delete(msg.requestId);
              waiter.reject(new Error(msg.message));
            }
          }
        };
      } catch {
        this.worker = null;
        this.useInline = true;
      }
    } else {
      this.useInline = true;
    }
  }

  private ensureInlineEngine(): GraphLayoutEngine {
    if (!this.inlineEngine) {
      this.inlineEngine = new GraphLayoutEngine();
    }
    return this.inlineEngine;
  }

  async compute(params: {
    mode: LayoutMode;
    nodes: LayoutNodeInput[];
    edges: LayoutEdgeInput[];
    ringSpacing?: number;
    reset?: boolean;
  }): Promise<LayoutResultPayload> {
    if (this.disposed) {
      return { requestId: -1, mode: params.mode, positions: [], edgeRoutes: {} };
    }

    this.requestSeq += 1;
    const requestId = this.requestSeq;

    if (this.worker && !this.useInline) {
      return new Promise<LayoutResultPayload>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        this.worker!.postMessage({
          type: 'COMPUTE_LAYOUT',
          requestId,
          ...params,
        });
      });
    }

    const engine = this.ensureInlineEngine();
    const result = await engine.compute({
      type: 'COMPUTE_LAYOUT',
      requestId,
      ...params,
    });
    if (!this.disposed) {
      this.onResultCallback?.(result);
    }
    return result;
  }

  reset(): void {
    if (this.disposed) return;
    if (this.worker && !this.useInline) {
      this.worker.postMessage({ type: 'RESET' });
    } else {
      this.inlineEngine?.reset();
    }
  }

  terminate(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.pending.values()) {
      waiter.resolve({ requestId: -1, mode: 'force-2d', positions: [], edgeRoutes: {} });
    }
    this.pending.clear();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.inlineEngine?.reset();
    this.inlineEngine = null;
  }
}
