import { useState } from 'react';
import { Plus, Bookmark, Archive, RefreshCw, Trash2, X, Banknote, Smartphone, Receipt } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { EmptyState } from '@/components/EmptyState';
import { useConfirm } from '@/components/ConfirmDialog';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { toast } from '@/lib/toast';
import {
  useHouseTabs,
  useHouseTab,
  useCreateHouseTab,
  useUpdateHouseTab,
  useDeleteHouseTab,
  useCreateHouseTabSettlement,
  type HouseTab,
  type PaymentMethod,
} from '@/lib/api';

// =========================================================================
// Stakeholder Tabs page.
//
// Each tab is a named running ledger ("Owner A", "Staff meals", "Supplier
// loan"). When an order is closed and charged to a house tab, the tab
// accumulates a balance. Settling the tab = paying it down via cash/online.
// =========================================================================

export function HouseTabsPage() {
  const tabs = useHouseTabs();
  const create = useCreateHouseTab();
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = tabs.data ?? [];
  const totalOwed = list.reduce((sum, t) => sum + Math.max(0, t.balance_cents), 0);
  const activeTabs = list.filter((t) => t.is_active);
  const archivedTabs = list.filter((t) => !t.is_active);

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">running ledgers</span>
          <h1>tabs.</h1>
        </div>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => setShowNew(true)}>
            <Plus size={14} strokeWidth={1.5} /> New tab
          </button>
        </div>
      </div>

      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="label">Outstanding (all tabs)</div>
          <div
            className="value"
            style={{ color: totalOwed > 0 ? 'var(--amber-500)' : 'var(--ink-300)' }}
          >
            {formatNPR(totalOwed)}
          </div>
          <div className="delta">money owed to the cafe</div>
        </div>
        <div className="kpi">
          <div className="label">Active tabs</div>
          <div className="value">{activeTabs.length}</div>
        </div>
        <div className="kpi">
          <div className="label">Archived</div>
          <div className="value" style={{ color: 'var(--ink-400)' }}>
            {archivedTabs.length}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>tabs</h3>
          <span className="meta">click a tab to view its ledger or settle</span>
        </div>

        {tabs.isPending && <div className="empty-state">loading…</div>}
        {tabs.data && list.length === 0 && (
          <EmptyState
            icon={<Bookmark size={28} strokeWidth={1.4} style={{ color: 'var(--amber-500)' }} />}
            title="no tabs yet"
            hint="add a tab for each stakeholder you want to track separately — e.g. an owner, a regular running on credit, or a staff-meals bucket. close orders to a tab and settle them at month-end."
          />
        )}

        {list.length > 0 && (
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ textAlign: 'right' }}>Charged</th>
                <th style={{ textAlign: 'right' }}>Settled</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
                <th style={{ width: 90 }}>Status</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setOpenId(t.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <strong>{t.name}</strong>
                    {t.notes && (
                      <div style={{ fontSize: 11, color: 'var(--ink-400)', marginTop: 2 }}>
                        {t.notes}
                      </div>
                    )}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {formatNPR(t.charged_cents)}
                  </td>
                  <td
                    className="num"
                    style={{ textAlign: 'right', color: 'var(--lime-500)' }}
                  >
                    {formatNPR(t.settled_cents)}
                  </td>
                  <td
                    className="num"
                    style={{
                      textAlign: 'right',
                      fontWeight: 600,
                      color: t.balance_cents > 0 ? 'var(--amber-500)' : 'var(--ink-300)',
                    }}
                  >
                    {formatNPR(t.balance_cents)}
                  </td>
                  <td>
                    <span className={`pill ${t.is_active ? 'ok' : ''}`}>
                      {t.is_active ? 'active' : 'archived'}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="btn icon"
                        onClick={() => setOpenId(t.id)}
                        aria-label="open"
                      >
                        <Receipt size={14} strokeWidth={1.5} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <NewTabModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onSubmit={async (values) => {
          try {
            await create.mutateAsync(values);
            toast.success('Tab created', values.name);
            setShowNew(false);
          } catch (e: unknown) {
            toast.error('Could not create', (e as { message?: string }).message);
          }
        }}
        pending={create.isPending}
      />

      {openId && <DetailModal id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

// -------------------------------------------------------------------------
// New tab modal
// -------------------------------------------------------------------------

function NewTabModal({
  open,
  onClose,
  onSubmit,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (v: { name: string; notes: string }) => Promise<void>;
  pending: boolean;
}) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  return (
    <Modal
      open={open}
      onClose={() => {
        setName('');
        setNotes('');
        onClose();
      }}
      title="new house tab"
      subtitle="running ledger for a stakeholder"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await onSubmit({ name: name.trim(), notes: notes.trim() });
          setName('');
          setNotes('');
        }}
      >
        <label>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Owner A, Staff meals, Supplier loan"
          required
          autoFocus
        />

        <label>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="optional — terms, settlement cadence, contact, etc."
        />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending || !name.trim()}>
            {pending ? 'Creating…' : 'Create tab'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------
// Detail modal — shows ledger + settlement form + edit/archive controls.
// -------------------------------------------------------------------------

type DetailMethod = 'cash' | 'online';

function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useHouseTab(id);
  const update = useUpdateHouseTab();
  const del = useDeleteHouseTab();
  const settle = useCreateHouseTabSettlement();
  const confirm = useConfirm();

  const [method, setMethod] = useState<DetailMethod>('cash');
  const [amountStr, setAmountStr] = useState('');
  const [refNo, setRefNo] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const t = detail.data?.house_tab;
  const balance = t?.balance_cents ?? 0;
  const suggestStr = balance > 0 ? (balance / 100).toString() : '';

  const onSettle = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const cents = parsePriceInput(amountStr) ?? 0;
    if (cents <= 0) {
      setErr('amount required');
      return;
    }
    if (cents > balance) {
      setErr(
        `amount exceeds outstanding balance of ${formatNPR(balance)} — enter ${formatNPR(balance)} or less`,
      );
      return;
    }
    try {
      await settle.mutateAsync({
        id,
        amount_cents: cents,
        payment_method: method === 'cash' ? 'cash' : ('online' as PaymentMethod | 'online'),
        reference_no: refNo.trim(),
        notes: notes.trim(),
      });
      setAmountStr('');
      setRefNo('');
      setNotes('');
      toast.success('Settlement recorded', formatNPR(cents));
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t?.name ?? 'tab'}
      subtitle={t?.is_active ? 'running ledger' : 'archived'}
    >
      {!detail.data && <div className="empty-state">loading…</div>}
      {detail.data && t && (
        <>
          <div className="settle-totals">
            <div className="settle-row">
              <span>charged (orders posted to this tab)</span>
              <span className="num">{formatNPR(t.charged_cents)}</span>
            </div>
            <div className="settle-row">
              <span>settled (paid down)</span>
              <span className="num" style={{ color: 'var(--lime-500)' }}>
                −{formatNPR(t.settled_cents)}
              </span>
            </div>
            <hr className="settle-rule" />
            <div className="settle-row bold">
              <span>balance owed</span>
              <span
                className="num"
                style={{
                  color: balance > 0 ? 'var(--amber-500)' : 'var(--ink-300)',
                }}
              >
                {formatNPR(balance)}
              </span>
            </div>
          </div>

          {t.notes && (
            <div className="banner-info" style={{ marginTop: 14 }}>
              {t.notes}
            </div>
          )}

          {/* Settle form */}
          {balance > 0 && t.is_active && (
            <form onSubmit={onSettle} className="settle-form" style={{ marginTop: 14 }}>
              <label>Record settlement</label>
              <div className="method-grid">
                <button
                  type="button"
                  className={`chip ${method === 'cash' ? 'active' : ''}`}
                  onClick={() => setMethod('cash')}
                >
                  <Banknote size={14} strokeWidth={1.5} /> Cash
                </button>
                <button
                  type="button"
                  className={`chip ${method === 'online' ? 'active' : ''}`}
                  onClick={() => setMethod('online')}
                >
                  <Smartphone size={14} strokeWidth={1.5} /> Online
                </button>
              </div>

              <div className="row-inputs">
                <div>
                  <label>Amount (NPR)</label>
                  <input
                    inputMode="decimal"
                    placeholder={suggestStr || '0'}
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value)}
                  />
                  <div className="field-hint">remaining: {formatNPR(balance)}</div>
                </div>
                {method === 'online' && (
                  <div>
                    <label>Txn reference</label>
                    <input
                      value={refNo}
                      onChange={(e) => setRefNo(e.target.value)}
                      placeholder="eSewa / Khalti id"
                    />
                  </div>
                )}
              </div>
              <label>Notes</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="optional"
              />

              {err && <div className="banner-error">{err}</div>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => suggestStr && setAmountStr(suggestStr)}
                  disabled={!suggestStr}
                >
                  Auto-fill {suggestStr && `(${formatNPR(balance)})`}
                </button>
                <button type="submit" className="btn primary" disabled={settle.isPending}>
                  {settle.isPending ? 'Recording…' : 'Record settlement'}
                </button>
              </div>
            </form>
          )}

          {balance === 0 && t.is_active && (
            <div className="banner-info" style={{ marginTop: 14 }}>
              tab is fully settled. archive it if it's no longer in use, or leave it open
              for the next charge.
            </div>
          )}

          {/* Ledger */}
          <Section title={`charges (${detail.data.charges.length})`}>
            {detail.data.charges.length === 0 && (
              <div className="kds-empty">no orders charged to this tab yet.</div>
            )}
            {detail.data.charges.map((c) => (
              <div key={c.payment_id} className="exp" style={{ padding: '10px 0' }}>
                <div className="left">
                  <span className="name">{c.service_table_name ?? 'take-away'}</span>
                  <span className="meta">
                    {new Date(c.recorded_at).toLocaleString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <span className="amt" style={{ color: 'var(--amber-500)' }}>
                  +{formatNPR(c.amount_cents)}
                </span>
              </div>
            ))}
          </Section>
          <Section title={`settlements (${detail.data.settlements.length})`}>
            {detail.data.settlements.length === 0 && (
              <div className="kds-empty">no settlements yet.</div>
            )}
            {detail.data.settlements.map((s) => (
              <div key={s.id} className="exp" style={{ padding: '10px 0' }}>
                <div className="left">
                  <span className="name">
                    {s.payment_method === 'cash' ? 'cash' : 'online'}
                    {s.reference_no && ` · ${s.reference_no}`}
                  </span>
                  <span className="meta">
                    {new Date(s.recorded_at).toLocaleString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {s.notes && ` · ${s.notes}`}
                  </span>
                </div>
                <span className="amt" style={{ color: 'var(--lime-500)' }}>
                  −{formatNPR(s.amount_cents)}
                </span>
              </div>
            ))}
          </Section>

          {/* Footer actions */}
          <div
            className="modal-actions"
            style={{ marginTop: 14, borderTop: '1px solid var(--ink-800)', paddingTop: 14 }}
          >
            {t.is_active ? (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  try {
                    await update.mutateAsync({ id, patch: { is_active: false } });
                    toast.info('Tab archived');
                  } catch (e: unknown) {
                    toast.error('Could not archive', (e as { message?: string }).message);
                  }
                }}
                disabled={update.isPending}
              >
                <Archive size={14} strokeWidth={1.5} /> Archive
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  try {
                    await update.mutateAsync({ id, patch: { is_active: true } });
                    toast.info('Tab reactivated');
                  } catch (e: unknown) {
                    toast.error('Could not reactivate', (e as { message?: string }).message);
                  }
                }}
                disabled={update.isPending}
              >
                <RefreshCw size={14} strokeWidth={1.5} /> Reactivate
              </button>
            )}
            <button
              type="button"
              className="btn danger"
              disabled={balance !== 0 || del.isPending}
              title={balance !== 0 ? 'settle the balance first' : undefined}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Delete tab?',
                  message: (
                    <>
                      Permanently remove the <strong>{t.name}</strong> house tab.
                      Only allowed when the balance is zero.
                    </>
                  ),
                  confirmLabel: 'Delete tab',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await del.mutateAsync(id);
                  toast.info('Tab deleted');
                  onClose();
                } catch (e: unknown) {
                  toast.error('Could not delete', (e as { message?: string }).message);
                }
              }}
            >
              <Trash2 size={14} strokeWidth={1.5} /> Delete
            </button>
            <button type="button" className="btn primary" onClick={onClose}>
              <X size={14} strokeWidth={1.5} /> Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 14 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-400)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

export type { HouseTab };
