/**
 * Deterministic PRNG for the seeded ledger. Deterministic matters twice: the
 * demo's figures are asserted in tests, and a reviewer who pulls-to-refresh must
 * not watch last month's takings change.
 *
 * Seeded from a date string, so each day of the 30-day history generates itself
 * independently and adding a day never reshuffles the others.
 */

/** FNV-1a — small, stable, and enough to spread date strings across the seed space. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32. */
export function rngFrom(seed: string): Rng {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max]. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

/** Pick by relative weight. `weights` must be the same length as `xs`. */
export function weighted<T>(rng: Rng, xs: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < xs.length; i++) {
    r -= weights[i];
    if (r <= 0) return xs[i];
  }
  return xs[xs.length - 1];
}
