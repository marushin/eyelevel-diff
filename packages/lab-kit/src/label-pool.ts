export interface DomLabelDescriptor {
  id: string;
  text: string;
  subtext?: string;
  x: number;
  y: number;
  opacity?: number;
  scale?: number;
  variant?: 'root' | 'seed' | 'visited' | 'frontier' | 'dead' | 'branch';
}

export interface DomLabelPool {
  readonly maxSlots: number;
  readonly rootElement: HTMLDivElement;
  update(labels: readonly DomLabelDescriptor[]): void;
  clear(): void;
  dispose(): void;
}

interface LabelSlotRecord {
  el: HTMLDivElement;
  titleEl: HTMLSpanElement;
  subEl: HTMLSpanElement;
  lastText: string;
  lastSub: string;
  lastVariant: string;
  visible: boolean;
}

/**
 * Tier-1 Zero-Reflow HTML Label Pool:
 * Pre-allocates `maxSlots` fixed DOM nodes and updates positions strictly via
 * GPU-composited `transform: translate3d(x, y, 0)` and `opacity`.
 */
export function createDomLabelPool(container: HTMLElement, maxSlots = 36): DomLabelPool {
  const layer = document.createElement('div');
  layer.className = 'akl-label-pool-layer';
  layer.style.cssText =
    'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2;contain:layout style paint;';

  const slots: LabelSlotRecord[] = [];
  for (let i = 0; i < maxSlots; i++) {
    const el = document.createElement('div');
    el.className = 'akl-pooled-label';
    el.style.cssText =
      'position:absolute;left:0;top:0;will-change:transform,opacity;opacity:0;transform:translate3d(-9999px,-9999px,0);pointer-events:none;white-space:nowrap;';

    const titleEl = document.createElement('span');
    titleEl.className = 'akl-pooled-label-title';
    const subEl = document.createElement('span');
    subEl.className = 'akl-pooled-label-sub';
    subEl.style.display = 'none';

    el.appendChild(titleEl);
    el.appendChild(subEl);
    layer.appendChild(el);

    slots.push({
      el,
      titleEl,
      subEl,
      lastText: '',
      lastSub: '',
      lastVariant: '',
      visible: false,
    });
  }

  container.appendChild(layer);

  const hideSlot = (slot: LabelSlotRecord): void => {
    if (!slot.visible) return;
    slot.visible = false;
    slot.el.style.opacity = '0';
    slot.el.style.transform = 'translate3d(-9999px, -9999px, 0)';
  };

  return {
    maxSlots,
    rootElement: layer,

    update(labels: readonly DomLabelDescriptor[]): void {
      const count = Math.min(labels.length, maxSlots);
      for (let i = 0; i < count; i++) {
        const desc = labels[i]!;
        const slot = slots[i]!;
        const variant = desc.variant ?? 'visited';

        if (slot.lastText !== desc.text) {
          slot.titleEl.textContent = desc.text;
          slot.lastText = desc.text;
        }
        const sub = desc.subtext ?? '';
        if (slot.lastSub !== sub) {
          slot.subEl.textContent = sub;
          slot.subEl.style.display = sub ? 'block' : 'none';
          slot.lastSub = sub;
        }
        if (slot.lastVariant !== variant) {
          slot.el.dataset.variant = variant;
          slot.lastVariant = variant;
        }

        const rx = Math.round(desc.x * 10) / 10;
        const ry = Math.round(desc.y * 10) / 10;
        const scale = desc.scale !== undefined ? ` scale(${Math.round(desc.scale * 100) / 100})` : '';
        slot.el.style.transform = `translate3d(${rx}px, ${ry}px, 0)${scale}`;
        slot.el.style.opacity = String(desc.opacity ?? 1);
        slot.visible = true;
      }

      for (let i = count; i < maxSlots; i++) {
        hideSlot(slots[i]!);
      }
    },

    clear(): void {
      for (const slot of slots) {
        hideSlot(slot);
      }
    },

    dispose(): void {
      if (layer.parentNode) {
        layer.parentNode.removeChild(layer);
      }
    },
  };
}
