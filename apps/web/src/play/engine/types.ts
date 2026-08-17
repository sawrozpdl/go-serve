import type { ComponentType } from 'react';

import type { PlayDifficulty, PlayGame } from '../lib/playApi';

// =========================================================================
// The contract every game plugs into.
//
// Games are React components rather than an imperative mount(host) interface,
// because this repo is hooks-everywhere and because Memory Match wants to be
// plain JSX (real <button> tiles = keyboard and screen-reader support for free).
// =========================================================================

export type GameTheme = {
  /** Resolved to hex, because a canvas fillStyle cannot read a CSS variable. */
  primary: string;
  accent: string;
  ink: string;
  surface: string;
  /** Damps parallax, particles and shake. A reduced-motion guest still PLAYS —
   *  this is not a "no thanks" switch. */
  reducedMotion: boolean;
};

export type GameResult = {
  score: number;
  durationMs: number;
  /** Input events — taps, flips, drops. The server checks this against the score
   *  (Tea Runner needs at least one tap per obstacle passed), so a game must
   *  count them honestly or its own players get rejected. */
  events: number;
};

export type GameContext = {
  theme: GameTheme;
  /** 'attempt' can win; 'practice' cannot. Games use it only for the HUD chip —
   *  the server decides what a run is worth. */
  mode: 'attempt' | 'practice';
  /** Server-issued, so a run is reproducible and a future replay check stays
   *  possible. Games must not call Math.random(). */
  seed: number;
  difficulty: PlayDifficulty;
  /** Live HUD updates. Throttled by the caller; games may call it per point. */
  onScore(score: number): void;
  onEnd(result: GameResult): void;
};

export type GameComponent = ComponentType<{ ctx: GameContext }>;

export type GameMeta = {
  key: PlayGame;
  name: string;
  /** One line, shown on the attract screen. A guest should know how to play
   *  before they tap, not after they lose. */
  howTo: string;
  /** Surfaced in the admin picker so an owner can choose deliberately. */
  accessibility: 'reflex' | 'timing' | 'accessible';
  accessibilityNote: string;
};

export const GAME_META: Record<PlayGame, GameMeta> = {
  tea_runner: {
    key: 'tea_runner',
    name: 'Tea Runner',
    howTo: 'Tap to keep the cup flying. Slip through the gaps.',
    accessibility: 'reflex',
    accessibilityNote: 'Fast reflexes needed — the most game-like of the three.',
  },
  memory_match: {
    key: 'memory_match',
    name: 'Memory Match',
    howTo: 'Find the matching pairs before the timer runs out.',
    accessibility: 'accessible',
    accessibilityNote: 'No reflexes needed, works with a keyboard and a screen reader. Pick this if you want everyone to join in.',
  },
  stack: {
    key: 'stack',
    name: 'Stack',
    howTo: 'Tap to drop each block. Line them up to keep the tower wide.',
    accessibility: 'timing',
    accessibilityNote: 'One tap, timed — gentler than Tea Runner but still needs timing.',
  },
};
