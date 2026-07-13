import { useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Lock, Unlock, Ban, RotateCcw, Clock, Trash2, CreditCard, Gift, Info, SlidersHorizontal, ToggleRight, AlertTriangle } from 'lucide-react';

import {
  useAdminTenant,
  useAdminChangePlan,
  useAdminSetSeatOverride,
  useAdminExtendTrial,
  useAdminWriteLock,
  useAdminSuspend,
  useAdminReactivate,
  useAdminDeleteTenant,
  useAdminTenantDataSummary,
  useAdminTenantPayments,
  useAdminRecordPayment,
  useAdminSetSubscription,
  useAdminPlans,
  useAdminFeatures,
  useAdminSetFeatures,
  type AdminTenantDetail,
  type AdminPlan,
  type RecordPaymentInput,
  type PurgeScope,
} from '@/lib/api';
import { Tabs, type TabItem } from '@/components/Tabs';
import { useConfirm } from '@/components/ConfirmDialog';
import { useTenant } from '@/lib/tenant';

// Grace window after a trial ends before writes auto-lock (mirrors the backend
// billing.GraceDays so the detail page can label trial-ended tenants).
const GRACE_DAYS = 7;

function fmtDate(s?: string) {
  return s ? new Date(s).toLocaleString() : '—';
}

