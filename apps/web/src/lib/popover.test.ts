import { describe, expect, it } from 'vitest';

import { placePopover, type Rect } from './popover';

const VIEWPORT = { width: 1200, height: 800 };

/** A trigger at (left, top) with a default field-ish size. */
function trigger(left: number, top: number, width = 200, height = 40): Rect {
  return { top, left, bottom: top + height, right: left + width, width };
}

const CALENDAR = { width: 290, height: 340 };

describe('placePopover — vertical', () => {
  it('opens below the trigger when there is room', () => {
    const p = placePopover(trigger(100, 100), CALENDAR, VIEWPORT);
    expect(p.placement).toBe('below');
    expect(p.top).toBe(144); // 100 + 40 + 4 gap
  });

  it('flips above when it would overflow the bottom', () => {
    // Trigger near the fold: 340px of calendar will not fit below.
    const p = placePopover(trigger(100, 600), CALENDAR, VIEWPORT);
    expect(p.placement).toBe('above');
    expect(p.top).toBe(256); // 600 - 4 gap - 340
  });

  it('stays below when neither side fits but below has more room', () => {
    // This is the report-builder rail case: the trigger sits high, so flipping
    // above would leave even less space than staying put.
    const p = placePopover(trigger(100, 60), { width: 290, height: 900 }, VIEWPORT);
    expect(p.placement).toBe('below');
  });

  it('pulls the popover up rather than letting it hang off the bottom', () => {
    // Caught in the browser: a 256px time list under a trigger ~200px from the
    // fold. Above has less room than below, so it stays below — and without a
    // bottom clamp it overflowed by 51px and its last options were unreachable.
    const short = { width: 1512, height: 420 };
    const p = placePopover(trigger(0, 166, 200, 45), { width: 168, height: 256 }, short);
    expect(p.placement).toBe('below');
    expect(p.top + 256).toBeLessThanOrEqual(short.height - 8);
    expect(p.top).toBe(156); // 420 - 8 - 256
  });

  it('never starts above the top margin', () => {
    // A popover taller than the viewport must pin to the margin and scroll
    // internally rather than hang off the top of the screen.
    const p = placePopover(trigger(100, 700), { width: 290, height: 1000 }, VIEWPORT);
    expect(p.top).toBe(8);
  });

  it('keeps a popover on screen wherever the trigger sits', () => {
    // Sweep a trigger down the viewport: the popover must always be fully
    // visible, whichever side it lands on.
    const pop = { width: 290, height: 340 };
    for (let top = 0; top <= 760; top += 20) {
      const p = placePopover(trigger(100, top), pop, VIEWPORT);
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.top + pop.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
    }
  });
});

describe('placePopover — horizontal', () => {
  it('left-aligns with the trigger by default', () => {
    expect(placePopover(trigger(100, 100), CALENDAR, VIEWPORT).left).toBe(100);
  });

  it('pulls back from the right edge instead of overflowing', () => {
    // The bug this whole module exists for: a 290px calendar left-anchored to a
    // trigger near the right edge used to spill out of its column.
    const p = placePopover(trigger(1050, 100), CALENDAR, VIEWPORT);
    expect(p.left).toBe(902); // 1200 - 290 - 8
    expect(p.left + CALENDAR.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('clamps to the left margin for an off-screen trigger', () => {
    expect(placePopover(trigger(-50, 100), CALENDAR, VIEWPORT).left).toBe(8);
  });

  it('starts at the margin when the popover is wider than the viewport', () => {
    // The right-edge pull-back would compute a negative left; the left clamp
    // has to win.
    const p = placePopover(trigger(100, 100), { width: 1400, height: 200 }, VIEWPORT);
    expect(p.left).toBe(8);
  });
});

describe('placePopover — matchWidth', () => {
  it('pins the popover to the trigger width', () => {
    const p = placePopover(trigger(100, 100, 260), CALENDAR, VIEWPORT, { matchWidth: true });
    expect(p.width).toBe(260);
  });

  it('clamps using the trigger width, not the measured width', () => {
    // A select dropdown is as wide as its trigger, so the right-edge test must
    // use that width or it would pull back further than necessary.
    const p = placePopover(trigger(1000, 100, 150), CALENDAR, VIEWPORT, { matchWidth: true });
    expect(p.left).toBe(1000);
    expect(p.width).toBe(150);
  });

  it('omits width entirely when not requested', () => {
    expect(placePopover(trigger(100, 100), CALENDAR, VIEWPORT).width).toBeUndefined();
  });
});

describe('placePopover — options', () => {
  it('honours a custom margin and gap', () => {
    const p = placePopover(trigger(100, 100), CALENDAR, VIEWPORT, { margin: 20, gap: 12 });
    expect(p.top).toBe(152); // 140 + 12
    const clamped = placePopover(trigger(1150, 100), CALENDAR, VIEWPORT, { margin: 20 });
    expect(clamped.left).toBe(890); // 1200 - 290 - 20
  });
});
