import { Mail, Check, X, Users, Clock, Lock } from 'lucide-react';

import { useMe } from '@/lib/api';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { KNOWN_FEATURES, CONTACT_EMAIL, CONTACT_PHONE } from '@/lib/features';

// Owner-facing "Plan & usage" — current plan, seat usage, trial countdown, the
// premium features included, and a contact CTA (no checkout; upgrades are
// handled by reaching out to us).
export function PlanPage() {
  const me = useMe();
  const b = me.data?.billing;

  const upgrade = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Upgrade my workspace')}`;
  const allFeatures = Object.entries(KNOWN_FEATURES);
  const included = new Set(b?.features ?? []);

  const seatPct =
    b && b.member_limit ? Math.min(100, Math.round((b.seats_used / b.member_limit) * 100)) : 0;

  const trialLabel = (() => {
    if (!b) return null;
    if (b.phase === 'locked') return 'Workspace is read-only';
    if (b.phase === 'expired') return 'Trial ended — read-only';
    if (!b.trial_ends_at) return null;
    const days = Math.ceil((new Date(b.trial_ends_at).getTime() - Date.now()) / 86_400_000);
    if (b.phase === 'grace') return `Trial ended — grace period, ${Math.max(0, 7 + days)} days left`;
    return `${days} ${days === 1 ? 'day' : 'days'} left in trial`;
  })();

  return (
    <PageShell eyebrow="account" title="Plan & usage" subtitle="Your subscription, seats and trial status.">
      {me.isPending ? (
        <LoadingState />
      ) : me.isError || !b ? (
        <ErrorState onRetry={() => me.refetch()} />
      ) : (
        <div className="plan-page">
          {/* Current plan */}
          <section className="panel">
            <div className="panel-head">
              <h3>Current plan</h3>
            </div>
            <div className="plan-current">
              <div className="plan-current-name">{b.plan_key}</div>
              <span className={`pill ${b.write_locked ? '' : 'ok'}`}>
                {b.write_locked ? <Lock size={12} strokeWidth={1.8} /> : null}
                {b.phase}
              </span>
            </div>
            {trialLabel && (
              <p className="plan-trial">
                <Clock size={14} strokeWidth={1.6} /> {trialLabel}
              </p>
            )}
          </section>

          {/* Seat usage */}
          <section className="panel">
            <div className="panel-head">
              <h3>Team seats</h3>
            </div>
            <div className="plan-seats">
              <Users size={16} strokeWidth={1.6} />
              <span className="plan-seats-count">
                <strong>{b.seats_used}</strong> {b.member_limit === null ? 'members (unlimited)' : `of ${b.member_limit} seats`}
              </span>
            </div>
            {b.member_limit !== null && (
              <div className="usage-bar">
                <div className="usage-bar-fill" style={{ width: `${seatPct}%` }} />
              </div>
            )}
            <p className="hint" style={{ marginTop: 8 }}>
              Active members plus pending invites count toward your seat limit.
            </p>
          </section>

          {/* Features */}
          <section className="panel">
            <div className="panel-head">
              <h3>Premium features</h3>
            </div>
            <ul className="plan-features-list">
              {allFeatures.map(([key, meta]) => {
                const has = included.has(key);
                return (
                  <li key={key} className={has ? 'has' : 'missing'}>
                    {has ? <Check size={15} strokeWidth={2} /> : <X size={15} strokeWidth={2} />}
                    <span>
                      <strong>{meta.label}</strong>
                      <em>{meta.desc}</em>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Contact CTA */}
          <section className="panel plan-contact">
            <h3>Need a bigger plan?</h3>
            <p>
              We handle upgrades directly — reach out and we'll move you to the right tier and add seats.
            </p>
            <div className="plan-contact-actions">
              <a className="btn primary" href={upgrade}>
                <Mail size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> {CONTACT_EMAIL}
              </a>
              {CONTACT_PHONE && <span className="plan-contact-phone">or call {CONTACT_PHONE}</span>}
            </div>
          </section>
        </div>
      )}
    </PageShell>
  );
}
