import { useEffect, useRef, useState } from 'react';

import { LOGICAL_H, LOGICAL_W, useCanvas } from '../engine/useCanvas';
import { useGameLoop, usePageVisible } from '../engine/useGameLoop';
import type { GameContext } from '../engine/types';
import {
  CUP_R,
  CUP_X,
  OBSTACLE_W,
  createTeaRunner,
  flap,
  stepTeaRunner,
} from './teaRunner.sim';

// =========================================================================
// Tea Runner — canvas renderer.
//
// All state lives in the pure simulation; this file only draws it and forwards
// input. Continuous motion, parallax and per-frame collision are why this one is
// canvas rather than DOM — the same thing in divs would thrash layout every
// frame on exactly the cheap phones this has to run on.
// =========================================================================

export default function TeaRunner({ ctx }: { ctx: GameContext }) {
  const canvas = useCanvas();
  const visible = usePageVisible();
  const state = useRef(createTeaRunner(ctx.seed, ctx.difficulty));
  const ended = useRef(false);
  const startedAt = useRef(performance.now());
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setPaused(!visible);
  }, [visible]);

  // One handler for pointer and keyboard, so a mouse, a touch, a switch device
  // and a Playwright click all take the same path.
  useEffect(() => {
    const tap = () => {
      if (ended.current) return;
      if (!visible) return;
      flap(state.current);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        tap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  const finish = () => {
    if (ended.current) return;
    ended.current = true;
    ctx.onEnd({
      score: state.current.score,
      durationMs: Math.round(performance.now() - startedAt.current),
      events: state.current.events,
    });
  };

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
      const s = state.current;
      const before = s.score;
      stepTeaRunner(s);
      if (s.score !== before) ctx.onScore(s.score);
      if (s.dead) finish();
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
          if (!ended.current) flap(state.current);
        }}
        // The canvas itself is the control, so it needs to be reachable and
        // labelled — a guest using a switch or a keyboard plays the same game.
        role="button"
        tabIndex={0}
        aria-label="Tap to keep the cup flying"
      />
      {paused && (
        <div className="pl-stage__pause" role="status">
          Paused — tap to resume
        </div>
      )}
    </div>
  );
}

function draw(
  c: CanvasRenderingContext2D,
  s: ReturnType<typeof createTeaRunner>,
  ctx: GameContext,
) {
  const { theme } = ctx;

  c.fillStyle = theme.surface;
  c.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // A couple of drifting bands for depth. Skipped entirely under reduced motion
  // — parallax is the part that actually makes people queasy.
  if (!theme.reducedMotion) {
    c.globalAlpha = 0.06;
    c.fillStyle = theme.primary;
    for (let i = 0; i < 3; i++) {
      const y = ((s.ticks * (0.25 + i * 0.15)) % (LOGICAL_H + 160)) - 80;
      c.beginPath();
      c.ellipse(LOGICAL_W * (0.2 + i * 0.3), y, 90, 26, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  for (const o of s.obstacles) {
    const half = s.tuning.gap / 2;
    c.fillStyle = theme.primary;
    // Top and bottom pillars, with the gap between them.
    roundRect(c, o.x, 0, OBSTACLE_W, o.gapY - half, 10);
    roundRect(c, o.x, o.gapY + half, OBSTACLE_W, LOGICAL_H - (o.gapY + half), 10);
  }

  // The cup: a drawn shape rather than the café's logo. An arbitrary uploaded
  // image inside a 60fps loop is a load-time and aspect-ratio problem, and the
  // brand belongs on the frame, not in the obstacle course.
  c.save();
  c.translate(CUP_X, s.cupY);
  const tilt = Math.max(-0.5, Math.min(0.6, s.velocity * 0.05));
  c.rotate(tilt);

  c.fillStyle = theme.ink;
  roundRect(c, -CUP_R, -CUP_R + 4, CUP_R * 2, CUP_R * 1.7, 5);
  c.fillStyle = theme.accent;
  c.fillRect(-CUP_R, -CUP_R + 4, CUP_R * 2, 4);
  // Handle.
  c.strokeStyle = theme.ink;
  c.lineWidth = 3;
  c.beginPath();
  c.arc(CUP_R + 1, -CUP_R + 12, 6, -Math.PI / 2, Math.PI / 2);
  c.stroke();

  if (!theme.reducedMotion) {
    c.globalAlpha = 0.5;
    c.strokeStyle = theme.accent;
    c.lineWidth = 2;
    c.beginPath();
    const wob = Math.sin(s.ticks * 0.2) * 3;
    c.moveTo(-4, -CUP_R + 1);
    c.quadraticCurveTo(-4 + wob, -CUP_R - 8, -4, -CUP_R - 15);
    c.stroke();
    c.globalAlpha = 1;
  }
  c.restore();
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  if (h <= 0) return;
  const radius = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
  c.fill();
}
