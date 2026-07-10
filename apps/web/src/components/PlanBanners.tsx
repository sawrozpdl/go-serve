import { Link } from 'react-router-dom';
import { AlertTriangle, Clock, Lock, Mail } from 'lucide-react';

import { useTrialState } from '@/lib/api';
import { CONTACT_EMAIL } from '@/lib/features';

// Global plan-state banners shown at the top of the admin <main>. Severity
// order: write-locked > trial expiry. Reads the /me billing snapshot via
// useTrialState — no extra fetch. Renders nothing for healthy tenants.
export function PlanBanners() {
  const trial = useTrialState();
  const upgrade = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Upgrade my workspace')}`;

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

  // Active trial — gentle countdown when it's getting close (≤14 days).
  if (trial.phase === 'trial' && trial.daysLeft !== undefined && trial.daysLeft <= 14) {
    return (
      <div className="plan-banner banner-info" role="status">
        <Clock size={16} strokeWidth={1.8} />
        <span>
          <strong>{trial.daysLeft} {trial.daysLeft === 1 ? 'day' : 'days'}</strong> left in your free trial.
        </span>
        <Link className="btn" to="/admin/settings">View plan</Link>
      </div>
    );
  }

  return null;
}
