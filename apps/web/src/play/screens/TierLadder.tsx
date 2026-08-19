import type { PlayTier } from '../lib/playApi';

// =========================================================================
// The reward ladder.
//
// Shown on the attract screen as a promise, and again on the reveal as the
// result. Same component, same visual language, so the rung a guest was aiming
// at is recognisably the rung they land on.
//
// Note this is duplicated (in spirit) by the admin's tier editor rather than
// shared with it. Sharing would mean a module both bundles import, which is
// precisely how the guest entry starts pulling in admin code — the whole reason
// for the separate Vite entry. Forty lines is a cheap price for that boundary.
// =========================================================================

export function TierLadder({
  tiers,
  score,
  variant,
}: {
  tiers: PlayTier[];
  /** Undefined on the attract screen, where nothing has been earned yet. */
  score?: number;
  variant: 'preview' | 'result';
}) {
  if (tiers.length === 0) return null;
  // Highest at the top: a ladder you climb.
  const rungs = [...tiers].sort((a, b) => b.min_score - a.min_score);
  const reached = score === undefined ? -1 : Math.max(...tiers.map((t) => (score >= t.min_score ? t.min_score : -1)));

  return (
    <ul className={`pl-ladder pl-ladder--${variant}`}>
      {rungs.map((tier) => {
        const isReached = score !== undefined && score >= tier.min_score;
        const isLanded = tier.min_score === reached;
        return (
          <li
            key={tier.min_score}
            className={[
              'pl-ladder__rung',
              isReached ? 'is-reached' : '',
              isLanded ? 'is-landed' : '',
              score !== undefined && !isReached ? 'is-dimmed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="pl-ladder__score num">{tier.min_score}</span>
            <span className="pl-ladder__label">{tier.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
