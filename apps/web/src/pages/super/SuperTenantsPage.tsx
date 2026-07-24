import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Lock, ArrowUp, ArrowDown } from 'lucide-react';

import { useAdminTenants, useAdminCreateTenant, useAdminPlans, type AdminTenant } from '@/lib/api';
import { Modal } from '@/components/Modal';

function fmtDate(s?: string) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Whole days from now to `s` (negative = in the past). */
function daysUntil(s: string): number {
  return Math.round((new Date(s).getTime() - Date.now()) / 86_400_000);
}

/** Human "in 3 days" / "5 days ago" / "today" for a date string. */
function fmtRelative(s?: string): string {
  if (!s) return '';
  const d = daysUntil(s);
  if (d === 0) return 'today';
  if (d > 0) return d === 1 ? 'in 1 day' : `in ${d} days`;
  const ago = -d;
  return ago === 1 ? '1 day ago' : `${ago} days ago`;
}

type Level = 'critical' | 'warn' | 'ok';
const LEVEL_RANK: Record<Level, number> = { critical: 0, warn: 1, ok: 2 };

/** A paid subscription whose paid-through date has lapsed (flag-only). */
function isPastDue(t: AdminTenant) {
  return t.status === 'active' && t.billing_state !== 'write_locked' && !!t.paid_through_at && new Date(t.paid_through_at) < new Date();
}

/** The date this workspace next needs attention: paid-through for a paying
 *  tenant, else the trial end. `none` = comped / no clock running. */
function expiryOf(t: AdminTenant): { at: string | null; kind: 'trial' | 'paid' | 'none' } {
  if (t.paid_through_at) return { at: t.paid_through_at, kind: 'paid' };
  if (t.trial_ends_at) return { at: t.trial_ends_at, kind: 'trial' };
  return { at: null, kind: 'none' };
}

/** Action urgency — drives row color + the default sort. */
function levelOf(t: AdminTenant): Level {
  if (t.status !== 'active' || t.billing_state === 'write_locked') return 'critical';
  const { at } = expiryOf(t);
  if (!at) return 'ok';
  const d = daysUntil(at);
  if (d < 0) return 'critical'; // lapsed trial or past-due
  if (d <= 14) return 'warn'; // expiring soon (matches the KPI window)
  return 'ok';
}

function statusPill(t: AdminTenant) {
  if (t.status !== 'active') return <span className="pill bad">{t.status}</span>;
  if (t.billing_state === 'write_locked') return <span className="pill bad"><Lock size={11} strokeWidth={2} /> locked</span>;
  if (isPastDue(t)) return <span className="pill warn">past due</span>;
  return <span className="pill ok">active</span>;
}

type SortKey = 'urgency' | 'name' | 'plan' | 'expires' | 'created';

/** Sort value for expiry — nulls sort last (ascending). */
function expNum(t: AdminTenant): number {
  const { at } = expiryOf(t);
  return at ? new Date(at).getTime() : Number.POSITIVE_INFINITY;
}
function dateNum(s?: string): number {
  return s ? new Date(s).getTime() : Number.POSITIVE_INFINITY;
}

