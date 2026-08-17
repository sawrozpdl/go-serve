import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';

import { useAdminTenantDataSummary, useAdminDeleteTenant, type PurgeScope } from '@/lib/api';
import { useTenant } from '@/lib/tenant';

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
  { key: 'engage', label: 'QR rewards — campaigns, plays, codes and guest contacts' },
];

export function DangerDeletePanel({ id, slug, name }: { id: string; slug: string; name: string }) {
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

