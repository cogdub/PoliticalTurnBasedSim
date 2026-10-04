/**
 * Deterministic PRNG (xoshiro128**) with named sub-streams.
 * A stream's seed derives from (campaign seed, turn, stream name), so adding
 * randomness in one system never shifts outcomes in another.
 */

function hashString(s: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export class Rng {
  private s: Uint32Array;

  constructor(seed: number) {
    const sm = splitmix32(seed);
    this.s = new Uint32Array([sm(), sm(), sm(), sm()]);
  }

  private nextU32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Approximately normal (Irwin–Hall, 6 uniforms). */
  normal(mean = 0, sd = 1): number {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += this.next();
    return mean + (sum - 3) * sd * Math.SQRT2;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  weightedPick<T>(items: readonly T[], weight: (t: T) => number): T | undefined {
    const total = items.reduce((a, t) => a + Math.max(0, weight(t)), 0);
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const t of items) {
      r -= Math.max(0, weight(t));
      if (r <= 0) return t;
    }
    return items[items.length - 1];
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Factory for per-turn named streams. */
export function rngStream(seed: number, turn: number, name: string): Rng {
  return new Rng((seed ^ hashString(`${turn}:${name}`)) >>> 0);
}

/** Deterministic noise in [-1, 1] keyed by arbitrary strings (used for fog-of-war). */
export function keyedNoise(...keys: (string | number)[]): number {
  const r = new Rng(hashString(keys.join("|")));
  return r.next() * 2 - 1;
}
