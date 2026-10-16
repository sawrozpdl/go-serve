import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, GitBranchPlus, Unlink } from 'lucide-react';
import type { AdminPlan, AdminTenantDetail } from '@cafe-mgmt/api-types';

import {
  useAdminAddBranch,
  useAdminBusiness,
  useAdminBusinesses,
  useAdminCreateBusiness,
  useAdminRenameBusiness,
  useAdminSetTenantBusiness,
} from '@/lib/api';
import { useConfirm } from '@/components/ConfirmDialog';

/**
 * Branches (migration 0088). A business groups cafés as its branches: the
 * owner gets a branch switcher, an all-branches dashboard, and menu sync.
 *
 * Branches are created ONLY here — never self-serve — so this tab is the whole
 * lifecycle: make a café the first branch of a business, add branches to it,
 * and detach a café again (its data is never touched).
 */
export function BranchesTab({ t, plans }: { t: AdminTenantDetail; plans: AdminPlan[] }) {
  if (t.cloned_from_tenant_id) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h3>
            <Building2 size={14} strokeWidth={1.6} /> Branches
          </h3>
        </div>
        <p className="field-hint">
          A QA clone can't be a branch — its numbers would land in the owner's all-branches view.
        </p>
      </div>
    );
  }
  return t.business_id ? (
    <BusinessPanel t={t} businessId={t.business_id} plans={plans} />
  ) : (
    <StandalonePanel t={t} />
  );
}

function StandalonePanel({ t }: { t: AdminTenantDetail }) {
  const create = useAdminCreateBusiness();
  const attach = useAdminSetTenantBusiness(t.tenant_id);
  const businesses = useAdminBusinesses();
  const [name, setName] = useState(t.name);
  const [joinId, setJoinId] = useState('');
  const existing = businesses.data?.businesses ?? [];

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <h3>
            <Building2 size={14} strokeWidth={1.6} /> Make this a multi-branch business
          </h3>
        </div>
        <p className="field-hint">
          <strong>{t.name}</strong> becomes the first branch. Nothing about it changes — same data,
          same login, same QR. Its owners get a branch switcher once a second branch exists.
        </p>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Business name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.name} />
          <div className="field-hint">Shown above the branch name in the sidebar.</div>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate({ name: name.trim(), tenant_id: t.tenant_id })}
        >
          <Building2 size={14} strokeWidth={1.6} />
          {create.isPending ? 'Creating…' : 'Create business'}
        </button>
      </div>

      {existing.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>
              <GitBranchPlus size={14} strokeWidth={1.6} /> Or join an existing business
            </h3>
          </div>
          <div className="field">
            <label>Business</label>
            <select value={joinId} onChange={(e) => setJoinId(e.target.value)}>
              <option value="">Choose…</option>
              {existing.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} · {b.branches.length} {b.branches.length === 1 ? 'branch' : 'branches'}
                </option>
              ))}
            </select>
            <div className="field-hint">
              Owners of that business do NOT get access to this café automatically — invite them here
              if they should.
            </div>
          </div>
          <button
            type="button"
            className="btn"
            disabled={!joinId || attach.isPending}
            onClick={() => attach.mutate({ business_id: joinId })}
          >
            {attach.isPending ? 'Adding…' : 'Add as a branch'}
          </button>
        </div>
      )}
    </div>
  );
}

