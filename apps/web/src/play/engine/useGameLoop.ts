import { useEffect, useRef, useState } from 'react';

// =========================================================================
// Fixed-timestep game loop.
//
// THIS IS A FAIRNESS REQUIREMENT, NOT A POLISH DETAIL. The score buys real
// money off a real bill, so a 120Hz phone must not play a different game than a
// 60Hz one. With a naive `update(deltaTime)` loop, higher refresh rates change
// physics integration and obstacle spacing subtly but decisively — and the guest
// on the cheaper phone is the one who loses out.
//
// The accumulator runs update() at a fixed STEP and hands render() an alpha for
// interpolation, so motion stays smooth at any refresh rate while the simulation
// stays identical.
// =========================================================================

export const STEP_MS = 1000 / 60;

/** A single frame's worth of time is clamped to this. A backgrounded tab can
 *  return with minutes of elapsed time; without the clamp the loop would try to
 *  catch up in one frame and lock the phone. */
const MAX_FRAME_MS = 250;

export type LoopCallbacks = {
  /** Advances the simulation by exactly STEP_MS. Must be pure with respect to
   *  wall-clock time — no Date.now(), no performance.now(). */
  update: () => void;
  /** alpha is 0..1 between the last two update()s, for interpolated drawing. */
  render: (alpha: number) => void;
  /** Paused while false — used for the visibility overlay. */
  running: boolean;
};

export function useGameLoop({ update, render, running }: LoopCallbacks): void {
  // Held in refs so changing a callback never restarts the loop mid-run, which
  // would reset the accumulator and produce a visible hitch.
  const updateRef = useRef(update);
  const renderRef = useRef(render);
  updateRef.current = update;
  renderRef.current = render;

  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let last = performance.now();
    let acc = 0;

    const tick = (now: number) => {
      acc += Math.min(now - last, MAX_FRAME_MS);
      last = now;
      while (acc >= STEP_MS) {
        updateRef.current();
        acc -= STEP_MS;
      }
      renderRef.current(acc / STEP_MS);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);
}

/** Pauses when the tab is hidden. A guest who takes a phone call must not come
 *  back to a dead run, and an unattended tab must not keep burning battery. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}
