import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Lock, ArrowUp, ArrowDown } from 'lucide-react';

import { useAdminTenants, useAdminCreateTenant, useAdminPlans, type AdminTenant } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { DateStamp } from '@/components/super/DateStamp';
import { fmtDay } from '@/lib/dates';
import { billingView, urgencyOf, expiryTime, URGENCY_RANK, SOON_DAYS } from '@/lib/superBilling';

function statusPill(t: AdminTenant) {
  const v = billingView(t);
  return (
    <span className={`pill ${v.pill || 'bad'}`}>
      {v.writeLocked && <Lock size={11} strokeWidth={2} />} {v.label}
    </span>
  );
}

type SortKey = 'urgency' | 'name' | 'plan' | 'expires' | 'created';

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
    if (focus === 'past_due') list = list.filter((t) => billingView(t).phase === 'past_due');
    if (focus === 'expiring') list = list.filter((t) => billingView(t).phase === 'trial' && urgencyOf(t) === 'warn');

    const cmp = (a: AdminTenant, b: AdminTenant): number => {
      switch (sort.key) {
        case 'name': return a.name.localeCompare(b.name);
        case 'plan': return a.plan_name.localeCompare(b.plan_name);
        case 'created': return dateNum(a.created_at) - dateNum(b.created_at);
        case 'expires': return expiryTime(a) - expiryTime(b);
        case 'urgency':
        default: {
          const l = URGENCY_RANK[urgencyOf(a)] - URGENCY_RANK[urgencyOf(b)];
          return l !== 0 ? l : expiryTime(a) - expiryTime(b);
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
    <PageShell
      eyebrow="Platform"
      title="Cafés"
      subtitle={`${q.data?.tenants.length ?? 0} workspaces`}
      docTitle="Cafés"
      actions={
        <button className="btn primary" onClick={() => { setSlugError(null); setShowCreate(true); }}>
          <Plus size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> New café
        </button>
      }
    >
      {summary && (
        // `.label` / `.value` are the real class names (admin.css) — the page
        // previously emitted `.kpi-label` / `.kpi-value`, which match nothing,
        // so the hero numerals rendered at body size.
        <div className="kpis">
          <div className="kpi"><span className="label">Total</span><span className="value">{summary.total}</span></div>
          <div className="kpi"><span className="label">Active</span><span className="value">{summary.active}</span></div>
          <button
            type="button"
            className={`kpi kpi-btn${focus === 'expiring' ? ' is-active' : ''}`}
            aria-pressed={focus === 'expiring'}
            onClick={() => setFocus((f) => (f === 'expiring' ? null : 'expiring'))}
          >
            <span className="label">Trials expiring ≤{SOON_DAYS}d</span><span className="value">{summary.trials_expiring_soon}</span>
          </button>
          <button
            type="button"
            className={`kpi kpi-btn${focus === 'past_due' ? ' is-active' : ''}`}
            aria-pressed={focus === 'past_due'}
            onClick={() => setFocus((f) => (f === 'past_due' ? null : 'past_due'))}
          >
            <span className="label">Past due</span><span className="value">{summary.past_due}</span>
          </button>
          <div className="kpi">
            <span className="label">By plan</span>
            <span className="value kpi-byplan">
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

      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        isEmpty={rows.length === 0}
        errorTitle="Could not load the café list"
        loadingLabel="Loading workspaces…"
        emptyTitle={focus ? 'No cafés match this filter' : 'No cafés yet'}
        emptyHint={focus ? 'Clear the filter above to see every workspace.' : 'Provision one with “New café”, or approve an access request.'}
      >
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
              const level = urgencyOf(t);
              const v = billingView(t);
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
                    <DateStamp
                      at={v.governingDate}
                      label={v.dateLabel || undefined}
                      tone={level === 'critical' ? 'critical' : level === 'warn' ? 'warn' : 'ok'}
                      fallback="—"
                    />
                  </td>
                  <td>{t.owner_email ?? <span className="muted">— no owner yet</span>}</td>
                  <td>{t.contact_phone ? t.contact_phone : <span className="muted">—</span>}</td>
                  <td>{fmtDay(t.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </QueryState>

      <Modal open={showCreate} title="New café" subtitle="Provisions a workspace + sends the owner an invite." onClose={() => setShowCreate(false)}>
        {create.isError && <div className="banner-error">{create.error?.message ?? 'Could not create'}</div>}
        <div className="field"><label>Café name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></div>
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
    </PageShell>
  );
}
