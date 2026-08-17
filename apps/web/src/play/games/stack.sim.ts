import { mulberry32, type Rng } from '../engine/rng';
import { LOGICAL_W } from '../engine/useCanvas';
import type { PlayDifficulty } from '../lib/playApi';

// =========================================================================
// Stack — pure simulation.
//
// One input, one decision: tap to drop the sliding block. A perfect drop keeps
// the full width (and pays a small bonus); a sloppy one slices off the overhang,
// so the tower narrows until nothing lands. Gentler than Tea Runner because the
// pace is the guest's own.
// =========================================================================

export type Block = {
  /** Left edge, in logical pixels. */
  x: number;
  width: number;
};

export type StackState = {
  blocks: Block[];
  /** The block currently sliding back and forth. */
  cursorX: number;
  cursorW: number;
  direction: 1 | -1;
  speed: number;
  score: number;
  events: number;
  ticks: number;
  dead: boolean;
  /** Set for one drop when the guest lands it near-perfectly, so the renderer
   *  can celebrate it. */
  lastPerfect: boolean;
  rng: Rng;
};

const BASE_WIDTH = 150;
export const BLOCK_H = 26;

/** Within this many pixels counts as perfect — forgiving enough that a good
 *  drop feels good, tight enough that it means something. */
const PERFECT_EPS = 4;

const SPEED: Record<PlayDifficulty, number> = { gentle: 1.7, normal: 2.4, tricky: 3.2 };

export function createStack(seed: number, difficulty: PlayDifficulty): StackState {
  const rng = mulberry32(seed);
  const startX = (LOGICAL_W - BASE_WIDTH) / 2;
  return {
    blocks: [{ x: startX, width: BASE_WIDTH }],
    cursorX: 0,
    cursorW: BASE_WIDTH,
    direction: 1,
    speed: SPEED[difficulty] ?? SPEED.normal,
    score: 0,
    events: 0,
    ticks: 0,
    dead: false,
    lastPerfect: false,
    rng,
  };
}

/** Advances the sliding block one fixed step. */
export function stepStack(s: StackState): void {
  if (s.dead) return;
  s.ticks++;
  s.cursorX += s.speed * s.direction;
  if (s.cursorX <= 0) {
    s.cursorX = 0;
    s.direction = 1;
  } else if (s.cursorX + s.cursorW >= LOGICAL_W) {
    s.cursorX = LOGICAL_W - s.cursorW;
    s.direction = -1;
  }
}

/** Drops the sliding block onto the tower. */
export function dropStack(s: StackState): void {
  s.events++;
  if (s.dead) return;

  // The tower always has at least the base block, so this is never undefined.
  const top = s.blocks[s.blocks.length - 1]!;
  const overlapLeft = Math.max(s.cursorX, top.x);
  const overlapRight = Math.min(s.cursorX + s.cursorW, top.x + top.width);
  const overlap = overlapRight - overlapLeft;

  if (overlap <= 0) {
    // Missed the tower entirely — the run is over.
    s.dead = true;
    s.lastPerfect = false;
    return;
  }

  const offset = Math.abs(s.cursorX - top.x);
  if (offset <= PERFECT_EPS) {
    // A perfect drop keeps the full width AND snaps into line, so a skilled
    // player can sustain a run rather than being ground down by rounding.
    s.blocks.push({ x: top.x, width: top.width });
    s.cursorW = top.width;
    s.lastPerfect = true;
  } else {
    s.blocks.push({ x: overlapLeft, width: overlap });
    s.cursorW = overlap;
    s.lastPerfect = false;
  }

  s.score++;
  s.cursorX = s.direction === 1 ? 0 : LOGICAL_W - s.cursorW;

  // Too narrow to land on: end the run rather than leaving the guest tapping at
  // something impossible.
  if (s.cursorW < 12) s.dead = true;
}
