import type { PlayTier } from '../lib/playApi';

/** The gap to the next rung up — the retention hook on a losing run ("18 more
 *  points would have won a free pastry"). Returns null when the guest already
 *  cleared the top rung.
 *
 *  Lives apart from TierLadder.tsx so that file exports only components, which
 *  is what keeps fast-refresh working. */
export function nextRungGap(
  tiers: PlayTier[],
  score: number,
): { points: number; label: string } | null {
  const above = tiers
    .filter((t) => t.min_score > score)
    .sort((a, b) => a.min_score - b.min_score)[0];
  if (!above) return null;
  return { points: above.min_score - score, label: above.label };
}
