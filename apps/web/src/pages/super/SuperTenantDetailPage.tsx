import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Lock, Unlock, Ban, RotateCcw, Clock } from 'lucide-react';

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
import { useConfirm } from '@/components/ConfirmDialog';

function fmtDate(s?: string) {
  return s ? new Date(s).toLocaleString() : '—';
}

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

  const [seatOverride, setSeatOverride] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const [lockNote, setLockNote] = useState('');

  const t = q.data;
  if (q.isPending) return <div className="super-page"><div className="empty-state">Loading…</div></div>;
  if (q.isError || !t) return <div className="super-page"><div className="banner-error">{q.error?.message ?? 'Not found'}</div></div>;

  const locked = t.billing_state === 'write_locked';

  const onSuspend = async () => {
    if (await confirm({ title: `Suspend ${t.name}?`, message: 'The whole workspace becomes inaccessible (hard 404) until reactivated. Use this only for true deactivation, not billing.', danger: true, confirmLabel: 'Suspend' })) {
      suspend.mutate();
    }
  };

  return (
    <div className="super-page">
      <Link to="/super/tenants" className="super-back"><ArrowLeft size={14} strokeWidth={1.6} /> All tenants</Link>
      <div className="super-page-head">
        <h1>{t.name} <span className="muted" style={{ fontWeight: 400 }}>/{t.slug}</span></h1>
        {t.status !== 'active'
          ? <span className="pill">{t.status}</span>
          : locked ? <span className="pill"><Lock size={11} strokeWidth={2} /> read-only</span> : <span className="pill ok">active</span>}
      </div>

      <div className="super-detail-grid">
        {/* Snapshot */}
        <section className="panel">
          <div className="panel-head"><h3>Overview</h3></div>
          <dl className="super-dl">
            <dt>Plan</dt><dd>{t.plan_name} ({t.plan_key})</dd>
            <dt>Seats used</dt><dd>{t.active_members + t.pending_invites}{t.member_limit !== null ? ` / ${t.member_limit}` : ' / ∞'} ({t.active_members} active, {t.pending_invites} pending)</dd>
            <dt>Seat override</dt><dd>{t.member_limit_override ?? '— (plan default)'}</dd>
            <dt>Trial ends</dt><dd>{fmtDate(t.trial_ends_at)}</dd>
            <dt>Owner</dt><dd>{t.owner_email ?? '— no owner yet'}</dd>
            <dt>Created</dt><dd>{fmtDate(t.created_at)}</dd>
            <dt>Last activity</dt><dd>{fmtDate(t.last_activity)}</dd>
            {t.billing_note && (<><dt>Lock note</dt><dd>{t.billing_note}</dd></>)}
          </dl>
        </section>

        {/* Plan controls */}
        <section className="panel">
          <div className="panel-head"><h3>Plan</h3></div>
          <div className="field">
            <label>Change plan</label>
            <select value={t.plan_key} onChange={(e) => changePlan.mutate({ plan_key: e.target.value })} disabled={changePlan.isPending}>
              {(plans.data?.plans ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
            <p className="hint">Switching to a paid plan clears the trial; switching to trial restarts a 90-day window.</p>
          </div>
          <div className="field">
            <label>Seat override (blank = use plan limit)</label>
            <div className="super-inline">
              <input type="number" min={1} value={seatOverride} onChange={(e) => setSeatOverride(e.target.value)} placeholder={String(t.member_limit ?? '∞')} />
              <button className="btn" disabled={setSeat.isPending} onClick={() => setSeat.mutate({ member_limit: seatOverride.trim() === '' ? null : Number(seatOverride) })}>Save</button>
            </div>
          </div>
        </section>

        {/* Trial + lock controls */}
        <section className="panel">
          <div className="panel-head"><h3>Trial &amp; access</h3></div>
          <div className="field">
            <label>Extend trial by</label>
            <div className="super-inline">
              <input type="number" min={1} max={3650} value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
              <span className="muted" style={{ alignSelf: 'center' }}>days</span>
              <button className="btn" disabled={extendTrial.isPending || !extendDays} onClick={() => extendTrial.mutate({ days: Number(extendDays) })}>
                <Clock size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Extend
              </button>
            </div>
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

        {/* Danger zone */}
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
      </div>
    </div>
  );
}
