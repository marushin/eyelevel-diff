import { Pane } from 'tweakpane';
import { parseLabUrlState } from './bus.ts';
import type { DisposableScope } from './disposable.ts';
import type { StressTestReport } from './leak-tester.ts';

export interface LabPanelOptions {
  title: string;
  slug: string;
  scope: DisposableScope;
  container?: HTMLElement;
  expanded?: boolean;
  initiallyVisible?: boolean;
  getPresetPayload?: () => { presetId: string; label?: string; params: Record<string, unknown> };
  getPosterCanvas?: () => HTMLCanvasElement | null;
  onRunLeakTest?: () => Promise<StressTestReport>;
  onStatus?: (message: string) => void;
}

export interface LabPanelHandle {
  readonly pane: Pane;
  setStatus(text: string): void;
  toggle(force?: boolean): boolean;
  isVisible(): boolean;
  dispose(): void;
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return Boolean((el as HTMLElement).isContentEditable);
}

/**
 * Tweakpane v4 curatorial inspector helper:
 * - Hidden (`display: none`) by default per Axiom 3 unless `?lab=1` or `?debug=1` is active.
 * - Toggled via Backquote (`` ` ``) or `Tab` when focus is outside text inputs.
 * - Wired with `[Save Preset]`, `[Capture Poster]`, and `[20x Leak Test]` endpoints on `:4400`.
 */
export function createLabPanel(options: LabPanelOptions): LabPanelHandle {
  const urlDebug = parseLabUrlState().debug;
  let visible = options.initiallyVisible ?? urlDebug;

  const host = document.createElement('div');
  host.className = 'akl-lab-tweakpane-host';
  host.style.cssText = `position:fixed;top:14px;right:14px;z-index:80;width:264px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:${visible ? 'block' : 'none'};`;

  (options.container ?? document.body).appendChild(host);

  const pane = new Pane({
    title: options.title,
    expanded: options.expanded ?? true,
    container: host,
  });

  const statusState = { status: 'ready (` or Tab to hide)' };
  const actionsFolder = pane.addFolder({ title: 'Lab Pipeline Actions', expanded: true });

  const emitStatus = (msg: string) => {
    statusState.status = msg;
    pane.refresh();
    options.onStatus?.(msg);
  };

  const toggle = (force?: boolean): boolean => {
    visible = force !== undefined ? force : !visible;
    host.style.display = visible ? 'block' : 'none';
    return visible;
  };

  if (typeof window !== 'undefined') {
    window.addEventListener(
      'keydown',
      (ev: KeyboardEvent) => {
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
        const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
        if (isEditableElement(activeEl)) return;

        if (ev.code === 'Backquote' || ev.key === '`' || ev.key === 'Tab') {
          ev.preventDefault();
          toggle();
        }
      },
      { signal: options.scope.signal },
    );
  }

  if (options.getPresetPayload) {
    actionsFolder.addButton({ title: 'Save Preset' }).on('click', async () => {
      try {
        const payload = options.getPresetPayload!();
        emitStatus('saving preset…');
        const res = await fetch('/__lab/save-preset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: options.slug,
            presetId: payload.presetId,
            label: payload.label ?? payload.presetId,
            params: payload.params,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        emitStatus(`saved: ${payload.presetId}`);
      } catch (err) {
        emitStatus(`preset err: ${err instanceof Error ? err.message : 'offline'}`);
      }
    });
  }

  if (options.getPosterCanvas) {
    actionsFolder.addButton({ title: 'Capture Poster' }).on('click', async () => {
      try {
        const canvas = options.getPosterCanvas!();
        if (!canvas) {
          emitStatus('no canvas found');
          return;
        }
        emitStatus('capturing poster…');
        let dataUrl = canvas.toDataURL('image/webp', 0.9);
        if (!dataUrl.startsWith('data:image/webp')) {
          dataUrl = canvas.toDataURL('image/png');
        }
        const res = await fetch('/__lab/save-poster', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: options.slug,
            dataUrl,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        emitStatus('poster.webp saved');
      } catch (err) {
        emitStatus(`poster err: ${err instanceof Error ? err.message : 'offline'}`);
      }
    });
  }

  if (options.onRunLeakTest) {
    actionsFolder.addButton({ title: '20x Leak Test' }).on('click', async () => {
      emitStatus('running 20x mount/dispose…');
      const report = await options.onRunLeakTest!();
      if (report.passed) {
        emitStatus(`PASS 20x (${report.durationMs}ms)`);
      } else {
        emitStatus(`FAIL (${report.errors[0] ?? 'leak'})`);
      }
    });
  }

  actionsFolder.addBinding(statusState, 'status', {
    readonly: true,
    label: 'lab',
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pane.dispose();
    if (host.parentNode) {
      host.parentNode.removeChild(host);
    }
  };

  options.scope.add(dispose);

  return {
    pane,
    setStatus: emitStatus,
    toggle,
    isVisible: () => visible,
    dispose,
  };
}
