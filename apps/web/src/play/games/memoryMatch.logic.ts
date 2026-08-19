import { mulberry32, shuffle } from '../engine/rng';
import type { PlayDifficulty } from '../lib/playApi';

// =========================================================================
// Memory Match — pure logic.
//
// The accessible game of the three, and the only one an automated test can play
// deterministically (which is why the Playwright spec drives this one rather
// than a flappy game). It is DOM-rendered, so tiles are real buttons with real
// focus and real screen-reader labels.
//
// Scoring: pairs x 10 + whole seconds left on a full clear. Points therefore
// arrive in bursts, which is why the server's event-per-point ratio is loose for
// this game and its absolute ceiling does the real work.
// =========================================================================

export type Tile = {
  id: number;
  /** Which pair this belongs to — tiles with the same symbol match. */
  symbol: number;
  revealed: boolean;
  matched: boolean;
};

export type MemoryState = {
  tiles: Tile[];
  /** Index of the single face-up unmatched tile, or null. */
  firstPick: number | null;
  pairsFound: number;
  pairs: number;
  events: number;
  secondsLeft: number;
  done: boolean;
};

export type FlipResult =
  | { kind: 'ignored' }
  | { kind: 'revealed' }
  | { kind: 'matched'; pairsFound: number }
  | { kind: 'missed'; a: number; b: number };

const LAYOUT: Record<PlayDifficulty, { pairs: number; seconds: number }> = {
  gentle: { pairs: 4, seconds: 60 },
  normal: { pairs: 6, seconds: 60 },
  tricky: { pairs: 8, seconds: 55 },
};

export function createMemory(seed: number, difficulty: PlayDifficulty): MemoryState {
  const { pairs, seconds } = LAYOUT[difficulty] ?? LAYOUT.normal;
  const rng = mulberry32(seed);
  const symbols: number[] = [];
  for (let i = 0; i < pairs; i++) symbols.push(i, i);
  shuffle(rng, symbols);

  return {
    tiles: symbols.map((symbol, id) => ({ id, symbol, revealed: false, matched: false })),
    firstPick: null,
    pairsFound: 0,
    pairs,
    events: 0,
    secondsLeft: seconds,
    done: false,
  };
}

/** Flips a tile. Returns what happened so the renderer knows whether to animate
 *  a match or schedule the two cards face-down again. */
export function flipTile(s: MemoryState, index: number): FlipResult {
  if (s.done) return { kind: 'ignored' };
  const tile = s.tiles[index];
  // Re-tapping the same card, or a matched one, is a no-op rather than an error
  // — fingers slip, and punishing that would be mean.
  if (!tile || tile.matched || tile.revealed) return { kind: 'ignored' };

  s.events++;
  tile.revealed = true;

  if (s.firstPick === null) {
    s.firstPick = index;
    return { kind: 'revealed' };
  }

  const firstIndex = s.firstPick;
  const first = s.tiles[firstIndex];
  s.firstPick = null;
  // firstPick only ever holds an index we set from a valid flip, but the
  // compiler can't know that.
  if (!first) return { kind: 'revealed' };

  if (first.symbol === tile.symbol) {
    first.matched = true;
    tile.matched = true;
    s.pairsFound++;
    if (s.pairsFound === s.pairs) s.done = true;
    return { kind: 'matched', pairsFound: s.pairsFound };
  }
  return { kind: 'missed', a: firstIndex, b: index };
}

/** Turns two mismatched tiles back over. Called by the renderer after its
 *  reveal delay, so the timing is a presentation concern rather than baked into
 *  the logic. */
export function hideTiles(s: MemoryState, a: number, b: number): void {
  for (const i of [a, b]) {
    const tile = s.tiles[i];
    if (tile && !tile.matched) tile.revealed = false;
  }
}

/** One second of clock. Returns true when time has just run out. */
export function tickSecond(s: MemoryState): boolean {
  if (s.done) return false;
  s.secondsLeft = Math.max(0, s.secondsLeft - 1);
  if (s.secondsLeft === 0) {
    s.done = true;
    return true;
  }
  return false;
}

/** Pairs are worth 10; the time bonus only lands on a full clear, so racing is
 *  rewarded but a partial board still counts for something. */
export function memoryScore(s: MemoryState): number {
  const base = s.pairsFound * 10;
  return s.pairsFound === s.pairs ? base + s.secondsLeft : base;
}
