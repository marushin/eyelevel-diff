import {
  PERSONA_PRESETS,
  type PersonaPreset,
  TOPOLOGY_PRESETS,
  type TopologyPreset,
  TRANSPORT_PRESETS,
  type TransportPreset,
} from '@akl/graph-contract';

export const LAB_CHANNEL_NAME = 'akl-webart-lab-v1';

export interface LabUrlState {
  query: string;
  seed: number;
  topology: TopologyPreset;
  persona: PersonaPreset;
  transport: TransportPreset;
  preset?: string;
  debug: boolean;
  muted: boolean;
  embed: boolean;
}

export const DEFAULT_LAB_STATE: LabUrlState = {
  query: '심야 단파수신소',
  seed: 4201,
  topology: 'rhizome-drift',
  persona: 'ko-periphery',
  transport: 'ritual-stream',
  debug: false,
  muted: true,
  embed: false,
};

export type LabBusMessage =
  | {
      type: 'RUN_COMMAND';
      senderId: string;
      query: string;
      seed: number;
      topology: TopologyPreset;
      persona: PersonaPreset;
      transport: TransportPreset;
    }
  | {
      type: 'AWAKEN_BRANCH';
      senderId: string;
      nodeId: string;
    }
  | {
      type: 'PRESET_SELECT';
      senderId: string;
      targetSlug?: string;
      presetId: string;
    }
  | {
      type: 'AUDIO_MUTE';
      senderId: string;
      muted: boolean;
    }
  | {
      type: 'STRESS_TEST';
      senderId: string;
      targetSlug?: string;
      iterations: number;
    }
  | {
      type: 'PROTOTYPE_READY';
      senderId: string;
      slug: string;
      presets: string[];
      activePreset?: string;
    };

export function parseLabUrlState(search = typeof location !== 'undefined' ? location.search : ''): LabUrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);

  const q = params.get('q')?.trim() || DEFAULT_LAB_STATE.query;
  const rawSeed = Number.parseInt(params.get('seed') ?? '', 10);
  const seed = Number.isFinite(rawSeed) ? rawSeed >>> 0 : DEFAULT_LAB_STATE.seed;

  const rawTopology = params.get('topology') as TopologyPreset | null;
  const topology: TopologyPreset =
    rawTopology && TOPOLOGY_PRESETS.includes(rawTopology)
      ? rawTopology
      : DEFAULT_LAB_STATE.topology;

  const rawPersona = params.get('persona') as PersonaPreset | null;
  const persona: PersonaPreset =
    rawPersona && PERSONA_PRESETS.includes(rawPersona)
      ? rawPersona
      : DEFAULT_LAB_STATE.persona;

  const rawTransport = params.get('transport') as TransportPreset | null;
  const transport: TransportPreset =
    rawTransport && TRANSPORT_PRESETS.includes(rawTransport)
      ? rawTransport
      : DEFAULT_LAB_STATE.transport;

  const preset = params.get('preset')?.trim() || undefined;
  const debug =
    params.get('lab') === '1' ||
    params.get('lab') === 'true' ||
    params.get('debug') === '1' ||
    params.get('debug') === 'true';
  const mutedParam = params.get('muted');
  const muted = mutedParam === null ? DEFAULT_LAB_STATE.muted : mutedParam === '1' || mutedParam === 'true';
  const embed = params.get('embed') === '1' || params.get('embed') === 'true';

  return {
    query: q,
    seed,
    topology,
    persona,
    transport,
    ...(preset ? { preset } : {}),
    debug,
    muted,
    embed,
  };
}

export function serializeLabUrlState(state: Partial<LabUrlState>): string {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.seed !== undefined) params.set('seed', String(state.seed >>> 0));
  if (state.topology) params.set('topology', state.topology);
  if (state.persona) params.set('persona', state.persona);
  if (state.transport) params.set('transport', state.transport);
  if (state.preset) params.set('preset', state.preset);
  if (state.debug) params.set('lab', '1');
  if (state.muted !== undefined) params.set('muted', state.muted ? '1' : '0');
  if (state.embed) params.set('embed', '1');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// Fallback in-process registry for environments without BroadcastChannel
const fallbackPeers = new Set<LabBroadcastBus>();

/**
 * Same-origin BroadcastChannel bridge keeping Workbench and up to 2 simultaneous
 * Compare Mode prototype iframes synchronized down to the exact seed and branch action.
 */
export class LabBroadcastBus {
  readonly id: string;
  private channel: BroadcastChannel | null = null;
  private readonly handlers = new Set<(msg: LabBusMessage) => void>();
  private closed = false;

  constructor(senderId = 'lab-peer', channelName = LAB_CHANNEL_NAME) {
    this.id = senderId;
    if (typeof globalThis.BroadcastChannel === 'function') {
      this.channel = new globalThis.BroadcastChannel(channelName);
      this.channel.onmessage = (ev: MessageEvent<LabBusMessage>) => {
        if (this.closed || !ev.data || typeof ev.data !== 'object') return;
        if (ev.data.senderId === this.id) return;
        for (const handler of this.handlers) {
          handler(ev.data);
        }
      };
    } else {
      fallbackPeers.add(this);
    }
  }

  publish(message: LabBusMessage): void {
    if (this.closed) return;
    if (this.channel) {
      this.channel.postMessage(message);
      return;
    }
    for (const peer of fallbackPeers) {
      if (peer !== this && !peer.closed) {
        for (const handler of peer.handlers) {
          handler(message);
        }
      }
    }
  }

  subscribe(handler: (msg: LabBusMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    fallbackPeers.delete(this);
  }
}