function fmtDay(s?: string) {
  return s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

function fmtMoney(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Derived subscription status — mirrors backend billing.ComputeState so the
 *  console shows the same trial/paid/comped/past-due/locked picture. */
function subStatus(t: AdminTenantDetail): { label: string; cls: string } {
  if (t.status !== 'active') return { label: t.status, cls: '' };
  if (t.billing_state === 'write_locked') return { label: 'Locked (manual)', cls: '' };
  const now = Date.now();
  // Mirror billing.ComputeState ordering: a CURRENT paid-through date wins over
  // a (possibly stale) trial date — a paying tenant is active, never trial-locked.
  if (t.paid_through_at && new Date(t.paid_through_at).getTime() > now) {
    return { label: 'Active (paid)', cls: 'ok' };
  }
  if (t.trial_ends_at) {
    const end = new Date(t.trial_ends_at).getTime();
    if (end > now) return { label: 'Trialing', cls: 'ok' };
    if (now < end + GRACE_DAYS * 86_400_000) return { label: 'Trial ended (grace)', cls: 'warn' };
    return { label: 'Trial expired (locked)', cls: '' };
  }
  if (t.paid_through_at) return { label: 'Past due', cls: 'warn' };
  return { label: 'Comped (perpetual)', cls: 'ok' };
}

type DetailTab = 'overview' | 'plan' | 'features' | 'billing' | 'danger';

const DETAIL_TABS: TabItem<DetailTab>[] = [
  { key: 'overview', label: 'Overview', icon: <Info size={12} strokeWidth={1.6} /> },
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

  const [tab, setTab] = useState<DetailTab>('overview');
  const [seatOverride, setSeatOverride] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const [lockNote, setLockNote] = useState('');

  const t = q.data;
  if (q.isPending) return <div className="super-page"><div className="empty-state">Loading…</div></div>;
  if (q.isError || !t) return <div className="super-page"><div className="banner-error">{q.error?.message ?? 'Not found'}</div></div>;

  const locked = t.billing_state === 'write_locked';
  const status = subStatus(t);

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
        <span className={`pill ${status.cls}`}>{locked && <Lock size={11} strokeWidth={2} />} {status.label}</span>
      </div>

      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Tabs items={DETAIL_TABS} active={tab} onChange={setTab} ariaLabel="Tenant sections" />
      </div>

      {tab === 'overview' && (
        <section className="panel">
          <div className="panel-head"><h3>Overview</h3></div>
          <dl className="super-dl">
            <dt>Plan</dt><dd>{t.plan_name} ({t.plan_key})</dd>
            <dt>Status</dt><dd>{status.label}</dd>
            <dt>Seats used</dt><dd>{t.active_members + t.pending_invites}{t.member_limit !== null ? ` / ${t.member_limit}` : ' / ∞'} ({t.active_members} active, {t.pending_invites} pending)</dd>
            <dt>Seat override</dt><dd>{t.member_limit_override ?? '— (plan default)'}</dd>
            {t.trial_ends_at && (<><dt>Trial ends</dt><dd>{fmtDate(t.trial_ends_at)}</dd></>)}
            <dt>Paid through</dt><dd>{t.paid_through_at ? fmtDay(t.paid_through_at) : '— (no paid subscription)'}</dd>
            <dt>Owner</dt><dd>{t.owner_email ?? '— no owner yet'}</dd>
            <dt>Created</dt><dd>{fmtDate(t.created_at)}</dd>
            <dt>Last activity</dt><dd>{fmtDate(t.last_activity)}</dd>
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
    </div>
  );
}

// Per-tenant feature editor. Effective-checkbox model: the plan's own features
// form the baseline; ticking/unticking computes the minimal grant/revoke delta
// vs that baseline (billing.ComputeState applies grant - revoke on top of the
// plan). A dot + "reset to plan" appears whenever a feature differs from the
// plan default. Overrides are ignored while the tenant is trialing.
function FeaturesTab({ id, t, plans }: { id: string; t: AdminTenantDetail; plans: AdminPlan[] }) {
  const features = useAdminFeatures();
  const setFeatures = useAdminSetFeatures(id);

  const plan = plans.find((p) => p.key === t.plan_key);
  const base = useMemo(() => new Set(plan?.features ?? []), [plan]);

  const overrides = t.feature_overrides ?? {};
  const grant = useMemo(() => new Set(overrides.grant ?? []), [overrides]);
  const revoke = useMemo(() => new Set(overrides.revoke ?? []), [overrides]);

  const trialing = !!t.trial_ends_at && new Date(t.trial_ends_at).getTime() > Date.now();

  const defs = features.data?.features ?? [];
  const isEffective = (key: string) => (base.has(key) || grant.has(key)) && !revoke.has(key);
  const isOverridden = (key: string) => isEffective(key) !== base.has(key);

  // Recompute overrides from a full desired-effective set (minimal delta vs the
  // plan baseline), then persist. Called for every toggle / reset so the two
  // override lists never accumulate stale entries.
  const applyEffective = (nextEffective: Set<string>) => {
    const newGrant: string[] = [];
    const newRevoke: string[] = [];
    for (const fd of defs) {
      const eff = nextEffective.has(fd.key);
      if (eff && !base.has(fd.key)) newGrant.push(fd.key);
      else if (!eff && base.has(fd.key)) newRevoke.push(fd.key);
    }
    setFeatures.mutate({ grant: newGrant, revoke: newRevoke });
  };

  const currentEffective = () => new Set(defs.filter((fd) => isEffective(fd.key)).map((fd) => fd.key));

  const toggle = (key: string) => {
    const next = currentEffective();
    if (next.has(key)) next.delete(key);
    else next.add(key);
    applyEffective(next);
  };

  const reset = (key: string) => {
    const next = currentEffective();
    if (base.has(key)) next.add(key);
    else next.delete(key);
    applyEffective(next);
  };

  if (features.isPending || !plan) return <section className="panel"><div className="empty-state">Loading…</div></section>;
  if (features.isError) return <section className="panel"><div className="banner-error">{features.error?.message ?? 'Could not load features'}</div></section>;

  // Group defs by their registry group, preserving registry order.
  const groups: { name: string; items: typeof defs }[] = [];
  for (const fd of defs) {
    let g = groups.find((x) => x.name === fd.group);
    if (!g) { g = { name: fd.group, items: [] }; groups.push(g); }
    g.items.push(fd);
  }

  return (
    <section className="panel">
      <div className="panel-head"><h3>Features</h3></div>
      <p className="hint">
        The <strong>{t.plan_name}</strong> plan sets the baseline. Tick or untick to grant or revoke a
        feature for <strong>just this tenant</strong>; a dot marks anything overridden from the plan default.
      </p>
      {trialing && (
        <p className="banner-info" style={{ marginTop: 8 }}>
          This tenant is trialing — <strong>all</strong> features are active until the trial ends, regardless
          of these settings. The overrides take effect once the trial is over.
        </p>
      )}
      {setFeatures.isError && <p className="banner-error" style={{ marginTop: 8 }}>{setFeatures.error?.message}</p>}

      <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
        {groups.map((g) => (
          <div key={g.name}>
            <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{g.name}</div>
            <div className="super-checks">
              {g.items.map((fd) => {
                const overridden = isOverridden(fd.key);
                return (
                  <label key={fd.key} className="super-check" title={fd.desc}>
                    <input
                      type="checkbox"
                      checked={isEffective(fd.key)}
                      disabled={setFeatures.isPending}
                      onChange={() => toggle(fd.key)}
                    />
                    <span>{fd.label}</span>
                    {base.has(fd.key) && !overridden && <span className="muted" style={{ fontSize: 11 }}>· from plan</span>}
                    {overridden && (
                      <>
                        <span title="Overridden from the plan default" style={{ color: 'var(--amber-fg)', fontSize: 11 }}>● overridden</span>
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '2px 6px', fontSize: 11 }}
                          disabled={setFeatures.isPending}
                          onClick={() => reset(fd.key)}
                        >
                          <RotateCcw size={11} strokeWidth={1.8} style={{ marginRight: 2 }} /> reset
                        </button>
                      </>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addMonths(base: Date, months: number) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

const PAY_METHODS: RecordPaymentInput['method'][] = ['cash', 'bank', 'online', 'other'];

// Manual subscription management — no payment integration. Recording a payment
// advances the paid-through date; "Mark comped" clears it (perpetual access).
function SubscriptionPanel({ id, t }: { id: string; t: AdminTenantDetail }) {
  const record = useAdminRecordPayment(id);
  const setSub = useAdminSetSubscription(id);
  const payments = useAdminTenantPayments(id);
  const confirm = useConfirm();

  // Renewals extend from the end of the current paid period when still active,
  // otherwise from today.
  const renewBase = () => {
    const now = new Date();
    if (t.paid_through_at) {
      const pt = new Date(t.paid_through_at);
      if (pt > now) return pt;
    }
    return now;
  };

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<RecordPaymentInput['method']>('cash');
  const [periodEnd, setPeriodEnd] = useState(isoDay(addMonths(renewBase(), 1)));
  const [note, setNote] = useState('');
  const [override, setOverride] = useState('');

  const cents = Math.round((parseFloat(amount) || 0) * 100);
  const canRecord = cents >= 0 && amount.trim() !== '' && !!periodEnd && !record.isPending;

  const onRecord = () => {
    if (!canRecord) return;
    record.mutate(
      { amount_cents: cents, method, period_end: periodEnd, note: note.trim() || undefined },
      { onSuccess: () => { setAmount(''); setNote(''); } },
    );
  };

  const onComp = async () => {
    if (await confirm({ title: 'Mark comped?', message: 'Clears the paid-through date — the workspace gets perpetual access and is never flagged past due. Use for internal / enterprise tenants.', confirmLabel: 'Mark comped' })) {
      setSub.mutate({ paid_through_at: null });
    }
  };

  const list = payments.data?.payments ?? [];

  return (
    <section className="panel">
      <div className="panel-head"><h3>Subscription &amp; payments</h3></div>
      <p className="hint">
        Paid through <strong>{t.paid_through_at ? fmtDay(t.paid_through_at) : '— (comped / no paid subscription)'}</strong>.
        A lapsed paid subscription is flagged <em>past due</em> but writes stay open — lock manually above if needed.
      </p>

      {(record.isError || setSub.isError) && <div className="banner-error">{record.error?.message ?? setSub.error?.message}</div>}

      <div className="field">
        <label>Record a payment</label>
        <div className="super-inline">
          <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="amount (Rs)" style={{ width: 120 }} />
          <select value={method} onChange={(e) => setMethod(e.target.value as RecordPaymentInput['method'])}>
            {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Paid through</label>
        <div className="super-inline">
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          <button type="button" className="btn" onClick={() => setPeriodEnd(isoDay(addMonths(renewBase(), 1)))}>+1mo</button>
          <button type="button" className="btn" onClick={() => setPeriodEnd(isoDay(addMonths(renewBase(), 3)))}>+3mo</button>
          <button type="button" className="btn" onClick={() => setPeriodEnd(isoDay(addMonths(renewBase(), 12)))}>+1yr</button>
        </div>
      </div>
      <div className="field">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" />
      </div>
      <div className="super-inline">
        <button className="btn primary" disabled={!canRecord} onClick={onRecord}>
          <CreditCard size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> {record.isPending ? 'Recording…' : 'Record payment'}
        </button>
        <button className="btn" disabled={setSub.isPending} onClick={onComp}>
          <Gift size={14} strokeWidth={1.7} style={{ marginRight: 4 }} /> Mark comped
        </button>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label>Or set paid-through manually</label>
        <div className="super-inline">
          <input type="date" value={override} onChange={(e) => setOverride(e.target.value)} />
          <button className="btn" disabled={!override || setSub.isPending} onClick={() => setSub.mutate({ paid_through_at: override }, { onSuccess: () => setOverride('') })}>Apply</button>
        </div>
      </div>

      {list.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="t">
            <thead><tr><th>Recorded</th><th>Amount</th><th>Method</th><th>Through</th><th>Note</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDay(p.created_at)}</td>
                  <td>{fmtMoney(p.amount_cents, p.currency)}</td>
                  <td>{p.method}</td>
                  <td>{p.period_end}</td>
                  <td>{p.note || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Category checkboxes. menu/tables/house_tabs/owners RESTRICT-reference
// transaction rows, so picking them implies 'transactions' (auto-added below
// and shown in the preview). logs/inventory/staff are independent.
const CATS: { key: PurgeScope; label: string; requires?: PurgeScope[] }[] = [
  { key: 'logs', label: 'Activity & audit logs' },
  { key: 'transactions', label: 'Sales & operations — orders, payments, shifts, expenses, ledgers' },
  { key: 'menu', label: 'Menu & categories', requires: ['transactions'] },
  { key: 'tables', label: 'Tables', requires: ['transactions'] },
  { key: 'house_tabs', label: 'Credit accounts', requires: ['transactions'] },
  { key: 'owners', label: 'Owners', requires: ['transactions'] },
  { key: 'inventory', label: 'Inventory & stock' },
  { key: 'staff', label: 'Staff records' },
];

function DangerDeletePanel({ id, slug, name }: { id: string; slug: string; name: string }) {
  const navigate = useNavigate();
  const { slug: activeSlug, setSlug } = useTenant();
  const summary = useAdminTenantDataSummary(id);
  const del = useAdminDeleteTenant(id);

  const [everything, setEverything] = useState(false);
  const [picked, setPicked] = useState<Set<PurgeScope>>(new Set());
  const [confirmText, setConfirmText] = useState('');

  const counts = summary.data?.counts;

  // Expand picks to include forced dependencies (catalog -> transactions).
  const effective = new Set<PurgeScope>(picked);
  picked.forEach((k) => CATS.find((c) => c.key === k)?.requires?.forEach((r) => effective.add(r)));

  const toggle = (k: PurgeScope) => {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };

  const scopes = everything ? ['everything'] : Array.from(effective);
  const totalRows = everything
    ? Object.values(counts ?? {}).reduce((a, b) => a + b, 0)
    : Array.from(effective).reduce((a, k) => a + (counts?.[k] ?? 0), 0);
  const canSubmit = confirmText.trim() === slug && scopes.length > 0 && !del.isPending;

  const run = () =>
    del.mutate(
      { confirm_slug: slug, scopes },
      {
        onSuccess: (res) => {
          if (res.deleted) {
            // If the admin just nuked their own active workspace, drop the stale
            // slug so they land on the workspace picker, not a broken /admin.
            if (activeSlug === slug) setSlug(null);
            navigate('/super/tenants');
          } else {
            summary.refetch();
          }
        },
      },
    );

  return (
    <section className="panel">
      <div className="panel-head"><h3>Delete data</h3></div>
      <p className="hint">
        Permanently removes the selected data. Deleting something also removes anything linked to it
        (e.g. orders take their payments; menu can only go once the sales that reference it are cleared —
        those get included automatically). Shared user accounts are always kept. There is no undo.
      </p>

      <label className="golive-check" style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
        <input type="checkbox" checked={everything} onChange={(e) => setEverything(e.target.checked)} />
        Everything — delete the whole cafe (removes the workspace)
      </label>

      {!everything && (
        <div style={{ display: 'grid', gap: 6, margin: '10px 0 0 4px' }}>
          {CATS.map((c) => {
            const forced = !picked.has(c.key) && effective.has(c.key); // pulled in as a dependency
            return (
              <label key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: forced ? 0.8 : 1 }}>
                <input
                  type="checkbox"
                  checked={effective.has(c.key)}
                  disabled={forced}
                  onChange={() => toggle(c.key)}
                />
                <span>
                  {c.label}
                  {counts && <span className="muted"> · {counts[c.key]} rows</span>}
                  {forced && <span className="muted"> (required by another selection)</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {everything && summary.data?.you_are_member && (
        <p className="banner-warn" style={{ marginTop: 10 }}>
          You are a member of this workspace. Deleting it removes <strong>your</strong> access to it
          (you stay a platform admin and can re-create or manage other cafes).
        </p>
      )}

      {scopes.length > 0 && (
        <p className="hint" style={{ marginTop: 10 }}>
          Will permanently delete <strong>{totalRows}</strong> row{totalRows === 1 ? '' : 's'}
          {everything ? ' and the workspace itself' : ''}. Type the slug <code>{slug}</code> to confirm.
        </p>
      )}

      <div className="super-inline" style={{ marginTop: 6 }}>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={slug} />
        <button className="btn danger" disabled={!canSubmit} onClick={run}>
          <Trash2 size={14} strokeWidth={1.7} style={{ marginRight: 4 }} />
          {del.isPending ? 'Deleting…' : everything ? 'Delete workspace' : 'Delete selected'}
        </button>
      </div>
      {del.isError && <p className="banner-error" style={{ marginTop: 8 }}>{del.error?.message}</p>}
      {del.isSuccess && !del.data?.deleted && (
        <p className="banner-info" style={{ marginTop: 8 }}>Deleted {del.data?.rows_purged} rows. {name} kept.</p>
      )}
    </section>
  );
}
