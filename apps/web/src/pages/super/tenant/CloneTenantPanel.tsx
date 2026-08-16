import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, FlaskConical } from 'lucide-react';

import { useAdminCloneTenant, useAdminTenantDataSummary } from '@/lib/api';
import { toast } from '@/lib/toast';

/**
 * Clone this café into a QA sandbox.
 *
 * Not destructive, but it produces a full copy of a real café's books —
 * customer names on credit accounts, staff records, every order — so it uses the
 * same typed-confirmation gate as the purge panel. Typing the slug is how the
 * operator says out loud which café they are copying.
 */
export function CloneTenantPanel({
  id,
  slug,
  name,
  clonedFrom,
}: {
  id: string;
  slug: string;
  name: string;
  /** Set when THIS workspace is itself a clone — cloning a clone is refused. */
  clonedFrom?: string | null;
}) {
  const navigate = useNavigate();
  const summary = useAdminTenantDataSummary(id);
  const clone = useAdminCloneTenant(id);

  const [confirmText, setConfirmText] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [cloneSlug, setCloneSlug] = useState('');

  const counts = summary.data?.counts;
  const totalRows = Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
  const isClone = !!clonedFrom;
  const canSubmit = !isClone && confirmText.trim() === slug && !clone.isPending;

  if (isClone) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h3>
            <FlaskConical size={14} strokeWidth={1.6} /> Clone for QA
          </h3>
        </div>
        <p className="field-hint">
          This workspace is itself a clone. Clone the original café instead — cloning a clone
          compounds any drift between it and production.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          <FlaskConical size={14} strokeWidth={1.6} /> Clone for QA
        </h3>
      </div>

      <p className="field-hint">
        Copies <strong>{name}</strong> into a brand-new workspace: the same menu, tables, staff,
        orders, payments and balances, with every id renumbered so the two never share a row. Use it
        to reproduce a bug against real data instead of a hand-built approximation.
      </p>

      <div className="field-hint" style={{ marginTop: 8 }}>
        About <strong>{totalRows.toLocaleString()}</strong> rows will be copied. Not copied:
        sessions, pending invites, activity logs and bug reports — a clone must not hand out working
        logins or accept an invite meant for the real café. The clone is marked as one and comped, so
        it never appears as a paying or past-due workspace.
      </div>

      {/* .field wrappers so labels stack above their inputs, matching every
          other panel in the console. */}
      <div className="field" style={{ marginTop: 12 }}>
        <label>Name</label>
        <input
          value={cloneName}
          onChange={(e) => setCloneName(e.target.value)}
          placeholder={`${name} (QA clone)`}
        />
      </div>

      <div className="field">
        <label>Slug</label>
        <input
          value={cloneSlug}
          onChange={(e) => setCloneSlug(e.target.value)}
          placeholder={`qa-${slug}`}
        />
        <div className="field-hint">
          Left blank, both are derived from the source. A taken slug gets a suffix rather than
          failing.
        </div>
      </div>

      <div className="field">
        <label>
          Type <strong>{slug}</strong> to confirm you are copying this café
        </label>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={slug}
          autoComplete="off"
        />
      </div>

      <button
        type="button"
        className="btn primary"
        style={{ marginTop: 12 }}
        disabled={!canSubmit}
        onClick={() =>
          clone.mutate(
            {
              confirm_slug: slug,
              name: cloneName.trim() || undefined,
              slug: cloneSlug.trim() || undefined,
            },
            {
              onSuccess: (res) => {
                toast.success(
                  `Cloned to ${res.slug}`,
                  `${res.rows.toLocaleString()} rows copied`,
                );
                navigate(`/super/tenants/${res.id}`);
              },
              onError: (e) => toast.error('Could not clone', e.message),
            },
          )
        }
      >
        <Copy size={14} strokeWidth={1.6} />
        {clone.isPending ? 'Cloning…' : 'Clone this café'}
      </button>
    </div>
  );
}
