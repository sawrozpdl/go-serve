import { useEffect, useRef, useState } from 'react';

import { LOGICAL_H, LOGICAL_W, useCanvas } from '../engine/useCanvas';
import { useGameLoop, usePageVisible } from '../engine/useGameLoop';
import type { GameContext } from '../engine/types';
import { BLOCK_H, createStack, dropStack, stepStack } from './stack.sim';

// =========================================================================
// Stack — canvas renderer.
//
// The tower grows past the top of the screen, so the camera pans down as it
// goes; keeping that in one coordinate system is why this is canvas rather than
// stacked divs.
// =========================================================================

/** How high the tower is allowed to climb before the camera starts following. */
const CAMERA_ANCHOR = LOGICAL_H - 200;

export default function Stack({ ctx }: { ctx: GameContext }) {
  const canvas = useCanvas();
  const visible = usePageVisible();
  const state = useRef(createStack(ctx.seed, ctx.difficulty));
  const ended = useRef(false);
  const startedAt = useRef(performance.now());
  const [paused, setPaused] = useState(false);

  useEffect(() => setPaused(!visible), [visible]);

  const drop = () => {
    const s = state.current;
    if (ended.current || !visible) return;
    const before = s.score;
    dropStack(s);
    if (s.score !== before) ctx.onScore(s.score);
    if (s.dead) finish();
  };

  const finish = () => {
    if (ended.current) return;
    ended.current = true;
    ctx.onEnd({
      score: state.current.score,
      durationMs: Math.round(performance.now() - startedAt.current),
      events: state.current.events,
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        drop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Paint one frame immediately. The loop only draws while it is running,
  // so without this a run that starts paused (a backgrounded tab, an
  // occluded window) shows the guest an empty black rectangle.
  useEffect(() => {
    const c = canvas.ctx();
    if (c) draw(c, state.current, ctx);
    // Mount only — the loop owns every frame after this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useGameLoop({
    running: !paused && !ended.current,
    update() {
      stepStack(state.current);
    },
    render() {
      const c = canvas.ctx();
      if (!c) return;
      draw(c, state.current, ctx);
    },
  });

  return (
    <div className="pl-stage">
      <canvas
        ref={canvas.ref as React.RefObject<HTMLCanvasElement>}
        className="pl-stage__canvas"
        style={{ aspectRatio: `${LOGICAL_W} / ${LOGICAL_H}` }}
        onPointerDown={(e) => {
          e.preventDefault();
          drop();
        }}
        role="button"
        tabIndex={0}
        aria-label="Tap to drop the block"
      />
      {paused && (
        <div className="pl-stage__pause" role="status">
          Paused — tap to resume
        </div>
      )}
    </div>
  );
}

function draw(c: CanvasRenderingContext2D, s: ReturnType<typeof createStack>, ctx: GameContext) {
  const { theme } = ctx;
  c.fillStyle = theme.surface;
  c.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  const towerH = s.blocks.length * BLOCK_H;
  const camera = Math.max(0, towerH - (LOGICAL_H - CAMERA_ANCHOR));

  c.save();
  c.translate(0, camera);

  s.blocks.forEach((b, i) => {
    const y = LOGICAL_H - (i + 1) * BLOCK_H;
    // A four-stop ramp between the café's two brand colours, so the tower reads
    // as this café's palette rather than a generic rainbow.
    const t = (i % 8) / 8;
    c.fillStyle = mix(theme.primary, theme.accent, t);
    c.fillRect(b.x, y, b.width, BLOCK_H - 2);
  });

  // The sliding block sits one row above the tower.
  const cursorY = LOGICAL_H - (s.blocks.length + 1) * BLOCK_H;
  c.fillStyle = theme.ink;
  c.globalAlpha = 0.92;
  c.fillRect(s.cursorX, cursorY, s.cursorW, BLOCK_H - 2);
  c.globalAlpha = 1;

  // A guide line down from the sliding block makes the timing readable instead
  // of guesswork.
  if (!theme.reducedMotion) {
    c.strokeStyle = theme.ink;
    c.globalAlpha = 0.18;
    c.setLineDash([4, 6]);
    c.beginPath();
    c.moveTo(s.cursorX + s.cursorW / 2, cursorY + BLOCK_H);
    c.lineTo(s.cursorX + s.cursorW / 2, LOGICAL_H);
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1;
  }

  c.restore();
}

/** Linear blend of two hex colours. */
function mix(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return [255, 163, 25];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
