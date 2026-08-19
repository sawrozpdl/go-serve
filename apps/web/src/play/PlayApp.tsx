import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GameComponent, GameContext, GameTheme } from './engine/types';
import { cacheCode, deviceFingerprint, readBest, readCachedCode, recordBest } from './lib/device';
import {
  PlayApiError,
  bootstrapPlay,
  slugFromLocation,
  startPlaySession,
  submitPlayScore,
  type PlayBootstrap,
  type PlayGame,
  type PlayScoreResult,
  type PlaySession,
} from './lib/playApi';
import { AttractScreen } from './screens/AttractScreen';
import { RevealScreen } from './screens/RevealScreen';

// Only the game a café is actually running ships. Prefetched during the attract
// screen so tapping Play is instant, but never on the first-paint path.
const GAMES: Record<PlayGame, () => Promise<{ default: GameComponent }>> = {
  tea_runner: () => import('./games/TeaRunner'),
  memory_match: () => import('./games/MemoryMatch'),
  stack: () => import('./games/Stack'),
};

type Phase = 'boot' | 'attract' | 'playing' | 'reveal' | 'error';

export function PlayApp() {
  const slug = useMemo(() => slugFromLocation(), []);
  const fingerprint = useMemo(() => deviceFingerprint(), []);
  const reducedMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    [],
  );

  const [phase, setPhase] = useState<Phase>('boot');
  const [boot, setBoot] = useState<PlayBootstrap | null>(null);
  const [fatal, setFatal] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<PlaySession | null>(null);
  const [result, setResult] = useState<PlayScoreResult | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [finalScore, setFinalScore] = useState(0);
  const [best, setBest] = useState({ today: 0, allTime: 0 });

  const Game = useRef<GameComponent | null>(null);

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!slug) {
      setFatal('This link looks incomplete.');
      setPhase('error');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await bootstrapPlay(slug, fingerprint);
        if (cancelled) return;

        // A locally cached code covers the gap when the server round-trip is
        // slow or the connection dropped after a win.
        if (!data.todays_code) {
          const cached = readCachedCode(slug);
          if (cached) {
            data.todays_code = {
              code: cached.code,
              label: cached.label,
              expires_at: cached.expiresAt,
              seconds_left: Math.max(0, Math.round((new Date(cached.expiresAt).getTime() - Date.now()) / 1000)),
            };
          }
        }
        setBoot(data);
        setBest(readBest(slug));
        setPhase('attract');

        // Warm the game chunk while the guest is reading the ladder.
        if (data.campaign) void GAMES[data.campaign.game]().then((m) => (Game.current = m.default));
      } catch (err) {
        if (cancelled) return;
        setFatal(
          err instanceof PlayApiError && err.status === 404
            ? "This café isn't running a game right now."
            : err instanceof PlayApiError
              ? err.message
              : 'Something went wrong.',
        );
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, fingerprint]);

  // ---------------------------------------------------------------------
  // Start a run
  // ---------------------------------------------------------------------
  const play = useCallback(async () => {
    if (!boot?.campaign) return;
    setStarting(true);
    setError('');
    try {
      const s = await startPlaySession(slug, fingerprint);
      if (!Game.current) {
        const mod = await GAMES[s.game]();
        Game.current = mod.default;
      }
      setSession(s);
      setLiveScore(0);
      setPhase('playing');
    } catch (err) {
      setError(err instanceof PlayApiError ? err.message : 'Could not start the game.');
    } finally {
      setStarting(false);
    }
  }, [boot, slug, fingerprint]);

  // ---------------------------------------------------------------------
  // Finish a run
  // ---------------------------------------------------------------------
  const finish = useCallback(
    async (score: number, durationMs: number, events: number) => {
      if (!session) return;
      setFinalScore(score);
      setBest(recordBest(slug, score));
      try {
        const res = await submitPlayScore(slug, session.session_token, score, durationMs, events);
        setResult(res);
        if (res.code) {
          cacheCode({
            slug,
            code: res.code.code,
            label: res.code.label,
            expiresAt: res.code.expires_at,
          });
          // Keep the attract screen's chip in step for a later reload.
          setBoot((b) => (b ? { ...b, todays_code: res.code } : b));
        }
        setPhase('reveal');
      } catch (err) {
        // A rejected score still ends the run — showing the guest a spinner
        // forever would be worse than showing them a modest result.
        setResult({ outcome: 'no_reward', code: null });
        setError(err instanceof PlayApiError ? err.message : '');
        setPhase('reveal');
      }
    },
    [session, slug],
  );

  const gameCtx: GameContext | null = useMemo(() => {
    if (!session) return null;
    return {
      theme: readTheme(reducedMotion),
      mode: session.winnable ? 'attempt' : 'practice',
      seed: session.seed,
      difficulty: session.difficulty,
      onScore: setLiveScore,
      onEnd: (r) => void finish(r.score, r.durationMs, r.events),
    };
  }, [session, reducedMotion, finish]);

  // The café's colours, applied as soon as bootstrap lands. Set on :root rather
  // than a wrapper so the ambient body glow and the pre-render shell pick them
  // up too, and so readTheme() can resolve them for the canvas.
  //
  // Only two keys are honoured, and only when they look like hex: the branding
  // blob is tenant-controlled data, and anything else here would be writing
  // arbitrary text into a stylesheet.
  useEffect(() => {
    const branding = boot?.cafe.branding;
    if (!branding) return;
    const hex = /^#[0-9a-fA-F]{3,8}$/;
    const root = document.documentElement;
    for (const [key, cssVar] of [
      ['brandPrimary', '--pl-brand'],
      ['brandAccent', '--pl-accent'],
    ] as const) {
      const value = branding[key];
      if (typeof value === 'string' && hex.test(value)) {
        root.style.setProperty(cssVar, value);
        // --brand-primary is what play.css falls back through, so keep both in
        // step for any rule written against the shared name.
        if (key === 'brandPrimary') root.style.setProperty('--brand-primary', value);
      }
    }
  }, [boot]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  if (phase === 'boot') {
    return (
      <div className="pl-boot">
        <div className="pl-boot__dot" />
        <div className="pl-boot__label">Loading your game</div>
      </div>
    );
  }

  if (phase === 'error' || !boot) {
    return (
      <div className="pl-empty">
        <div className="pl-empty__mark" aria-hidden="true">☕</div>
        <p className="pl-empty__text">{fatal || 'Nothing to play here.'}</p>
      </div>
    );
  }

  if (phase === 'playing' && gameCtx && Game.current) {
    const Live = Game.current;
    return (
      <div className="pl-play">
        <div className="pl-hud">
          <span className="pl-hud__score num">{liveScore}</span>
          {gameCtx.mode === 'practice' && <span className="pl-hud__chip">Practice</span>}
          {best.today > 0 && <span className="pl-hud__best num">Best {best.today}</span>}
        </div>
        {/* Score changes are announced at most once a second — a live region
            updated per point floods a screen reader into uselessness. */}
        <div className="pl-visually-hidden" role="status" aria-live="polite">
          {`Score ${liveScore}`}
        </div>
        <Suspense fallback={<div className="pl-boot__dot" />}>
          <Live ctx={gameCtx} />
        </Suspense>
      </div>
    );
  }

  if (phase === 'reveal' && result && session) {
    return (
      <RevealScreen
        boot={boot}
        result={result}
        score={finalScore}
        reducedMotion={reducedMotion}
        slug={slug}
        sessionToken={session.session_token}
        onPlayAgain={() => {
          setResult(null);
          setSession(null);
          setPhase('attract');
        }}
      />
    );
  }

  return (
    <AttractScreen boot={boot} best={best} starting={starting} error={error} onPlay={() => void play()} />
  );
}

/** Reads the café's brand colours off the mounted root, resolved to values a
 *  canvas can use — fillStyle cannot read a CSS custom property. */
function readTheme(reducedMotion: boolean): GameTheme {
  const styles = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    primary: pick('--pl-brand', '#ffa319'),
    accent: pick('--pl-accent', '#a3f02c'),
    ink: pick('--pl-ink', '#f6f2ef'),
    surface: pick('--pl-surface', '#141019'),
    reducedMotion,
  };
}
