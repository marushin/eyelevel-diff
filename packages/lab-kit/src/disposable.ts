export type CleanupFn = () => void;

export interface ThreeLikeRenderer {
  dispose(): void;
  forceContextLoss?: () => void;
  domElement?: HTMLElement | null;
}

export interface TerminatableWorker {
  terminate(): void;
}

export interface ClosableAudio {
  close?: () => Promise<void> | void;
  dispose?: () => void;
}

/**
 * Deterministic LIFO resource tracker enforcing zero leaks across WebGL contexts,
 * requestAnimationFrame loops, Web Workers, Web Audio contexts, and DOM listeners.
 */
export class DisposableScope {
  private readonly cleanups: CleanupFn[] = [];
  private readonly abortController = new AbortController();
  private isDisposed = false;

  get disposed(): boolean {
    return this.isDisposed;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  add<T extends CleanupFn>(cleanup: T): T {
    if (this.isDisposed) {
      cleanup();
      return cleanup;
    }
    this.cleanups.push(cleanup);
    return cleanup;
  }

  /**
   * Starts a continuous `requestAnimationFrame` loop (with wrapped shader-safe `uTime = seconds % 3600`)
   * that automatically halts the instant `dispose()` is called.
   */
  trackRaf(callback: (timeMs: number, uTimeWrappedSeconds: number, dtSeconds: number) => void): () => void {
    if (this.isDisposed) return () => {};

    let active = true;
    let rafId = 0;
    let lastMs = -1;

    const schedule = (fn: FrameRequestCallback): number => {
      if (typeof globalThis.requestAnimationFrame === 'function') {
        return globalThis.requestAnimationFrame(fn);
      }
      return setTimeout(() => fn(performance.now()), 16) as unknown as number;
    };

    const cancel = (id: number): void => {
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(id);
      } else {
        clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      }
    };

    const tick: FrameRequestCallback = (nowMs) => {
      if (!active || this.isDisposed) return;
      const dtSeconds = lastMs < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (nowMs - lastMs) / 1000));
      lastMs = nowMs;
      const uTimeWrappedSeconds = (nowMs / 1000) % 3600;
      callback(nowMs, uTimeWrappedSeconds, dtSeconds);
      if (active && !this.isDisposed) {
        rafId = schedule(tick);
      }
    };

    rafId = schedule(tick);

    const stop = () => {
      if (!active) return;
      active = false;
      cancel(rafId);
    };

    this.add(stop);
    return stop;
  }

  /**
   * Attaches a DOM/EventTarget listener bound to this scope's `AbortSignal`
   * with explicit `removeEventListener` cleanup for environments with partial signal support.
   */
  trackListener<T extends EventTarget>(
    target: T,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): () => void {
    if (this.isDisposed) return () => {};

    const mergedOptions: AddEventListenerOptions =
      typeof options === 'boolean'
        ? { capture: options, signal: this.abortController.signal }
        : { ...options, signal: this.abortController.signal };

    target.addEventListener(type, listener, mergedOptions);
    const remove = () => {
      target.removeEventListener(type, listener, mergedOptions);
    };
    this.add(remove);
    return remove;
  }

  /**
   * Tracks a Web Worker and ensures `worker.terminate()` is invoked on dispose.
   */
  trackWorker<W extends TerminatableWorker>(worker: W): W {
    this.add(() => {
      worker.terminate();
    });
    return worker;
  }

  /**
   * Tracks an `AudioContext` or `ProceduralAudioBus` and closes/disposes it cleanly.
   */
  trackAudio<A extends ClosableAudio>(audio: A): A {
    this.add(() => {
      if (typeof audio.dispose === 'function') {
        audio.dispose();
      } else if (typeof audio.close === 'function') {
        void Promise.resolve(audio.close()).catch(() => {});
      }
    });
    return audio;
  }

  /**
   * Tracks a Three.js / WebGL renderer, calling `dispose()`, `forceContextLoss()`,
   * and detaching `domElement` on teardown so the browser's 16-context limit is never exhausted.
   */
  trackThreeRenderer<R extends ThreeLikeRenderer>(renderer: R): R {
    this.add(() => {
      try {
        renderer.dispose();
      } finally {
        renderer.forceContextLoss?.();
        if (renderer.domElement?.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
      }
    });
    return renderer;
  }

  /**
   * Executes all registered cleanups in reverse (LIFO) order. Idempotent.
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.abortController.abort();

    const errors: unknown[] = [];
    for (let i = this.cleanups.length - 1; i >= 0; i--) {
      try {
        this.cleanups[i]!();
      } catch (err) {
        errors.push(err);
      }
    }
    this.cleanups.length = 0;

    if (errors.length > 0) {
      throw new AggregateError(errors, `DisposableScope encountered ${errors.length} cleanup error(s)`);
    }
  }
}
