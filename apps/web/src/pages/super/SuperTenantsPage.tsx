import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Lock } from 'lucide-react';

import { useAdminTenants, useAdminCreateTenant, useAdminPlans, type AdminTenant } from '@/lib/api';
import { Modal } from '@/components/Modal';

function fmtDate(s?: string) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A paid subscription whose paid-through date has lapsed (flag-only). */
function isPastDue(t: AdminTenant) {
  return t.status === 'active' && t.billing_state !== 'write_locked' && !!t.paid_through_at && new Date(t.paid_through_at) < new Date();
}

function statusPill(t: AdminTenant) {
  if (t.status !== 'active') return <span className="pill">{t.status}</span>;
  if (t.billing_state === 'write_locked') return <span className="pill"><Lock size={11} strokeWidth={2} /> locked</span>;
  if (isPastDue(t)) return <span className="pill warn">past due</span>;
  return <span className="pill ok">active</span>;
}

export function SuperTenantsPage() {
  const q = useAdminTenants();
  const create = useAdminCreateTenant();
  const plans = useAdminPlans();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', owner_email: '', plan_key: 'trial', phone: '' });
  const [slugError, setSlugError] = useState<string | null>(null);

  const summary = q.data?.summary;
  const tenants = q.data?.tenants ?? [];
  const planOptions = (plans.data?.plans ?? []).filter((p) => p.active);

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
          <div className="kpi"><span className="kpi-label">Trials expiring ≤14d</span><span className="kpi-value">{summary.trials_expiring_soon}</span></div>
          <div className="kpi"><span className="kpi-label">Past due</span><span className="kpi-value">{summary.past_due}</span></div>
          <div className="kpi">
            <span className="kpi-label">By plan</span>
            <span className="kpi-value kpi-byplan">
              {Object.entries(summary.by_plan).map(([k, v]) => <em key={k}>{k}: {v}</em>)}
            </span>
          </div>
        </div>
      )}

      {q.isError && <div className="banner-error">{q.error?.message ?? 'Failed to load tenants'}</div>}

      <div className="table-scroll">
        <table className="t">
          <thead>
            <tr>
              <th>Cafe</th><th>Plan</th><th>Seats</th><th>Status</th><th>Trial ends</th><th>Owner</th><th>Phone</th><th>Created</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.tenant_id}>
                <td>
                  <Link to={`/super/tenants/${t.tenant_id}`} className="super-tenant-link">
                    <strong>{t.name}</strong>
                    <em>{t.slug}</em>
                  </Link>
                </td>
                <td>{t.plan_name}</td>
                <td>{t.active_members + t.pending_invites}{t.member_limit !== null ? ` / ${t.member_limit}` : ' / ∞'}</td>
                <td>{statusPill(t)}</td>
                <td>{fmtDate(t.trial_ends_at)}</td>
                <td>{t.owner_email ?? <span className="muted">— no owner yet</span>}</td>
                <td>{t.contact_phone ? t.contact_phone : <span className="muted">—</span>}</td>
                <td>{fmtDate(t.created_at)}</td>
              </tr>
            ))}
            {!q.isPending && tenants.length === 0 && (
              <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No tenants yet.</td></tr>
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
