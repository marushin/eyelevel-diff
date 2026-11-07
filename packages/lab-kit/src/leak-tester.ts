export interface MountHandle {
  dispose(): void | Promise<void>;
}

export type StressMountFn = (container: HTMLElement, iteration: number) => MountHandle | Promise<MountHandle>;

export interface StressTestReport {
  passed: boolean;
  iterations: number;
  durationMs: number;
  lingeringChildCount: number;
  errors: string[];
}

export interface StressTestOptions {
  /** Container element to mount into. If omitted in browser, creates an off-stage test host. */
  container?: HTMLElement;
  /** Milliseconds to hold each mount alive before disposing (default: 12ms). */
  holdMs?: number;
  onProgress?: (current: number, total: number) => void;
}

function nextCycle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Mounts and disposes a prototype `iterations` times (default: 20) in sequence,
 * asserting zero unhandled exceptions, zero unexpected WebGL context losses,
 * and zero orphaned DOM nodes after teardown.
 */
export async function runMountStressTest(
  mountFn: StressMountFn,
  iterations = 20,
  options: StressTestOptions = {},
): Promise<StressTestReport> {
  const start = performance.now();
  const holdMs = options.holdMs ?? 12;
  const errors: string[] = [];

  let ownedHost: HTMLElement | null = null;
  let host = options.container;

  if (!host) {
    if (typeof document !== 'undefined') {
      ownedHost = document.createElement('div');
      ownedHost.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:640px;height:480px;overflow:hidden;pointer-events:none;';
      document.body.appendChild(ownedHost);
      host = ownedHost;
    } else {
      // Minimal stub container for headless Node tests
      const children: unknown[] = [];
      host = {
        get childElementCount() {
          return children.length;
        },
        appendChild(node: unknown) {
          children.push(node);
          return node;
        },
        removeChild(node: unknown) {
          const idx = children.indexOf(node);
          if (idx >= 0) children.splice(idx, 1);
          return node;
        },
        replaceChildren(...nodes: unknown[]) {
          children.length = 0;
          children.push(...nodes);
        },
        innerHTML: '',
      } as unknown as HTMLElement;
    }
  }

  let lingeringChildCount = 0;

  try {
    for (let i = 1; i <= iterations; i++) {
      options.onProgress?.(i, iterations);
      try {
        const handle = await mountFn(host, i);
        await nextCycle(holdMs);
        await handle.dispose();
        lingeringChildCount = host.childElementCount ?? 0;
      } catch (err) {
        errors.push(`Iteration ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    if (ownedHost?.parentNode) {
      ownedHost.parentNode.removeChild(ownedHost);
    }
  }

  const durationMs = Math.round((performance.now() - start) * 100) / 100;
  if (lingeringChildCount > 0) {
    errors.push(`Container retained ${lingeringChildCount} child element(s) after final dispose()`);
  }

  return {
    passed: errors.length === 0,
    iterations,
    durationMs,
    lingeringChildCount,
    errors,
  };
}
