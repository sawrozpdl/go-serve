// =========================================================================
// Seeded PRNG.
//
// Games must never call Math.random(): the server issues a seed so a run is
// reproducible, which is what keeps a future server-side replay check possible
// and what makes the determinism test meaningful. A stray Math.random() would
// silently break both, and nothing would fail loudly at the time.
//
// mulberry32 — 32-bit state, one multiply-shift round. Fast enough to call in a
// 60Hz loop, and its sequence is stable across engines, which is what the golden
// test in rng.test.ts pins.
// =========================================================================

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  // Fold a possibly-large server seed (up to 2^52) into 32 bits without losing
  // all of the high entropy.
  let a = (seed ^ (seed / 0x100000000)) >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [min, max]. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** A float in [min, max). */
export function randRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** In-place Fisher-Yates, so a shuffled board is reproducible from its seed. */
export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    // Read through locals: under noUncheckedIndexedAccess a destructuring swap
    // widens both sides to T | undefined even though both indices are in range.
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
  return items;
}
