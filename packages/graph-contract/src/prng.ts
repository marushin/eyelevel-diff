/**
 * Pure deterministic Mulberry32 PRNG.
 * `Math.random()` is strictly prohibited across all simulation & layout seeding.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic FNV-1a 32-bit string hash for combining query + seed + branch IDs.
 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function combineSeed(seed: number, salt: string): number {
  return (seed >>> 0) ^ hashString(salt);
}

export interface DeterministicRng {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  float(min: number, max: number, decimals?: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number, salt = ''): DeterministicRng {
  const raw = mulberry32(salt ? combineSeed(seed, salt) : seed >>> 0);

  return {
    next: raw,
    int(minInclusive: number, maxInclusive: number): number {
      const span = maxInclusive - minInclusive + 1;
      return minInclusive + Math.floor(raw() * span);
    },
    float(min: number, max: number, decimals = 3): number {
      const val = min + raw() * (max - min);
      const factor = 10 ** decimals;
      return Math.round(val * factor) / factor;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new Error('Cannot pick from an empty array');
      }
      return items[Math.floor(raw() * items.length)]!;
    },
    chance(probability: number): boolean {
      return raw() < probability;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(raw() * (i + 1));
        const tmp = copy[i]!;
        copy[i] = copy[j]!;
        copy[j] = tmp;
      }
      return copy;
    },
  };
}
