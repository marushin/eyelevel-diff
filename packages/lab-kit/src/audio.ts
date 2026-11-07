import { hashString } from '@akl/graph-contract';

interface ActiveVoice {
  id: number;
  startedAt: number;
  stopNow: () => void;
}

// D-minor / suspended pentatonic frequency ratios (contemplative archival tone)
const PENTATONIC_SEMITONES = [0, 2, 3, 7, 10, 12, 14, 15, 19, 22] as const;

function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Pure Web Audio API ambient & interaction feedback synthesizer:
 * - Lazy `AudioContext` + automatic user-gesture unlock
 * - Global mute toggle
 * - Strict 10-voice polyphony limiter with smooth voice-stealing
 * - Inversion low-pass filter descent, domain-hashed harmonic plucks, frontier shimmers, and 404 clicks
 */
export class ProceduralAudioBus {
  readonly maxVoices = 10;
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private muted: boolean;
  private disposed = false;
  private voiceSeq = 0;
  private readonly activeVoices: ActiveVoice[] = [];
  private removeUnlockListeners: (() => void) | null = null;

  constructor(initialMuted = true) {
    this.muted = initialMuted;
    this.bindGestureUnlock();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!muted) {
      this.ensureContext();
    }
    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.22, now, 0.03);
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Low-pass filtered sub-harmonic sweep accompanying `#001 -> #198` search inversion.
   */
  playInversionDive(progress01: number): void {
    const ctx = this.getReadyContext();
    if (!ctx || !this.masterGain) return;

    const clamped = Math.max(0, Math.min(1, progress01));
    const now = ctx.currentTime;
    const duration = 0.16;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    const startFreq = 190 - clamped * 118;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(42, startFreq * 0.84), now + duration);

    filter.type = 'lowpass';
    filter.Q.value = 3.2;
    filter.frequency.setValueAtTime(1600 - clamped * 1320, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    this.registerVoice(ctx, osc, gain, duration);
  }

  /**
   * Pentatonic harmonic pluck mapped deterministically from `domain` hash and hop `depth`.
   */
  playHopPluck(domain: string, depth: number, isTailSeed = false): void {
    const ctx = this.getReadyContext();
    if (!ctx || !this.masterGain) return;

    const hash = hashString(domain);
    const scaleDegree = PENTATONIC_SEMITONES[hash % PENTATONIC_SEMITONES.length]!;
    const octaveShift = Math.max(-12, 12 - Math.min(depth, 8) * 2);
    const midi = (isTailSeed ? 50 : 57) + scaleDegree + octaveShift;
    const freq = midiToFreq(Math.max(38, Math.min(86, midi)));

    const now = ctx.currentTime;
    const duration = isTailSeed ? 0.52 : 0.34;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = isTailSeed ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(freq, now);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq * 4.5, now);
    filter.frequency.exponentialRampToValueAtTime(freq * 1.3, now + duration);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(isTailSeed ? 0.2 : 0.14, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    this.registerVoice(ctx, osc, gain, duration);
  }

  /**
   * Soft crystalline fifth shimmer for newly discovered counterfactual `frontier` candidates.
   */
  playFrontierShimmer(seedKey = 'frontier'): void {
    const ctx = this.getReadyContext();
    if (!ctx || !this.masterGain) return;

    const hash = hashString(seedKey);
    const baseMidi = 74 + PENTATONIC_SEMITONES[hash % 5]!;
    const freq = midiToFreq(baseMidi);
    const now = ctx.currentTime;
    const duration = 0.22;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.linearRampToValueAtTime(freq * 1.006, now + duration);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.045, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(this.masterGain);

    this.registerVoice(ctx, osc, gain, duration);
  }

  /**
   * Muted mechanical relay click for HTTP 404 / timeout dead-end ruins.
   */
  playDeadEndClick(): void {
    const ctx = this.getReadyContext();
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime;
    const duration = 0.075;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(148, now);
    osc.frequency.exponentialRampToValueAtTime(52, now + duration);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(360, now);
    filter.Q.value = 1.8;

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    this.registerVoice(ctx, osc, gain, duration);
  }

  /**
   * Rising three-note arpeggio when the viewer awakens an unvisited counterfactual branch.
   */
  playBranchAwaken(): void {
    const ctx = this.getReadyContext();
    if (!ctx || !this.masterGain) return;

    const notes = [62, 69, 74];
    notes.forEach((midi, index) => {
      const now = ctx.currentTime + index * 0.055;
      const duration = 0.42;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(midiToFreq(midi), now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.13, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(this.masterGain!);

      this.registerVoice(ctx, osc, gain, duration, index * 0.055);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeUnlockListeners?.();
    this.removeUnlockListeners = null;

    while (this.activeVoices.length > 0) {
      const v = this.activeVoices.shift();
      v?.stopNow();
    }

    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.masterGain = null;
    }
  }

  private bindGestureUnlock(): void {
    if (typeof window === 'undefined') return;

    const unlock = () => {
      if (this.disposed) return;
      if (!this.muted) {
        this.ensureContext();
      } else if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
    };

    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    this.removeUnlockListeners = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null;
    if (!this.ctx) {
      const AudioCtor =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return null;
      this.ctx = new AudioCtor();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.22;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private getReadyContext(): AudioContext | null {
    if (this.muted || this.disposed) return null;
    const ctx = this.ensureContext();
    if (!ctx || ctx.state !== 'running') return null;
    return ctx;
  }

  private registerVoice(
    ctx: AudioContext,
    osc: OscillatorNode,
    gain: GainNode,
    durationSec: number,
    delaySec = 0,
  ): void {
    // Steal oldest voice if at polyphony ceiling
    while (this.activeVoices.length >= this.maxVoices) {
      const oldest = this.activeVoices.shift();
      oldest?.stopNow();
    }

    const id = ++this.voiceSeq;
    const startAt = ctx.currentTime + delaySec;
    const stopAt = startAt + durationSec + 0.02;

    let stopped = false;
    const stopNow = () => {
      if (stopped) return;
      stopped = true;
      try {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0.0001, now, 0.005);
        osc.stop(now + 0.018);
      } catch {
        // Ignore already-stopped oscillator errors
      }
    };

    const record: ActiveVoice = { id, startedAt: startAt, stopNow };
    this.activeVoices.push(record);

    osc.onended = () => {
      stopped = true;
      const idx = this.activeVoices.findIndex((v) => v.id === id);
      if (idx >= 0) this.activeVoices.splice(idx, 1);
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // noop
      }
    };

    osc.start(startAt);
    osc.stop(stopAt);
  }
}
