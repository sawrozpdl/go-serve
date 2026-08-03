import { useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Lock, Unlock, Ban, RotateCcw, Clock, CreditCard, Info, SlidersHorizontal, ToggleRight, AlertTriangle, Handshake, Activity } from 'lucide-react';

import {
  useAdminTenant,
  useAdminChangePlan,
  useAdminSetSeatOverride,
  useAdminExtendTrial,
  useAdminWriteLock,
  useAdminSuspend,
  useAdminReactivate,
  useAdminPlans,
} from '@/lib/api';
import { Tabs, type TabItem } from '@/components/Tabs';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { useConfirm } from '@/components/ConfirmDialog';
import { BillingClock } from '@/components/super/BillingClock';
import { DateDelta, DateStamp } from '@/components/super/DateStamp';
import { billingView } from '@/lib/superBilling';
import { fmtDayLong } from '@/lib/dates';

// One file per tab. This page was 693 lines with the feature editor, the
// subscription panel and the purge dialog all inline; each is a substantial
// component in its own right and none of them shares state with the others.
import { RelationshipTab } from './tenant/RelationshipTab';
import { UsageTab } from './tenant/UsageTab';
import { FeaturesTab } from './tenant/FeaturesTab';
import { SubscriptionPanel } from './tenant/SubscriptionPanel';
import { DangerDeletePanel } from './tenant/DangerDeletePanel';

function fmtDateTime(s?: string) {
  return s ? new Date(s).toLocaleString() : '—';
}

/** Where "extend by N days" actually lands, and what it counts from.
 *
 *  Mirrors the server's GREATEST(COALESCE(trial_ends_at, now()), now()) + N
 *  days: an already-lapsed trial extends from TODAY, not from the old end date.
 *  That base is returned alongside the result so the preview can show
 *  "today → today + N" rather than "old lapsed date → today + N", which would
 *  render a day count that contradicts the number the admin just typed. */
function projectedTrialEnd(
  trialEndsAt: string | undefined,
  days: number,
): { base: string; end: string; lapsed: boolean } | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  const now = Date.now();
  const existing = trialEndsAt ? new Date(trialEndsAt).getTime() : null;
  const base = Math.max(existing ?? now, now);
  return {
    base: new Date(base).toISOString(),
    end: new Date(base + days * 86_400_000).toISOString(),
    lapsed: existing !== null && existing < now,
  };
}

type DetailTab = 'overview' | 'usage' | 'relationship' | 'plan' | 'features' | 'billing' | 'danger';

const DETAIL_TABS: TabItem<DetailTab>[] = [
  { key: 'overview', label: 'Overview', icon: <Info size={12} strokeWidth={1.6} /> },
  { key: 'usage', label: 'Usage', icon: <Activity size={12} strokeWidth={1.6} /> },
  { key: 'relationship', label: 'Relationship', icon: <Handshake size={12} strokeWidth={1.6} /> },
  { key: 'plan', label: 'Plan & seats', icon: <SlidersHorizontal size={12} strokeWidth={1.6} /> },
  { key: 'features', label: 'Features', icon: <ToggleRight size={12} strokeWidth={1.6} /> },
  { key: 'billing', label: 'Billing', icon: <CreditCard size={12} strokeWidth={1.6} /> },
  { key: 'danger', label: 'Danger', icon: <AlertTriangle size={12} strokeWidth={1.6} /> },
];

