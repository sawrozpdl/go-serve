import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Clock, Lock, Mail, X } from 'lucide-react';

import { useTrialState } from '@/lib/api';
import { CONTACT_EMAIL } from '@/lib/features';

// Day milestones (descending) at which the dismissable trial countdown
// re-appears. Dismiss at 15 → silent until 10 → dismiss → silent until 5 → 3
// → 1. Above the largest milestone the trial isn't close enough to nag.
const TRIAL_MILESTONES = [15, 10, 5, 3, 1];
const DISMISS_KEY = 'cafe-trial-banner-dismissed';

/** The milestone the current days-left sits in — the smallest milestone still
 *  ≥ daysLeft. So 15..11 → 15, 10..6 → 10, 5..4 → 5, 3..2 → 3, 1..0 → 1.
 *  undefined when the trial has more days left than the largest milestone. */
function trialMilestone(daysLeft: number | undefined): number | undefined {
  if (daysLeft === undefined) return undefined;
  const eligible = TRIAL_MILESTONES.filter((m) => m >= daysLeft);
  return eligible.length ? Math.min(...eligible) : undefined;
}

// Global plan-state banners shown at the top of the admin <main>. Severity
// order: write-locked > trial expiry. Reads the /me billing snapshot via
// useTrialState — no extra fetch. Renders nothing for healthy tenants.
export function PlanBanners() {
  const trial = useTrialState();
  const upgrade = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Upgrade my workspace')}`;

  // Trial countdown is dismissable per milestone: closing it remembers which
  // milestone was dismissed so it stays hidden until days-left crosses the next
  // (lower) milestone. Lazy-read from localStorage (private mode → null).
  const [dismissedMilestone, setDismissedMilestone] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(DISMISS_KEY);
      return v !== null ? Number(v) : null;
    } catch {
      return null;
    }
  });
  const milestone = trial.phase === 'trial' ? trialMilestone(trial.daysLeft) : undefined;
  const dismissTrial = () => {
    if (milestone === undefined) return;
    setDismissedMilestone(milestone);
    try {
      localStorage.setItem(DISMISS_KEY, String(milestone));
    } catch {
      /* private mode — ignore */
    }
  };

  // Locked (manual lock OR trial expired past grace) — read-only mode.
  if (trial.phase === 'locked' || trial.phase === 'expired') {
    return (
      <div className="plan-banner banner-error" role="alert">
        <Lock size={16} strokeWidth={1.8} />
        <span>
          This workspace is <strong>read-only</strong>
          {trial.phase === 'expired' ? ' — your free trial has ended.' : ' — a billing action is required.'}{' '}
          You can still view and export your data.
        </span>
        <a className="btn primary" href={upgrade}>
          <Mail size={13} strokeWidth={1.8} style={{ marginRight: 5 }} /> Contact us
        </a>
      </div>
    );
  }

  // Grace period — trial ended, writes still allowed, last-chance nag.
  if (trial.phase === 'grace') {
    const d = trial.daysLeft ?? 0; // negative
    const left = Math.max(0, 7 + d); // days remaining in the 7-day grace
    return (
      <div className="plan-banner banner-warn" role="status">
        <AlertTriangle size={16} strokeWidth={1.8} />
        <span>
          Your free trial has ended. This workspace becomes read-only in{' '}
          <strong>{left} {left === 1 ? 'day' : 'days'}</strong>. Contact us to keep it active.
        </span>
        <a className="btn" href={upgrade}>Contact us</a>
        <Link className="btn" to="/admin/settings">View plan</Link>
      </div>
    );
  }

  // Active trial — gentle countdown that re-surfaces at each milestone. Once
  // the user closes it, it stays hidden until days-left crosses the next lower
  // milestone (15 → 10 → 5 → 3 → 1).
  if (milestone !== undefined && dismissedMilestone !== milestone) {
    const d = trial.daysLeft ?? 0;
    return (
      <div className="plan-banner banner-info" role="status">
        <Clock size={16} strokeWidth={1.8} />
        <span>
          <strong>{d} {d === 1 ? 'day' : 'days'}</strong> left in your free trial.
        </span>
        <Link className="btn" to="/admin/settings">View plan</Link>
        <button
          type="button"
          className="plan-banner__close"
          onClick={dismissTrial}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>
    );
  }

  return null;
}
