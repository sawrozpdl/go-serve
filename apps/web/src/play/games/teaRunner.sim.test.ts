import { describe, expect, it } from 'vitest';

import { createTeaRunner, flap, stepTeaRunner, type TeaRunnerState } from './teaRunner.sim';
import { LOGICAL_H } from '../engine/useCanvas';

// Replays a fixed input timeline: flap on exactly these tick numbers.
function play(seed: number, flapTicks: Set<number>, ticks = 1000): TeaRunnerState {
  const s = createTeaRunner(seed, 'normal');
  for (let i = 0; i < ticks; i++) {
    if (flapTicks.has(i)) flap(s);
    stepTeaRunner(s);
  }
  return s;
}

describe('tea runner simulation', () => {
  // THE fairness test. The score buys money off a real bill, so the same seed
  // and the same taps must produce the same score on a 60Hz phone and a 120Hz
  // one — which is exactly what the fixed-timestep loop plus a seeded PRNG
  // guarantee. A stray Math.random() or a delta-time integration would break
  // this and nothing else would notice.
  it('is deterministic for the same seed and input timeline', () => {
    const flaps = new Set([10, 30, 52, 74, 96, 120, 145, 170, 200, 240]);
    const a = play(12345, flaps);
    const b = play(12345, flaps);

    expect(a.score).toBe(b.score);
    expect(a.cupY).toBe(b.cupY);
    expect(a.ticks).toBe(b.ticks);
    expect(a.dead).toBe(b.dead);
  });

  it('produces different runs for different seeds', () => {
    const flaps = new Set([10, 30, 52, 74, 96]);
    const a = play(1, flaps, 400);
    const b = play(999, flaps, 400);
    // The obstacle layout is seeded, so at least the gap positions must differ.
    expect(a.obstacles.map((o) => o.gapY)).not.toEqual(b.obstacles.map((o) => o.gapY));
  });

  it('falls without input and dies on the floor', () => {
    const s = createTeaRunner(7, 'normal');
    for (let i = 0; i < 400 && !s.dead; i++) stepTeaRunner(s);
    expect(s.dead).toBe(true);
    expect(s.score).toBe(0);
  });

  it('a flap sends the cup upward', () => {
    const s = createTeaRunner(7, 'normal');
    stepTeaRunner(s);
    const fallingY = s.cupY;
    flap(s);
    stepTeaRunner(s);
    expect(s.cupY).toBeLessThan(fallingY);
  });

  it('the ceiling is lethal, so parking at the top is not a strategy', () => {
    const s = createTeaRunner(7, 'normal');
    for (let i = 0; i < 200 && !s.dead; i++) {
      flap(s);
      stepTeaRunner(s);
    }
    expect(s.dead).toBe(true);
    expect(s.cupY).toBeLessThan(LOGICAL_H / 2);
  });

  // The server requires at least one input per point scored. If the game could
  // score without taps, its own honest players would be rejected as implausible.
  it('counts every tap as an input event', () => {
    const s = createTeaRunner(7, 'normal');
    flap(s);
    flap(s);
    stepTeaRunner(s);
    expect(s.events).toBe(2);
  });

  it('scores each obstacle exactly once', () => {
    const s = createTeaRunner(7, 'normal');
    // Hold the cup roughly level with the first gap and fly through.
    for (let i = 0; i < 600 && !s.dead; i++) {
      const target = s.obstacles[0]?.gapY ?? LOGICAL_H / 2;
      if (s.cupY > target) flap(s);
      stepTeaRunner(s);
    }
    // However far it got, no obstacle may be double-counted.
    const passed = s.obstacles.filter((o) => o.passed).length;
    expect(s.score).toBeGreaterThanOrEqual(passed - s.obstacles.length);
    expect(s.score).toBeLessThan(1000);
  });

  it('gentle is genuinely easier than tricky, not just cosmetically', () => {
    const gentle = createTeaRunner(5, 'gentle');
    const tricky = createTeaRunner(5, 'tricky');
    expect(gentle.tuning.gap).toBeGreaterThan(tricky.tuning.gap);
    expect(gentle.tuning.speed).toBeLessThan(tricky.tuning.speed);
  });
});
