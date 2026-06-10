import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';

import {
  useAdminPlans,
  useAdminFeatures,
  useAdminCreatePlan,
  useAdminUpdatePlan,
  useAdminDeletePlan,
  type AdminPlan,
  type PlanInput,
} from '@/lib/api';
import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';

const EMPTY: PlanInput = {
  key: '', name: '', member_limit: null, price_copy: '', is_enterprise: false, sort_order: 0, active: true, features: [],
};

export function SuperPlansPage() {
  const q = useAdminPlans();
  const features = useAdminFeatures();
  const create = useAdminCreatePlan();
  const confirm = useConfirm();
  const del = useAdminDeletePlan();

  const [editing, setEditing] = useState<AdminPlan | null>(null);
  const [creating, setCreating] = useState(false);

  const plans = q.data?.plans ?? [];
  const featureDefs = features.data?.features ?? [];

  const onDelete = async (p: AdminPlan) => {
    if (await confirm({ title: `Delete plan "${p.name}"?`, message: 'Blocked if any tenant is on this plan.', danger: true, confirmLabel: 'Delete' })) {
      del.mutate(p.id);
    }
  };

  return (
    <div className="super-page">
      <div className="super-page-head">
        <h1>Plans</h1>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} strokeWidth={1.8} style={{ marginRight: 6 }} /> New plan</button>
      </div>

      {(q.isError || del.isError) && <div className="banner-error">{q.error?.message ?? del.error?.message}</div>}

      <div className="table-scroll">
        <table className="t">
          <thead><tr><th>Plan</th><th>Seats</th><th>Price copy</th><th>Features</th><th>Active</th><th></th></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong> <span className="muted">{p.key}{p.is_enterprise ? ' · enterprise' : ''}</span></td>
                <td>{p.member_limit ?? '∞'}</td>
                <td>{p.price_copy || '—'}</td>
                <td>{p.features.length ? p.features.join(', ') : <span className="muted">base</span>}</td>
                <td>{p.active ? 'yes' : 'no'}</td>
                <td className="super-row-actions">
                  <button className="btn icon" title="Edit" onClick={() => setEditing(p)}><Pencil size={14} strokeWidth={1.7} /></button>
                  <button className="btn icon" title="Delete" onClick={() => onDelete(p)}><Trash2 size={14} strokeWidth={1.7} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <PlanModal
          title="New plan"
          initial={EMPTY}
          featureDefs={featureDefs}
          busy={create.isPending}
          error={create.error?.message}
          onClose={() => setCreating(false)}
          onSave={async (input) => { await create.mutateAsync(input); setCreating(false); }}
        />
      )}
      {editing && (
        <PlanModalEdit plan={editing} featureDefs={featureDefs} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function PlanModalEdit({ plan, featureDefs, onClose }: { plan: AdminPlan; featureDefs: { key: string; label: string }[]; onClose: () => void }) {
  const update = useAdminUpdatePlan(plan.id);
  return (
    <PlanModal
      title={`Edit ${plan.name}`}
      initial={{ ...plan }}
      lockKey
      featureDefs={featureDefs}
      busy={update.isPending}
      error={update.error?.message}
      onClose={onClose}
      onSave={async (input) => { await update.mutateAsync(input); onClose(); }}
    />
  );
}

function PlanModal({
  title, initial, featureDefs, busy, error, lockKey, onClose, onSave,
}: {
  title: string;
  initial: PlanInput;
  featureDefs: { key: string; label: string }[];
  busy: boolean;
  error?: string;
  lockKey?: boolean;
  onClose: () => void;
  onSave: (input: PlanInput) => Promise<void>;
}) {
  const [f, setF] = useState<PlanInput>(initial);
  const toggleFeature = (key: string) =>
    setF((s) => ({ ...s, features: s.features.includes(key) ? s.features.filter((k) => k !== key) : [...s.features, key] }));

  return (
    <Modal open title={title} onClose={onClose}>
      {error && <div className="banner-error">{error}</div>}
      <div className="field"><label>Key</label><input value={f.key} disabled={lockKey} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="e.g. growth" /></div>
      <div className="field"><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="field">
        <label>Member limit (blank = unlimited)</label>
        <input type="number" min={1} value={f.member_limit ?? ''} onChange={(e) => setF({ ...f, member_limit: e.target.value === '' ? null : Number(e.target.value) })} />
      </div>
      <div className="field"><label>Price copy</label><input value={f.price_copy} onChange={(e) => setF({ ...f, price_copy: e.target.value })} placeholder="e.g. Contact us" /></div>
      <div className="field"><label>Sort order</label><input type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: Number(e.target.value) || 0 })} /></div>
      <div className="field super-checks">
        <label className="super-check"><input type="checkbox" checked={f.is_enterprise} onChange={(e) => setF({ ...f, is_enterprise: e.target.checked })} /> Enterprise (contact-only)</label>
        <label className="super-check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      </div>
      <div className="field">
        <label>Premium features</label>
        <div className="super-checks">
          {featureDefs.map((fd) => (
            <label key={fd.key} className="super-check">
              <input type="checkbox" checked={f.features.includes(fd.key)} onChange={() => toggleFeature(fd.key)} /> {fd.label}
            </label>
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !f.key.trim() || !f.name.trim()} onClick={() => void onSave(f)}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}
