import type { EngageTier } from '@/lib/engage';

// =========================================================================
// Reward-ladder rules, kept apart from the editor component.
//
// Two reasons: this file exports no components (which is what keeps
// fast-refresh working), and the web app's only test setup is pure-logic
// Vitest — validation that decides whether a café can hand out money is worth
// testing directly.
//
// The SERVER remains the authority; this exists so an owner is told what is
// wrong before they hit Save rather than after.
// =========================================================================

export type Draft = {
  min_score: number;
  label: string;
  reward_kind: EngageTier['reward_kind'];
  percent_bp: number | null;
  amount_cents: number | null;
  menu_item_id: string | null;
  max_discount_cents: number | null;
};

export function toDraft(t: EngageTier): Draft {
  return {
    min_score: t.min_score,
    label: t.label,
    reward_kind: t.reward_kind,
    percent_bp: t.percent_bp,
    amount_cents: t.amount_cents,
    menu_item_id: t.menu_item_id,
    max_discount_cents: t.max_discount_cents,
  };
}

/** Returns a sentence describing the first problem, or "" when the ladder is
 *  saveable. Mirrors the server's own checks. */
export function validateLadder(rows: Draft[]): string {
  const seen = new Set<number>();
  for (const r of rows) {
    if (!r.label.trim()) return 'Every tier needs a label — it is what the guest sees on the ladder.';
    if (r.min_score < 0) return "A score threshold can't be negative.";
    if (seen.has(r.min_score))
      return `Two tiers both start at ${r.min_score} points — thresholds must be distinct.`;
    seen.add(r.min_score);
    if (r.reward_kind === 'percent') {
      if (!r.percent_bp || r.percent_bp < 1 || r.percent_bp > 10000)
        return 'A percent reward must be between 1% and 100%.';
      // Not a nicety: without a ceiling the cost of a percentage reward is
      // unknown until it lands on a bill, which makes the budget cap
      // unenforceable. The database enforces this too.
      if (!r.max_discount_cents)
        return 'A percent reward needs a maximum, or one big table could spend the whole budget.';
    }
    if (r.reward_kind === 'flat' && !r.amount_cents) return 'A flat reward needs an amount above zero.';
    if (r.reward_kind === 'free_item' && !r.menu_item_id)
      return 'Pick the menu item the free-item tier gives away.';
  }
  return '';
}

/** The dearest single reward on the ladder — the same basis the server's budget
 *  caps are enforced against, so the two figures always agree. */
export function worstCase(rows: Draft[]): number {
  return rows.reduce((max, r) => {
    const v =
      r.reward_kind === 'percent'
        ? (r.max_discount_cents ?? 0)
        : r.reward_kind === 'flat'
          ? (r.amount_cents ?? 0)
          : 0;
    return Math.max(max, v);
  }, 0);
}
