import { describe, expect, it } from 'vitest';

import { createStack, dropStack, stepStack } from './stack.sim';
import { LOGICAL_W } from '../engine/useCanvas';

describe('stack simulation', () => {
  it('is deterministic for the same seed and drop timing', () => {
    const run = () => {
      const s = createStack(99, 'normal');
      for (let i = 0; i < 400; i++) {
        if (i % 37 === 0) dropStack(s);
        stepStack(s);
      }
      return s;
    };
    const a = run();
    const b = run();
    expect(a.score).toBe(b.score);
    expect(a.blocks.map((x) => [x.x, x.width])).toEqual(b.blocks.map((x) => [x.x, x.width]));
  });

  it('the cursor bounces inside the play area', () => {
    const s = createStack(1, 'tricky');
    for (let i = 0; i < 2000; i++) {
      stepStack(s);
      expect(s.cursorX).toBeGreaterThanOrEqual(0);
      expect(s.cursorX + s.cursorW).toBeLessThanOrEqual(LOGICAL_W + 0.001);
    }
  });

  it('a perfect drop keeps the full width and is flagged', () => {
    const s = createStack(1, 'normal');
    // Line the cursor up exactly with the tower.
    s.cursorX = s.blocks[0]!.x;
    dropStack(s);
    expect(s.lastPerfect).toBe(true);
    expect(s.blocks[1]!.width).toBe(s.blocks[0]!.width);
    expect(s.score).toBe(1);
  });

  it('an offset drop slices off exactly the overhang', () => {
    const s = createStack(1, 'normal');
    const base = s.blocks[0]!;
    s.cursorX = base.x + 40; // 40px past the tower
    dropStack(s);
    expect(s.lastPerfect).toBe(false);
    expect(s.blocks[1]!.width).toBe(base.width - 40);
  });

  it('missing the tower entirely ends the run', () => {
    const s = createStack(1, 'normal');
    const base = s.blocks[0]!;
    s.cursorX = base.x + base.width + 10; // no overlap at all
    dropStack(s);
    expect(s.dead).toBe(true);
  });

  // Without this the guest is left tapping at a sliver they cannot possibly
  // land on, which reads as the game being broken rather than over.
  it('ends the run once the tower is too narrow to land on', () => {
    const s = createStack(1, 'normal');
    for (let i = 0; i < 40 && !s.dead; i++) {
      s.cursorX = s.blocks[s.blocks.length - 1]!.x + 20;
      dropStack(s);
    }
    expect(s.dead).toBe(true);
    expect(s.cursorW).toBeLessThan(20);
  });

  it('counts every drop as an input event', () => {
    const s = createStack(1, 'normal');
    s.cursorX = s.blocks[0]!.x;
    dropStack(s);
    dropStack(s);
    expect(s.events).toBe(2);
  });
});
