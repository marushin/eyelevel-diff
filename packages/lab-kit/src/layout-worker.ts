import {
  GraphLayoutEngine,
  type LayoutComputeRequest,
  type LayoutResultPayload,
} from './layout-engine.ts';

export type WorkerIncomingMessage = LayoutComputeRequest | { type: 'RESET' };

export type WorkerOutgoingMessage =
  | ({ type: 'LAYOUT_RESULT' } & LayoutResultPayload)
  | { type: 'LAYOUT_ERROR'; requestId: number; message: string };

const engine = new GraphLayoutEngine();

let queuePromise: Promise<void> = Promise.resolve();

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerIncomingMessage>) => void) | null;
  postMessage: (msg: WorkerOutgoingMessage) => void;
};

workerScope.onmessage = (ev: MessageEvent<WorkerIncomingMessage>) => {
  const data = ev.data;
  if (!data) return;

  if (data.type === 'RESET') {
    engine.reset();
    return;
  }

  if (data.type === 'COMPUTE_LAYOUT') {
    queuePromise = queuePromise.then(async () => {
      try {
        const result = await engine.compute(data);
        workerScope.postMessage({
          type: 'LAYOUT_RESULT',
          ...result,
        });
      } catch (err) {
        workerScope.postMessage({
          type: 'LAYOUT_ERROR',
          requestId: data.requestId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
};
