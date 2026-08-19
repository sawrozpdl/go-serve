import { useEffect, useRef, useState } from 'react';

import type { PlayBootstrap, PlayCode, PlayScoreResult } from '../lib/playApi';
import { CodeCard } from './CodeCard';
import { ContactSheet } from './ContactSheet';
import { TierLadder } from './TierLadder';
import { nextRungGap } from './ladder';

// =========================================================================
// The reveal — the two seconds the whole feature is judged on.
//
// Sequence: the score climbs, the ladder fills in step with it and snaps at the
// rung reached, then the card turns over. The number is EARNED in front of the
// guest rather than simply displayed, and watching the fill rise past "10% off"
// while hoping it clears "free pastry" is the tension the whole thing runs on.
//
// A losing run is never a fail state. The card still turns; it turns to "so
// close", naming the exact gap. No red, no cross.
// =========================================================================

const COUNT_MS = 700;

function useCountUp(target: number, enabled: boolean): number {
  const [value, setValue] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      // Ease-out: quick off the mark, settling at the end.
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, enabled]);
  return value;
}

export function RevealScreen({
  boot,
  result,
  score,
  reducedMotion,
  onPlayAgain,
  slug,
  sessionToken,
}: {
  boot: PlayBootstrap;
  result: PlayScoreResult;
  score: number;
  reducedMotion: boolean;
  onPlayAgain: () => void;
  slug: string;
  sessionToken: string;
}) {
  const animate = !reducedMotion;
  const shown = useCountUp(score, animate);
  // The card is held back until the count-up has landed, so the two moments
  // read as cause and effect rather than arriving together.
  const [flipped, setFlipped] = useState(!animate);
  const [contactDone, setContactDone] = useState(false);
  const liveRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!animate) return;
    const id = window.setTimeout(() => setFlipped(true), COUNT_MS + 180);
    return () => window.clearTimeout(id);
  }, [animate]);

  const won = result.outcome === 'win' && result.code;
  const gap = nextRungGap(boot.tiers, score);
  const practice = result.outcome === 'practice';

  return (
    <div className="pl-reveal">
      <div className="pl-reveal__scoreWrap">
        <div className="pl-reveal__scoreLabel">Your score</div>
        <div className="pl-reveal__score num">{shown}</div>
      </div>

      <TierLadder tiers={boot.tiers} score={score} variant="result" />

      {/* One live region for the whole outcome, so a screen reader gets the
          result as a sentence instead of a stream of animating numbers. */}
      <div className="pl-visually-hidden" role="status" aria-live="polite" ref={liveRef}>
        {won
          ? `You scored ${score} and won ${result.code?.label}.`
          : `You scored ${score}.${gap ? ` ${gap.points} more points would have won ${gap.label}.` : ''}`}
      </div>

      <div className={`pl-reveal__card${flipped ? ' is-flipped' : ''}`}>
        {won && result.code ? (
          <CodeCard code={result.code as PlayCode} cafeName={boot.cafe.name} />
        ) : (
          <div className="pl-soclose">
            <div className="pl-soclose__title">{practice ? 'Nice run' : 'So close'}</div>
            {gap ? (
              <p className="pl-soclose__gap">
                <strong className="num">{gap.points}</strong> more {gap.points === 1 ? 'point' : 'points'} would
                have won <strong>{gap.label}</strong>.
              </p>
            ) : (
              <p className="pl-soclose__gap">Come back tomorrow for another go.</p>
            )}
            {practice && (
              <p className="pl-soclose__practice">
                {boot.todays_code
                  ? "You've already claimed today's reward — this one was just for fun."
                  : 'Practice run — your reward chance comes back tomorrow.'}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Contact capture arrives LAST and below the card, never as a modal over
          it. The code is copyable before this exists, and Skip carries the same
          weight as Save — consent is not the price of the prize. */}
      {won && boot.campaign?.contact_capture_enabled && !contactDone && (
        <ContactSheet slug={slug} sessionToken={sessionToken} onDone={() => setContactDone(true)} />
      )}

      <button type="button" className="pl-btn pl-btn--ghost" onClick={onPlayAgain}>
        Play again
      </button>

      {boot.campaign?.terms_text && <p className="pl-terms">{boot.campaign.terms_text}</p>}
    </div>
  );
}