export function SuperTenantsPage() {
  const q = useAdminTenants();
  const create = useAdminCreateTenant();
  const plans = useAdminPlans();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', owner_email: '', plan_key: 'trial', phone: '' });
  const [slugError, setSlugError] = useState<string | null>(null);

  // Default view = action-first: most urgent (locked / lapsed) at the top.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'urgency', dir: 'asc' });
  const [focus, setFocus] = useState<null | 'past_due' | 'expiring'>(null);

  const summary = q.data?.summary;
  const planOptions = (plans.data?.plans ?? []).filter((p) => p.active);

  const rows = useMemo(() => {
    let list = q.data?.tenants ?? [];
    if (focus === 'past_due') list = list.filter(isPastDue);
    if (focus === 'expiring') list = list.filter((t) => expiryOf(t).kind === 'trial' && levelOf(t) === 'warn');

    const cmp = (a: AdminTenant, b: AdminTenant): number => {
      switch (sort.key) {
        case 'name': return a.name.localeCompare(b.name);
        case 'plan': return a.plan_name.localeCompare(b.plan_name);
        case 'created': return dateNum(a.created_at) - dateNum(b.created_at);
        case 'expires': return expNum(a) - expNum(b);
        case 'urgency':
        default: {
          const l = LEVEL_RANK[levelOf(a)] - LEVEL_RANK[levelOf(b)];
          return l !== 0 ? l : expNum(a) - expNum(b);
        }
      }
    };
    return [...list].sort((a, b) => (sort.dir === 'asc' ? cmp(a, b) : -cmp(a, b)));
  }, [q.data?.tenants, sort, focus]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const SortHead = ({ k, label }: { k: SortKey; label: string }) => (
    <th className="th-sort" aria-sort={sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-sort-btn" onClick={() => toggleSort(k)}>
        {label}
        {sort.key === k && (sort.dir === 'asc' ? <ArrowUp size={11} strokeWidth={2.2} /> : <ArrowDown size={11} strokeWidth={2.2} />)}
      </button>
    </th>
  );

  const onCreate = async () => {
    if (!form.name.trim() || !form.owner_email.trim() || !form.phone.trim()) return;
    const slug = form.slug.trim();
    // Mirror the server's slugRe so the user gets an inline message before the
    // round-trip; the backend still returns a 400 as the safety net.
    if (slug && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      setSlugError('Lowercase letters, numbers and hyphens only (2–63 chars). Leave blank to derive from the name.');
      return;
    }
    setSlugError(null);
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        slug: slug || undefined,
        owner_email: form.owner_email.trim(),
        plan_key: form.plan_key,
        phone: form.phone.trim(),
      });
      setShowCreate(false);
      setForm({ name: '', slug: '', owner_email: '', plan_key: 'trial', phone: '' });
    } catch {
      /* surfaced via create.error */
    }
  };

  return (
    <div className="super-page">
      <div className="super-page-head">
        <div>
          <span className="super-eyebrow">Workspaces</span>
          <h1>Tenants</h1>
        </div>
        <button className="btn primary" onClick={() => { setSlugError(null); setShowCreate(true); }}>
          <Plus size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> New tenant
        </button>
      </div>

      {summary && (
        <div className="kpis">
          <div className="kpi"><span className="kpi-label">Total</span><span className="kpi-value">{summary.total}</span></div>
          <div className="kpi"><span className="kpi-label">Active</span><span className="kpi-value">{summary.active}</span></div>
          <button
            type="button"
            className={`kpi kpi-btn${focus === 'expiring' ? ' is-active' : ''}`}
            aria-pressed={focus === 'expiring'}
            onClick={() => setFocus((f) => (f === 'expiring' ? null : 'expiring'))}
          >
            <span className="kpi-label">Trials expiring ≤14d</span><span className="kpi-value">{summary.trials_expiring_soon}</span>
          </button>
          <button
            type="button"
            className={`kpi kpi-btn${focus === 'past_due' ? ' is-active' : ''}`}
            aria-pressed={focus === 'past_due'}
            onClick={() => setFocus((f) => (f === 'past_due' ? null : 'past_due'))}
          >
            <span className="kpi-label">Past due</span><span className="kpi-value">{summary.past_due}</span>
          </button>
          <div className="kpi">
            <span className="kpi-label">By plan</span>
            <span className="kpi-value kpi-byplan">
              {Object.entries(summary.by_plan).map(([k, v]) => <em key={k}>{k}: {v}</em>)}
            </span>
          </div>
        </div>
      )}

      {focus && (
        <div className="table-filter-note">
          Showing {focus === 'past_due' ? 'past-due' : 'trials expiring soon'} only.
          <button type="button" className="linklike" onClick={() => setFocus(null)}>Clear filter</button>
        </div>
      )}

      {q.isError && <div className="banner-error">{q.error?.message ?? 'Failed to load tenants'}</div>}

      <div className="table-scroll">
        <table className="t">
          <thead>
            <tr>
              <SortHead k="name" label="Cafe" />
              <SortHead k="plan" label="Plan" />
              <th>Seats</th>
              <th>Status</th>
              <SortHead k="expires" label="Expires" />
              <th>Owner</th>
              <th>Phone</th>
              <SortHead k="created" label="Created" />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const level = levelOf(t);
              const { at, kind } = expiryOf(t);
              return (
                <tr key={t.tenant_id} className={level === 'critical' ? 'row-critical' : level === 'warn' ? 'row-warn' : undefined}>
                  <td>
                    <Link to={`/super/tenants/${t.tenant_id}`} className="super-tenant-link">
                      <strong>{t.name}</strong>
                      <em>{t.slug}</em>
                    </Link>
                  </td>
                  <td>{t.plan_name}</td>
                  <td>{t.active_members + t.pending_invites}{t.member_limit !== null ? ` / ${t.member_limit}` : ' / ∞'}</td>
                  <td>{statusPill(t)}</td>
                  <td>
                    {at ? (
                      <span className={`expiry expiry-${level}`}>
                        <span className="expiry-date">{fmtDate(at)}</span>
                        <span className="expiry-rel">{kind === 'trial' ? 'trial · ' : ''}{fmtRelative(at)}</span>
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{t.owner_email ?? <span className="muted">— no owner yet</span>}</td>
                  <td>{t.contact_phone ? t.contact_phone : <span className="muted">—</span>}</td>
                  <td>{fmtDate(t.created_at)}</td>
                </tr>
              );
            })}
            {!q.isPending && rows.length === 0 && (
              <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No tenants{focus ? ' match this filter' : ' yet'}.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={showCreate} title="New tenant" subtitle="Provisions a workspace + sends the owner an invite." onClose={() => setShowCreate(false)}>
        {create.isError && <div className="banner-error">{create.error?.message ?? 'Could not create'}</div>}
        <div className="field"><label>Cafe name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></div>
        <div className="field">
          <label>Slug (optional)</label>
          <input
            value={form.slug}
            onChange={(e) => { setForm({ ...form, slug: e.target.value }); if (slugError) setSlugError(null); }}
            placeholder="derived from name"
          />
          {slugError
            ? <div className="field-error">{slugError}</div>
            : <div className="field-hint">Lowercase letters, numbers and hyphens — leave blank to derive from the name.</div>}
        </div>
        <div className="field"><label>Owner email</label><input type="email" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} placeholder="owner@cafe.com" /></div>
        <div className="field"><label>Contact phone</label><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+977 …" /></div>
        <div className="field">
          <label>Plan</label>
          <select value={form.plan_key} onChange={(e) => setForm({ ...form, plan_key: e.target.value })}>
            {planOptions.map((p) => (
              <option key={p.key} value={p.key}>{p.name}{p.trial_days > 0 ? ` · ${p.trial_days}-day trial` : ''}</option>
            ))}
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
          <button className="btn primary" onClick={onCreate} disabled={create.isPending || !form.name.trim() || !form.owner_email.trim() || !form.phone.trim()}>
            {create.isPending ? 'Creating…' : 'Create & invite owner'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