function BusinessPanel({ t, businessId, plans }: { t: AdminTenantDetail; businessId: string; plans: AdminPlan[] }) {
  const biz = useAdminBusiness(businessId);
  const rename = useAdminRenameBusiness(businessId);
  const detach = useAdminSetTenantBusiness(t.tenant_id);
  const addBranch = useAdminAddBranch(businessId);
  const confirm = useConfirm();

  const [bizName, setBizName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [phone, setPhone] = useState('');
  const [planKey, setPlanKey] = useState('');
  const [seed, setSeed] = useState<string>(t.tenant_id);

  const b = biz.data;
  const branches = b?.branches ?? [];
  // Phone and plan default to the branch being copied from (or the first
  // branch); show those values so "blank" never means a surprise.
  const ref = branches.find((br) => br.tenant_id === seed) ?? branches[0];
  const phoneRequired = !ref?.contact_phone;
  const nameValue = bizName ?? b?.name ?? t.business_name ?? '';

  const onDetach = async () => {
    const ok = await confirm({
      title: `Detach ${t.name}?`,
      message:
        'It becomes a standalone café again. Its data is untouched; it just leaves the branch switcher and the all-branches reports.',
      confirmLabel: 'Detach',
      danger: true,
    });
    if (ok) detach.mutate({ business_id: null });
  };

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <h3>
            <Building2 size={14} strokeWidth={1.6} /> {b?.name ?? t.business_name}
          </h3>
        </div>
        <div className="field">
          <label>Business name</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={nameValue} onChange={(e) => setBizName(e.target.value)} />
            <button
              type="button"
              className="btn"
              disabled={!bizName?.trim() || bizName.trim() === b?.name || rename.isPending}
              onClick={() => rename.mutate({ name: bizName!.trim() }, { onSuccess: () => setBizName(null) })}
            >
              Rename
            </button>
          </div>
        </div>

        <table className="t" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Branch</th>
              <th>Slug</th>
              <th>Plan</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {branches.map((br) => (
              <tr key={br.tenant_id}>
                <td>
                  {br.tenant_id === t.tenant_id ? (
                    <strong>{br.name} (this café)</strong>
                  ) : (
                    <Link to={`/super/tenants/${br.tenant_id}?tab=branches`}>{br.name}</Link>
                  )}
                </td>
                <td className="mono">/{br.slug}</td>
                <td>{br.plan_key ?? '—'}</td>
                <td>{br.status}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <button type="button" className="btn" style={{ marginTop: 12 }} onClick={onDetach} disabled={detach.isPending}>
          <Unlink size={14} strokeWidth={1.6} /> Detach this café
        </button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <GitBranchPlus size={14} strokeWidth={1.6} /> Add a branch
          </h3>
        </div>
        <p className="field-hint">
          Creates a new café in this business. Every owner of the business becomes an owner of it
          straight away. Its plan and billing are its own.
        </p>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Branch name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${b?.name ?? t.name} Thamel`} />
        </div>
        <div className="field">
          <label>Copy menu, tables, roles &amp; settings from</label>
          <select value={seed} onChange={(e) => setSeed(e.target.value)}>
            {branches.map((br) => (
              <option key={br.tenant_id} value={br.tenant_id}>
                {br.name}
              </option>
            ))}
            <option value="">Nothing — start empty</option>
          </select>
          <div className="field-hint">
            Never copied: orders, money, staff, credit customers, members. Stock starts at zero, every
            table free, printer addresses blank.
          </div>
        </div>
        <div className="field">
          <label>Contact phone</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={ref?.contact_phone ?? 'Required'}
            inputMode="tel"
            required={phoneRequired}
            aria-required={phoneRequired}
          />
          <div className="field-hint">
            {phoneRequired
              ? `${ref?.name ?? 'The source branch'} has no phone on file, so this one needs its own.`
              : `Leave blank to use ${ref?.name}'s number.`}
          </div>
        </div>
        <div className="field">
          <label>Plan</label>
          <select value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            <option value="">{ref?.plan_key ? `Same as ${ref.name} (${ref.plan_key})` : 'Trial (default)'}</option>
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Slug</label>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="Derived from the name" />
        </div>

        <button
          type="button"
          className="btn primary"
          disabled={!name.trim() || (phoneRequired && !phone.trim()) || addBranch.isPending}
          onClick={() =>
            addBranch.mutate(
              {
                name: name.trim(),
                slug: slug.trim() || undefined,
                phone: phone.trim() || undefined,
                plan_key: planKey || undefined,
                seed_from_tenant_id: seed || undefined,
              },
              {
                onSuccess: () => {
                  setName('');
                  setSlug('');
                  setPhone('');
                },
              },
            )
          }
        >
          <GitBranchPlus size={14} strokeWidth={1.6} />
          {addBranch.isPending ? 'Adding…' : 'Add branch'}
        </button>
      </div>
    </div>
  );
}