export function SuperTenantDetailPage() {
  const { id = '' } = useParams();
  const q = useAdminTenant(id);
  const plans = useAdminPlans();
  const confirm = useConfirm();

  const changePlan = useAdminChangePlan(id);
  const setSeat = useAdminSetSeatOverride(id);
  const extendTrial = useAdminExtendTrial(id);
  const writeLock = useAdminWriteLock(id);
  const suspend = useAdminSuspend(id);
  const reactivate = useAdminReactivate(id);

  // Tab lives in the URL so the Overview's attention queue can deep-link
  // straight to the tab that fixes the problem, and so a shared link reopens
  // where the sender was.
  const [params, setParams] = useSearchParams();
  const urlTab = params.get('tab') as DetailTab | null;
  const tab: DetailTab = DETAIL_TABS.some((t) => t.key === urlTab) ? urlTab! : 'overview';
  const setTab = (next: DetailTab) => {
    // replace: flipping tabs shouldn't fill the back button with history.
    setParams((p) => {
      const q = new URLSearchParams(p);
      q.set('tab', next);
      return q;
    }, { replace: true });
  };
  const [seatOverride, setSeatOverride] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const [lockNote, setLockNote] = useState('');

  const t = q.data;
  if (q.isPending || q.isError || !t) {
    return (
      <PageShell eyebrow="Platform" title="Café" docTitle="Café">
        <QueryState
          isPending={q.isPending}
          isError={q.isError || !q.data}
          error={q.error ?? { message: 'No such workspace.' }}
          refetch={q.refetch}
          errorTitle="Could not load this café"
        >
          {null}
        </QueryState>
      </PageShell>
    );
  }

  const locked = t.billing_state === 'write_locked';
  const status = billingView(t);
  const projectedEnd = projectedTrialEnd(t.trial_ends_at, Number(extendDays));

  const onSuspend = async () => {
    if (await confirm({ title: `Suspend ${t.name}?`, message: 'The whole workspace becomes inaccessible (hard 404) until reactivated. Use this only for true deactivation, not billing.', danger: true, confirmLabel: 'Suspend' })) {
      suspend.mutate();
    }
  };

  return (
    <PageShell
      className="super-detail-shell"
      eyebrow={
        <Link to="/super/tenants" className="super-back">
          <ArrowLeft size={13} strokeWidth={1.7} /> All cafés
        </Link>
      }
      title={t.name}
      subtitle={`/${t.slug}`}
      docTitle={t.name}
      // Both the clock and the tabs live in the sticky strip: plan, phase and
      // the governing date are what an admin checks on every visit, so they
      // must not scroll away with the tab body.
      tabs={
        <>
          <BillingClock tenant={t} />
          <Tabs items={DETAIL_TABS} active={tab} onChange={setTab} ariaLabel="Café sections" />
        </>
      }
    >
      {tab === 'overview' && (
        <section className="panel">
          <div className="panel-head"><h3>Overview</h3></div>
          <dl className="super-dl">
            <dt>Plan</dt><dd>{t.plan_name} ({t.plan_key})</dd>
            <dt>Status</dt><dd>{status.label}</dd>
            <dt>Seats used</dt><dd>{t.active_members + t.pending_invites}{t.member_limit !== null ? ` / ${t.member_limit}` : ' / ∞'} ({t.active_members} active, {t.pending_invites} pending)</dd>
            <dt>Seat override</dt><dd>{t.member_limit_override ?? '— (plan default)'}</dd>
            {t.trial_ends_at && (<><dt>Trial ends</dt><dd><DateStamp at={t.trial_ends_at} /></dd></>)}
            <dt>Paid through</dt>
            <dd>{t.paid_through_at ? <DateStamp at={t.paid_through_at} /> : '— (no paid subscription)'}</dd>
            <dt>Owner</dt><dd>{t.owner_email ?? '— no owner yet'}</dd>
            <dt>Created</dt><dd>{fmtDateTime(t.created_at)}</dd>
            {/* This reads max(audit_log.created_at), and audit_logs is a
                default-off feature — so a blank here means "not recording",
                NOT "not using the app". Labelled accordingly until the usage
                rollup replaces it. */}
            <dt>Audit activity</dt>
            <dd>
              {t.last_activity
                ? fmtDateTime(t.last_activity)
                : <span className="muted">— audit logging is off for this workspace</span>}
            </dd>
            {t.billing_note && (<><dt>Lock note</dt><dd>{t.billing_note}</dd></>)}
          </dl>
        </section>
      )}

      {tab === 'plan' && (
        <section className="panel">
          <div className="panel-head"><h3>Plan &amp; seats</h3></div>
          <div className="field">
            <label>Change plan</label>
            <select value={t.plan_key} onChange={(e) => changePlan.mutate({ plan_key: e.target.value })} disabled={changePlan.isPending}>
              {(plans.data?.plans ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
            <p className="hint">Switching to a plan with a trial restarts that plan's trial window; switching to a no-trial plan clears the trial (track payment on the Billing tab instead). The plan sets the baseline features — tune per-tenant on the Features tab.</p>
          </div>
          <div className="field">
            <label>Seat override (blank = use plan limit)</label>
            <div className="super-inline">
              <input type="number" min={1} value={seatOverride} onChange={(e) => setSeatOverride(e.target.value)} placeholder={String(t.member_limit ?? '∞')} />
              <button className="btn" disabled={setSeat.isPending} onClick={() => setSeat.mutate({ member_limit: seatOverride.trim() === '' ? null : Number(seatOverride) })}>Save</button>
            </div>
          </div>
        </section>
      )}

      {tab === 'usage' && <UsageTab id={id} />}

      {tab === 'relationship' && <RelationshipTab id={id} t={t} />}

      {tab === 'features' && <FeaturesTab id={id} t={t} plans={plans.data?.plans ?? []} />}

      {tab === 'billing' && (
        <div className="super-detail-grid">
          <section className="panel">
            <div className="panel-head"><h3>Trial &amp; access</h3></div>
            <div className="field">
              <label>Extend trial by</label>
              <div className="super-inline">
                <input type="number" min={1} max={3650} value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
                <span className="muted" style={{ alignSelf: 'center' }}>days</span>
                <button className="btn" disabled={extendTrial.isPending || !projectedEnd} onClick={() => extendTrial.mutate({ days: Number(extendDays) })}>
                  <Clock size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Extend
                </button>
              </div>
              {projectedEnd ? (
                <div className="field-hint">
                  <DateDelta before={projectedEnd.base} after={projectedEnd.end} />
                  {!t.trial_ends_at && <span className="muted"> — starts a trial from today</span>}
                  {projectedEnd.lapsed && (
                    <span className="muted">
                      {' '}— the trial lapsed on {fmtDayLong(t.trial_ends_at)}, so this counts from today
                    </span>
                  )}
                </div>
              ) : (
                <div className="field-hint">Enter a number of days to see the resulting end date.</div>
              )}
            </div>
            <div className="field">
              <label>Write lock (read-only mode — reads still work)</label>
              {locked ? (
                <button className="btn" disabled={writeLock.isPending} onClick={() => writeLock.mutate({ locked: false })}>
                  <Unlock size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Unlock writes
                </button>
              ) : (
                <div className="super-inline">
                  <input value={lockNote} onChange={(e) => setLockNote(e.target.value)} placeholder="reason (optional)" />
                  <button className="btn danger" disabled={writeLock.isPending} onClick={() => writeLock.mutate({ locked: true, note: lockNote })}>
                    <Lock size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Lock writes
                  </button>
                </div>
              )}
            </div>
          </section>

          <SubscriptionPanel id={id} t={t} />
        </div>
      )}

      {tab === 'danger' && (
        <div className="super-detail-grid">
          <section className="panel">
            <div className="panel-head"><h3>Workspace status</h3></div>
            <p className="hint">Suspending fully deactivates the workspace (no login, hard 404). Distinct from a billing write-lock.</p>
            {t.status === 'active' ? (
              <button className="btn danger" disabled={suspend.isPending} onClick={onSuspend}>
                <Ban size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Suspend workspace
              </button>
            ) : (
              <button className="btn" disabled={reactivate.isPending} onClick={() => reactivate.mutate()}>
                <RotateCcw size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Reactivate workspace
              </button>
            )}
          </section>

          <DangerDeletePanel id={id} slug={t.slug} name={t.name} />
        </div>
      )}
    </PageShell>
  );
}
