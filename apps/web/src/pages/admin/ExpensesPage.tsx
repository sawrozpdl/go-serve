import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Tag, Boxes } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { ColorField } from '@/components/ColorField';
import { DatePicker } from '@/components/DatePicker';
import { formatNPR, parsePriceInput } from '@/components/Money';
import {
  useExpenseCategories,
  useCreateExpenseCategory,
  useDeleteExpenseCategory,
  useExpenses,
  useCreateExpense,
  useDeleteExpense,
  useMenuCategories,
  useInventoryItems,
  type Expense,
} from '@/lib/api';

export function ExpensesPage() {
  const list = useExpenses();
  const cats = useExpenseCategories();
  const del = useDeleteExpense();

  const [creating, setCreating] = useState(false);
  const [managingCats, setManagingCats] = useState(false);

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">money out</span>
          <h1>expenses.</h1>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setManagingCats(true)}>
            <Tag size={14} strokeWidth={1.5} /> Categories
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={(cats.data?.length ?? 0) === 0}
            title={(cats.data?.length ?? 0) === 0 ? 'Create a category first' : undefined}
            onClick={() => setCreating(true)}
          >
            <Plus size={14} strokeWidth={1.5} /> New expense
          </button>
        </div>
      </div>

      <div className="panel">
        {list.isPending && <div className="empty-state">loading…</div>}
        {list.data?.length === 0 && (
          <div className="empty-state">
            no expenses logged yet.
            <br />
            log purchases, salaries, utilities to power the profitability report.
          </div>
        )}
        {list.data && list.data.length > 0 && (
          <table className="t">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Category</th>
                <th>Linked inventory</th>
                <th>Method</th>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((e) => (
                <tr key={e.id}>
                  <td>
                    <strong>{e.vendor || '—'}</strong>
                    {e.notes && <div style={{ fontSize: 11, color: 'var(--ink-400)' }}>{e.notes}</div>}
                  </td>
                  <td>{e.expense_category_name ? <span className="pill">{e.expense_category_name}</span> : '—'}</td>
                  <td>
                    {e.linked_inventory_name ? (
                      <span className="pill ok">
                        <Boxes size={10} strokeWidth={1.5} /> {e.linked_inventory_name}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="sku">{e.payment_method}</td>
                  <td className="sku">
                    {new Date(e.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {formatNPR(e.amount_cents)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn icon danger"
                      onClick={() => {
                        if (confirm(`Delete expense to ${e.vendor || '(no vendor)'}?`)) del.mutate(e.id);
                      }}
                      aria-label="delete"
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ExpenseModal open={creating} onClose={() => setCreating(false)} />
      <CategoriesModal open={managingCats} onClose={() => setManagingCats(false)} />
    </>
  );
}

// -------------------------------------------------------------------------
// Categories management modal
// -------------------------------------------------------------------------

function CategoriesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useExpenseCategories();
  const create = useCreateExpenseCategory();
  const del = useDeleteExpenseCategory();
  const [name, setName] = useState('');
  const [color, setColor] = useState('');

  return (
    <Modal open={open} onClose={onClose} title="expense categories." subtitle="operating cost buckets">
      <div className="settle-payments" style={{ borderTop: 0, paddingTop: 0, marginTop: 0 }}>
        {list.data?.length === 0 && (
          <div className="empty-state">no categories yet. add Rent, Utilities, Salaries, Supplies…</div>
        )}
        {list.data?.map((c) => (
          <div key={c.id} className="settle-payments-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <span>
              {c.color && (
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    background: c.color,
                    marginRight: 8,
                    verticalAlign: 'middle',
                    borderRadius: 2,
                  }}
                />
              )}
              {c.name}
            </span>
            <button
              type="button"
              className="btn icon danger"
              onClick={() => {
                if (confirm(`Delete "${c.name}"?`)) del.mutate(c.id);
              }}
              aria-label="delete"
            >
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          </div>
        ))}
      </div>

      <form
        style={{ borderTop: '1px solid var(--ink-800)', paddingTop: 14, marginTop: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await create.mutateAsync({ name: name.trim(), color: color || undefined });
          setName('');
          setColor('');
        }}
      >
        <label>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rent, Utilities, Supplies…"
        />
        <label>Color</label>
        <ColorField value={color} onChange={setColor} allowEmpty />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Adding…' : 'Add category'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------
// Create expense modal
// -------------------------------------------------------------------------

type AllocRow = { menuCategoryId: string; sharePct: string };

function ExpenseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cats = useExpenseCategories();
  const menuCats = useMenuCategories();
  const inv = useInventoryItems();
  const create = useCreateExpense();

  const [expenseCatId, setExpenseCatId] = useState<string>('');
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [referenceNo, setReferenceNo] = useState('');
  const [paidAt, setPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [invId, setInvId] = useState('');
  const [delta, setDelta] = useState('');
  const [allocations, setAllocations] = useState<AllocRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const last = useRef(false);
  useEffect(() => {
    if (open !== last.current && open) {
      setExpenseCatId(cats.data?.[0]?.id ?? '');
      setVendor('');
      setAmount('');
      setPaymentMethod('cash');
      setReferenceNo('');
      setPaidAt(new Date().toISOString().slice(0, 10));
      setNotes('');
      setInvId('');
      setDelta('');
      setAllocations([]);
      setErr(null);
    }
    last.current = open;
  }, [open, cats.data]);

  const totalShare = allocations.reduce((sum, a) => sum + (parseFloat(a.sharePct) || 0), 0);

  return (
    <Modal open={open} onClose={onClose} title="new expense." subtitle="cost-center allocation">
      {err && <div className="banner-error">{err}</div>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const cents = parsePriceInput(amount);
          if (cents == null || cents <= 0) {
            setErr('amount required');
            return;
          }
          if (invId && !delta.trim()) {
            setErr('how many units did you buy? (delta_units)');
            return;
          }
          if (totalShare > 100.001) {
            setErr('allocation shares sum to more than 100%');
            return;
          }
          try {
            await create.mutateAsync({
              expense_category_id: expenseCatId || null,
              vendor,
              amount_cents: cents,
              paid_at: new Date(paidAt + 'T12:00:00Z').toISOString(),
              payment_method: paymentMethod,
              reference_no: referenceNo,
              notes,
              linked_inventory_item_id: invId || null,
              delta_units: invId ? delta : undefined,
              allocations: allocations
                .filter((a) => a.menuCategoryId && parseFloat(a.sharePct) > 0)
                .map((a) => ({ menu_category_id: a.menuCategoryId, share_pct: a.sharePct })),
            });
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <div className="row-inputs">
          <div>
            <label>Vendor</label>
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Local mill, NEA, …" />
          </div>
          <div>
            <label>Category</label>
            <select value={expenseCatId} onChange={(e) => setExpenseCatId(e.target.value)}>
              <option value="">— uncategorised —</option>
              {(cats.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row-inputs">
          <div>
            <label>Amount (NPR)</label>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              placeholder="5000"
            />
          </div>
          <div>
            <label>Paid at</label>
            <DatePicker value={paidAt} onChange={setPaidAt} max={new Date().toISOString().slice(0, 10)} />
          </div>
        </div>

        <div className="row-inputs">
          <div>
            <label>Method</label>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="cash">cash</option>
              <option value="esewa">eSewa</option>
              <option value="khalti">Khalti</option>
              <option value="card">card</option>
              <option value="bank">bank</option>
              <option value="other">other</option>
            </select>
          </div>
          <div>
            <label>Reference</label>
            <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="optional" />
          </div>
        </div>

        <label>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was this for?" />

        <details style={{ marginBottom: 14 }}>
          <summary
            style={{
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-300)',
              padding: '6px 0',
            }}
          >
            Inventory link (optional)
          </summary>
          <div style={{ paddingTop: 10 }}>
            <div className="row-inputs">
              <div>
                <label>Inventory item</label>
                <select value={invId} onChange={(e) => setInvId(e.target.value)}>
                  <option value="">— none (not a stock purchase) —</option>
                  {(inv.data ?? []).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.sale_unit})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Units bought</label>
                <input
                  value={delta}
                  onChange={(e) => setDelta(e.target.value)}
                  placeholder="200"
                  disabled={!invId}
                />
              </div>
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                color: 'var(--ink-400)',
              }}
            >
              creates a purchase movement; unit cost = amount ÷ units
            </div>
          </div>
        </details>

        <details open={allocations.length > 0}>
          <summary
            style={{
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-300)',
              padding: '6px 0',
            }}
          >
            Tag for profit reporting ({Math.round(totalShare * 1000) / 1000}% allocated)
          </summary>

          <div style={{ paddingTop: 10 }}>
            {allocations.map((a, i) => (
              <div
                key={i}
                className="row-inputs"
                style={{ gridTemplateColumns: '1fr 110px auto', alignItems: 'end', gap: 8, marginBottom: 4 }}
              >
                <div>
                  <label>Menu category</label>
                  <select
                    value={a.menuCategoryId}
                    onChange={(e) =>
                      setAllocations((arr) => arr.map((x, j) => (j === i ? { ...x, menuCategoryId: e.target.value } : x)))
                    }
                  >
                    <option value="">— pick one —</option>
                    {(menuCats.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Share %</label>
                  <input
                    inputMode="decimal"
                    value={a.sharePct}
                    onChange={(e) =>
                      setAllocations((arr) => arr.map((x, j) => (j === i ? { ...x, sharePct: e.target.value } : x)))
                    }
                  />
                </div>
                <button
                  type="button"
                  className="btn icon danger"
                  onClick={() => setAllocations((arr) => arr.filter((_, j) => j !== i))}
                  aria-label="remove"
                  style={{ marginBottom: 14 }}
                >
                  <Trash2 size={12} strokeWidth={1.5} />
                </button>
              </div>
            ))}
            <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setAllocations((arr) => [...arr, { menuCategoryId: '', sharePct: '' }])}
              >
                <Plus size={12} strokeWidth={1.5} /> Add allocation
              </button>
              {allocations.length === 0 && (menuCats.data?.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const first = menuCats.data?.[0];
                    if (first) setAllocations([{ menuCategoryId: first.id, sharePct: '100' }]);
                  }}
                >
                  100% to {menuCats.data?.[0]?.name ?? '…'}
                </button>
              )}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                color: 'var(--ink-400)',
                marginTop: 6,
              }}
            >
              unallocated remainder counts as overhead in the profitability report.
            </div>
          </div>
        </details>

        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Log expense'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// helper not used directly but exported to silence unused-import warnings would land here
export const _useExpense = (e: Expense) => e.id;
