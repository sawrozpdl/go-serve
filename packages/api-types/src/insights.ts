// Insight findings — what the café was told, and what it decided.
//
// Shared with mobile: the findings list is the same read on both, and the
// decisions (dismiss / snooze / accept) are the same three writes.

/** Severity mirrors the backend's warn/bad. There is no "good": a finding
 *  exists only when something needs attention. */
export type InsightSeverity = 'warn' | 'bad';

/** Lifecycle. `dismissed` and `closed` never appear in the list — the first was
 *  an explicit "stop telling me", the second fixed itself. */
export type InsightState = 'new' | 'seen' | 'snoozed' | 'dismissed' | 'accepted' | 'closed';

/** What the finding is about. `tenant` means the café as a whole. */
export type InsightSubjectKind =
  | 'tenant'
  | 'menu_item'
  | 'menu_category'
  | 'shift'
  | 'house_tab'
  | 'user'
  | 'inventory_item';

/** How to format metric_value. */
export type InsightUnit = 'cents' | 'count' | 'ratio' | 'days' | 'minutes';

export type Insight = {
  id: string;
  detector_key: string;
  /** The detector's short human name, resolved server-side from the registry. */
  label: string;
  subject_kind: InsightSubjectKind;
  subject_key: string;
  subject_label: string;
  severity: InsightSeverity;
  state: InsightState;
  /** Admin-relative path, or '' when there is nowhere useful to go. */
  deep_link: string;

  /** The sentence. This is the product — render it as written. */
  detail: string;
  metric_value: number;
  metric_unit: InsightUnit;
  /** null means there was no baseline to compare against. Show that, rather
   *  than treating it as zero. */
  baseline_value: number | null;
  facts: Record<string, unknown>;

  first_seen_on: string;
  last_seen_on: string;

  snoozed_until: string | null;
  follow_up_on: string | null;
  note: string;

  /** The metric as it stood the day this was accepted; present only for
   *  accepted findings. With metric_value it answers "did it move". */
  then_value: number | null;
};

export type InsightsResponse = {
  insights: Insight[];
  /** How much of the café's own numbers we can vouch for, 0..1. null means it
   *  has recorded too little for the figure to mean anything — show that, never
   *  0%, which reads as an accusation. */
  books_confidence: number | null;
};

/** Whether an accepted finding's number moved the way the owner wanted.
 *
 *  For almost every metric here lower is better — less money lost, fewer misses,
 *  a smaller share voided. Coverage ratios are the exception: there, a rising
 *  number is the good news. Keyed off the detector rather than the unit, because
 *  two ratios can point opposite ways. */
const HIGHER_IS_BETTER = new Set(['cost_coverage', 'unallocated_spend']);

export function insightImproved(i: Insight): boolean | null {
  if (i.then_value === null || i.then_value === i.metric_value) return null;
  const up = i.metric_value > i.then_value;
  return HIGHER_IS_BETTER.has(i.detector_key) ? up : !up;
}
