import { mulberry32, randRange, type Rng } from '../engine/rng';
import { LOGICAL_H, LOGICAL_W } from '../engine/useCanvas';
import type { PlayDifficulty } from '../lib/playApi';

// =========================================================================
// Tea Runner — pure simulation.
//
// Deliberately separate from the renderer, for two reasons: this repo's web app
// has no component-test setup (pure-logic Vitest only), and physics that buys
// money deserves a determinism test. Same seed + same input timeline must give
// the same score, forever.
//
// No Date.now(), no performance.now(), no Math.random() — everything advances in
// fixed STEP ticks driven by useGameLoop.
// =========================================================================

export type Obstacle = {
  x: number;
  /** Vertical centre of the gap. */
  gapY: number;
  /** True once the cup is fully past it, so a point is scored exactly once. */
  passed: boolean;
};

export type TeaRunnerState = {
  cupY: number;
  velocity: number;
  obstacles: Obstacle[];
  score: number;
  /** Taps. Reported to the server, which requires at least one per point. */
  events: number;
  ticks: number;
  dead: boolean;
  rng: Rng;
  tuning: Tuning;
};

type Tuning = {
  gravity: number;
  flap: number;
  speed: number;
  gap: number;
  spacing: number;
};

// Difficulty changes how the game FEELS, never what a reward is worth — the
// tiers control cost. Gentle is meaningfully easier rather than cosmetically so,
// because it is the setting a café picks when they want everyone to have a go.
const TUNING: Record<PlayDifficulty, Tuning> = {
  gentle: { gravity: 0.34, flap: -6.0, speed: 1.7, gap: 190, spacing: 260 },
  normal: { gravity: 0.42, flap: -6.6, speed: 2.2, gap: 158, spacing: 230 },
  tricky: { gravity: 0.5, flap: -7.0, speed: 2.7, gap: 132, spacing: 205 },
};

export const CUP_X = 92;
export const CUP_R = 16;
export const OBSTACLE_W = 54;

export function createTeaRunner(seed: number, difficulty: PlayDifficulty): TeaRunnerState {
  const rng = mulberry32(seed);
  const tuning = TUNING[difficulty] ?? TUNING.normal;
  const state: TeaRunnerState = {
    cupY: LOGICAL_H / 2,
    velocity: 0,
    obstacles: [],
    score: 0,
    events: 0,
    ticks: 0,
    dead: false,
    rng,
    tuning,
  };
  // Seed three obstacles ahead so the first one is not on top of the guest
  // before they have understood the controls.
  for (let i = 0; i < 3; i++) {
    state.obstacles.push({
      x: LOGICAL_W + 120 + i * tuning.spacing,
      gapY: randRange(rng, 140, LOGICAL_H - 140),
      passed: false,
    });
  }
  return state;
}

/** A tap. Counted as an input event whether or not the run is already over, so
 *  the events figure reflects what the guest actually did. */
export function flap(s: TeaRunnerState): void {
  s.events++;
  if (s.dead) return;
  s.velocity = s.tuning.flap;
}

/** Advances exactly one fixed step. */
export function stepTeaRunner(s: TeaRunnerState): void {
  if (s.dead) return;
  s.ticks++;

  s.velocity += s.tuning.gravity;
  s.cupY += s.velocity;

  // The floor and ceiling are lethal — otherwise resting against the top is a
  // safe strategy and the game stops being a game.
  if (s.cupY - CUP_R <= 0 || s.cupY + CUP_R >= LOGICAL_H) {
    s.dead = true;
    return;
  }

  for (const o of s.obstacles) {
    o.x -= s.tuning.speed;

    const withinX = CUP_X + CUP_R > o.x && CUP_X - CUP_R < o.x + OBSTACLE_W;
    if (withinX) {
      const halfGap = s.tuning.gap / 2;
      if (s.cupY - CUP_R < o.gapY - halfGap || s.cupY + CUP_R > o.gapY + halfGap) {
        s.dead = true;
        return;
      }
    }
    // Scored once, on the frame the cup clears the trailing edge.
    if (!o.passed && o.x + OBSTACLE_W < CUP_X - CUP_R) {
      o.passed = true;
      s.score++;
    }
  }

  // Recycle off-screen obstacles rather than allocating, so a long run doesn't
  // grow the array without bound.
  // Seeded with three obstacles and only ever recycled, never emptied.
  const last = s.obstacles[s.obstacles.length - 1]!;
  for (const o of s.obstacles) {
    if (o.x + OBSTACLE_W < -20) {
      o.x = last.x + s.tuning.spacing;
      o.gapY = randRange(s.rng, 140, LOGICAL_H - 140);
      o.passed = false;
    }
  }
  s.obstacles.sort((a, b) => a.x - b.x);
}
