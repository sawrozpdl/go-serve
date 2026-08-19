import { useEffect, useRef } from 'react';

// =========================================================================
// Canvas sizing for the two drawn games.
//
// Everything is authored in a fixed 360x640 LOGICAL space and letterboxed, so
// the game is exactly as hard on a small phone as on a tablet. Scaling the play
// area to the viewport instead would quietly make big screens easier — and the
// score buys money.
//
// The logical size is FROZEN at mount, which matters more than it sounds: on
// mobile the URL bar collapses on first scroll or tap and resizes the viewport
// mid-run. In a flappy game that reads as the ceiling suddenly moving, and the
// guest loses a run they were winning through no fault of their own.
// =========================================================================

export const LOGICAL_W = 360;
export const LOGICAL_H = 640;

export type CanvasHandles = {
  ref: React.RefObject<HTMLCanvasElement | null>;
  /** Drawing context, sized and DPR-scaled. Null until mounted. */
  ctx: () => CanvasRenderingContext2D | null;
};

export function useCanvas(): CanvasHandles {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    // Cap DPR at 2: a 3x phone gains no visible fidelity on flat shapes and
    // pays 2.25x the fill rate for it, which is exactly the budget a cheap
    // Android does not have.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = LOGICAL_W * dpr;
    canvas.height = LOGICAL_H * dpr;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctxRef.current = ctx;
  }, []);

  return { ref, ctx: () => ctxRef.current };
}
