import { GAME_META } from '../engine/types';
import type { PlayBootstrap } from '../lib/playApi';
import { CodeCard } from './CodeCard';
import { TierLadder } from './TierLadder';

// =========================================================================
// The attract screen — everything a guest needs before they tap Play.
//
// Practice mode is signposted as generosity, never as a lockout. A guest who has
// already claimed today's reward keeps a full-weight Play button (reading "Play
// again"), their code stays visible in a chip they cannot lose, and the copy
// leads with what they HAVE rather than what they cannot have.
// =========================================================================

/** Human-readable practice reasons. Deliberately coarse — the server never says
 *  how close the budget is to running out, and neither do we. */
const REASONS: Record<string, string> = {
  already_played_today: "You've claimed today's reward — keep playing for fun, and come back tomorrow.",
  no_active_campaign: "No game running right now — but have a go anyway.",
  rewards_claimed: "Today's rewards have all been claimed. Come back tomorrow for another chance.",
  rewards_unavailable: 'Rewards are paused here at the moment.',
  no_rewards_configured: 'No rewards set up yet — this one is just for fun.',
};

export function AttractScreen({
  boot,
  best,
  starting,
  error,
  onPlay,
}: {
  boot: PlayBootstrap;
  best: { today: number; allTime: number };
  starting: boolean;
  error: string;
  onPlay: () => void;
}) {
  const meta = boot.campaign ? GAME_META[boot.campaign.game] : null;
  const canWin = boot.can_win_today;
  const reason = boot.practice_reason ? REASONS[boot.practice_reason] : '';

  return (
    <div className="pl-attract">
      <header className="pl-attract__hero">
        {boot.cafe.logo_url ? (
          <img className="pl-attract__logo" src={boot.cafe.logo_url} alt="" width={72} height={72} />
        ) : (
          <div className="pl-attract__emoji" aria-hidden="true">
            {boot.cafe.accent_emoji || '☕'}
          </div>
        )}
        <h1 className="pl-attract__cafe">{boot.cafe.name}</h1>
        <p className="pl-attract__headline">
          {boot.campaign?.headline || 'Play for a treat'}
        </p>
        {boot.campaign?.subhead && <p className="pl-attract__subhead">{boot.campaign.subhead}</p>}
      </header>

      {/* A code already won today is never more than a glance away. */}
      {boot.todays_code && (
        <div className="pl-attract__todays">
          <div className="pl-attract__todaysLabel">Today's reward</div>
          <CodeCard code={boot.todays_code} cafeName={boot.cafe.name} compact />
        </div>
      )}

      {meta && (
        <section className="pl-howto">
          <h2 className="pl-howto__name">{meta.name}</h2>
          <p className="pl-howto__rule">{meta.howTo}</p>
        </section>
      )}

      {boot.tiers.length > 0 && (
        <section className="pl-attract__ladder" aria-label="What you can win">
          <h2 className="pl-attract__ladderTitle">What you can win</h2>
          <TierLadder tiers={boot.tiers} variant="preview" />
        </section>
      )}

      {!canWin && reason && <p className="pl-attract__practice">{reason}</p>}

      {error && <p className="pl-attract__error">{error}</p>}

      <div className="pl-attract__actions">
        <button type="button" className="pl-btn pl-btn--primary pl-btn--big" onClick={onPlay} disabled={starting}>
          {starting ? 'Starting…' : boot.todays_code ? 'Play again' : 'Play'}
        </button>
        {!canWin && <span className="pl-attract__chip">Practice</span>}
      </div>

      {(best.today > 0 || best.allTime > 0) && (
        <p className="pl-attract__best num">
          Best today {best.today} · All time {best.allTime}
        </p>
      )}

      <p className="pl-privacy">
        We store a random id on your device to keep the game fair. No account, no tracking across sites.
      </p>
    </div>
  );
}
