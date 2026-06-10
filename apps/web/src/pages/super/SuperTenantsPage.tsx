import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Lock } from 'lucide-react';

import { useAdminTenants, useAdminCreateTenant, type AdminTenant } from '@/lib/api';
import { Modal } from '@/components/Modal';

function fmtDate(s?: string) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusPill(t: AdminTenant) {
  if (t.status !== 'active') return <span className="pill">{t.status}</span>;
  if (t.billing_state === 'write_locked') return <span className="pill"><Lock size={11} strokeWidth={2} /> locked</span>;
  return <span className="pill ok">active</span>;
}

export function SuperTenantsPage() {
  const q = useAdminTenants();
  const create = useAdminCreateTenant();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', owner_email: '', plan_key: 'trial' });

  const summary = q.data?.summary;
  const tenants = q.data?.tenants ?? [];

  const onCreate = async () => {
    if (!form.name.trim() || !form.owner_email.trim()) return;
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        slug: form.slug.trim() || undefined,
        owner_email: form.owner_email.trim(),
        plan_key: form.plan_key,
      });
      setShowCreate(false);
      setForm({ name: '', slug: '', owner_email: '', plan_key: 'trial' });
    } catch {
      /* surfaced via create.error */
    }
  };

  return (
    <div className="super-page">
      <div className="super-page-head">
        <h1>Tenants</h1>
        <button className="btn primary" onClick={() => setShowCreate(true)}>
          <Plus size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> New tenant
        </button>
      </div>

      {summary && (
        <div className="kpis">
          <div className="kpi"><span className="kpi-label">Total</span><span className="kpi-value">{summary.total}</span></div>
          <div className="kpi"><span className="kpi-label">Active</span><span className="kpi-value">{summary.active}</span></div>
          <div className="kpi"><span className="kpi-label">Trials expiring ≤14d</span><span className="kpi-value">{summary.trials_expiring_soon}</span></div>
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
              <th>Cafe</th><th>Plan</th><th>Seats</th><th>Status</th><th>Trial ends</th><th>Owner</th><th>Created</th>
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
                <td>{fmtDate(t.created_at)}</td>
              </tr>
            ))}
            {!q.isPending && tenants.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No tenants yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={showCreate} title="New tenant" subtitle="Provisions a workspace + sends the owner an invite." onClose={() => setShowCreate(false)}>
        {create.isError && <div className="banner-error">{create.error?.message ?? 'Could not create'}</div>}
        <div className="field"><label>Cafe name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></div>
        <div className="field"><label>Slug (optional)</label><input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="derived from name" /></div>
        <div className="field"><label>Owner email</label><input type="email" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} placeholder="owner@cafe.com" /></div>
        <div className="field">
          <label>Plan</label>
          <select value={form.plan_key} onChange={(e) => setForm({ ...form, plan_key: e.target.value })}>
            <option value="trial">Trial (90 days)</option>
            <option value="standard">Standard</option>
            <option value="growth">Growth</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
          <button className="btn primary" onClick={onCreate} disabled={create.isPending || !form.name.trim() || !form.owner_email.trim()}>
            {create.isPending ? 'Creating…' : 'Create & invite owner'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
