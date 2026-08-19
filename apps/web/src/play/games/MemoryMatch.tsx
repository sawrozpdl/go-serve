import { useEffect, useRef, useState } from 'react';

import type { GameContext } from '../engine/types';
import { createMemory, flipTile, hideTiles, memoryScore, tickSecond } from './memoryMatch.logic';

// =========================================================================
// Memory Match — DOM renderer.
//
// Deliberately NOT canvas. This is a grid of buttons, not an animation: as real
// <button> elements the tiles get keyboard navigation, focus rings and screen
// reader labels for nothing, which makes this the game a café picks when they
// want every guest to be able to join in. It is also the only one an automated
// test can play deterministically, which is why the e2e spec drives it.
// =========================================================================

/** How long a mismatched pair stays face-up. Long enough to actually memorise,
 *  short enough not to feel like a penalty. */
const PEEK_MS = 700;

// Simple glyphs rather than the café's menu icons: the icon registry is ~100
// lucide components, and importing it here would put the whole thing in the
// guest bundle for the sake of six pictures.
const SYMBOLS = ['☕', '🍰', '🥐', '🍵', '🧁', '🥤', '🍪', '🫖'];

export default function MemoryMatch({ ctx }: { ctx: GameContext }) {
  const state = useRef(createMemory(ctx.seed, ctx.difficulty));
  const ended = useRef(false);
  const startedAt = useRef(performance.now());
  // Render-only mirror; the logic object stays the source of truth.
  const [, bump] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(state.current.secondsLeft);

  const finish = () => {
    if (ended.current) return;
    ended.current = true;
    ctx.onEnd({
      score: memoryScore(state.current),
      durationMs: Math.round(performance.now() - startedAt.current),
      events: state.current.events,
    });
  };

  useEffect(() => {
    const id = window.setInterval(() => {
      if (ended.current) return;
      const out = tickSecond(state.current);
      setSecondsLeft(state.current.secondsLeft);
      if (out) finish();
    }, 1000);
    return () => window.clearInterval(id);
    // finish is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFlip = (index: number) => {
    if (ended.current) return;
    const result = flipTile(state.current, index);
    if (result.kind === 'ignored') return;
    bump((n) => n + 1);

    if (result.kind === 'matched') {
      ctx.onScore(memoryScore(state.current));
      if (state.current.done) {
        // A beat to let the last pair land before the reveal takes over.
        window.setTimeout(finish, 350);
      }
    } else if (result.kind === 'missed') {
      const { a, b } = result;
      window.setTimeout(() => {
        hideTiles(state.current, a, b);
        bump((n) => n + 1);
      }, PEEK_MS);
    }
  };

  const s = state.current;
  const columns = s.pairs <= 4 ? 4 : 4;

  return (
    <div className="pl-memory">
      <div className="pl-memory__clock" role="timer" aria-live="off">
        {secondsLeft}s
      </div>
      <div
        className="pl-memory__grid"
        style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        role="group"
        aria-label="Memory board"
      >
        {s.tiles.map((tile, i) => {
          const face = tile.revealed || tile.matched;
          return (
            <button
              key={tile.id}
              type="button"
              className={`pl-tile${face ? ' is-face' : ''}${tile.matched ? ' is-matched' : ''}`}
              onClick={() => onFlip(i)}
              disabled={tile.matched}
              data-testid={`mm-tile-${i}`}
              // Face-down tiles must not announce what they are — a screen
              // reader would otherwise read the whole board out and the game
              // would be over before it started.
              aria-label={face ? `${SYMBOLS[tile.symbol]} ${tile.matched ? 'matched' : 'revealed'}` : 'Face-down card'}
            >
              <span aria-hidden="true">{face ? SYMBOLS[tile.symbol] : ''}</span>
            </button>
          );
        })}
      </div>
      <p className="pl-memory__hint">
        {s.pairsFound} of {s.pairs} pairs found
      </p>
    </div>
  );
}
