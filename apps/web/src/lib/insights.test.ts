import { describe, it, expect } from 'vitest';

import { insightImproved, type Insight } from '@cafe-mgmt/api-types';

// insightImproved decides which way is "better", and it is the one piece of
// client-side judgement in the whole findings UI. Getting it backwards would
// tell an owner their books improved while they got worse — on the exact screen
// whose entire purpose is being trustworthy.
//
// The subtlety: for almost every metric here LOWER is better (less money lost,
// fewer misses, a smaller share voided), but coverage ratios invert — a rising
// number is the good news. So the direction is keyed off the DETECTOR, not the
// unit: two ratios can point opposite ways.

function insight(over: Partial<Insight>): Insight {
  return {
    id: 'i1',
    detector_key: 'void_rate',
    label: 'Voided sales',
    subject_kind: 'tenant',
    subject_key: '',
    subject_label: 'Voided sales',
    severity: 'warn',
    state: 'accepted',
    deep_link: '',
    detail: 'x',
    metric_value: 0,
    metric_unit: 'ratio',
    baseline_value: null,
    facts: {},
    first_seen_on: '2026-07-01',
    last_seen_on: '2026-07-26',
    snoozed_until: null,
    follow_up_on: '2026-08-02',
    note: '',
    then_value: null,
    ...over,
  };
}

describe('insightImproved', () => {
  it('treats a falling number as better for most detectors', () => {
    expect(insightImproved(insight({ then_value: 0.09, metric_value: 0.03 }))).toBe(true);
    expect(insightImproved(insight({ then_value: 0.03, metric_value: 0.09 }))).toBe(false);
  });

  it('inverts for coverage, where a rising number is the good news', () => {
    // 60% of revenue costed → 95% is progress, even though the number went UP.
    expect(
      insightImproved(
        insight({ detector_key: 'cost_coverage', then_value: 0.6, metric_value: 0.95 }),
      ),
    ).toBe(true);
    expect(
      insightImproved(
        insight({ detector_key: 'cost_coverage', then_value: 0.95, metric_value: 0.6 }),
      ),
    ).toBe(false);
    // Same for expense allocation — the other coverage figure.
    expect(
      insightImproved(
        insight({ detector_key: 'unallocated_spend', then_value: 0, metric_value: 0.8 }),
      ),
    ).toBe(true);
  });

  it('returns null when there is nothing to compare', () => {
    // Not yet accepted, or accepted today: no earlier observation exists. The UI
    // must say so rather than implying progress either way.
    expect(insightImproved(insight({ then_value: null, metric_value: 0.05 }))).toBeNull();
  });

  it('returns null when the number has not moved at all', () => {
    // Unchanged is not an improvement, and calling it one would be the kind of
    // flattery that makes the whole feature untrustworthy.
    expect(insightImproved(insight({ then_value: 0.05, metric_value: 0.05 }))).toBeNull();
  });

  it('handles a fall to exactly zero as an improvement', () => {
    // The problem went away entirely — the most important case to get right,
    // and the one a truthy check on then_value would break.
    expect(insightImproved(insight({ then_value: 0.05, metric_value: 0 }))).toBe(true);
  });

  it('handles a rise from exactly zero as a regression', () => {
    expect(insightImproved(insight({ then_value: 0, metric_value: 0.05 }))).toBe(false);
  });
});
