import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Tag, Boxes } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { ColorField } from '@/components/ColorField';
import { DatePicker } from '@/components/DatePicker';
import { useConfirm } from '@/components/ConfirmDialog';
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
  useCurrentShift,
  type Expense,
} from '@/lib/api';

export function ExpensesPage() {
  const list = useExpenses();
  const cats = useExpenseCategories();
  const del = useDeleteExpense();
  const confirm = useConfirm();

  const [creating, setCreating] = useState(false);
  const [managingCats, setManagingCats] = useState(false);

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">money out</span>
          <h1>Expenses</h1>
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
                  <td className="sku">
                    {e.payment_method}
                    {e.paid_from_drawer && (
                      <span className="pill warn" style={{ marginLeft: 6, fontSize: 9 }}>
                        drawer
                      </span>
                    )}
                  </td>
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
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Delete expense?',
                          message: (
                            <>
                              This will permanently remove the expense
                              {e.vendor ? <> to <strong>{e.vendor}</strong></> : null}{' '}
                              of <strong>{formatNPR(e.amount_cents)}</strong>.
                              {e.paid_from_drawer ? (
                                <>
                                  {'\n\n'}It was paid from the drawer — deleting
                                  also removes the matching drawer movement.
                                </>
                              ) : null}
                            </>
                          ),
                          confirmLabel: 'Delete expense',
                          danger: true,
                        });
                        if (ok) del.mutate(e.id);
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
  const confirm = useConfirm();
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
              onClick={async () => {
                const ok = await confirm({
                  title: 'Delete category?',
                  message: (
                    <>
                      Delete the <strong>{c.name}</strong> category? Existing
                      expenses tagged with it will become uncategorised.
                    </>
                  ),
                  danger: true,
                });
                if (ok) del.mutate(c.id);
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

function nowLocalHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ExpenseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cats = useExpenseCategories();
  const menuCats = useMenuCategories();
  const inv = useInventoryItems();
  const currentShift = useCurrentShift();
  const create = useCreateExpense();

  const [expenseCatId, setExpenseCatId] = useState<string>('');
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [referenceNo, setReferenceNo] = useState('');
  const [paidAt, setPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [paidTime, setPaidTime] = useState(() => nowLocalHHMM());
  const [notes, setNotes] = useState('');
  const [invId, setInvId] = useState('');
  const [delta, setDelta] = useState('');
  const [paidFromDrawer, setPaidFromDrawer] = useState(true);
  const [allocations, setAllocations] = useState<AllocRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Tracks whether the user has manually toggled the drawer checkbox in this
  // session — once they do, we stop auto-flipping it on shift-data arrival.
  const userTouchedDrawer = useRef(false);

  const shiftIsOpen = !!currentShift.data && !currentShift.data.closed_at;
  const drawerEligible = paymentMethod === 'cash' && shiftIsOpen;

  const last = useRef(false);
  useEffect(() => {
    if (open !== last.current && open) {
      setExpenseCatId(cats.data?.[0]?.id ?? '');
      setVendor('');
      setAmount('');
      setPaymentMethod('cash');
      setReferenceNo('');
      setPaidAt(new Date().toISOString().slice(0, 10));
      setPaidTime(nowLocalHHMM());
      setNotes('');
      setInvId('');
      setDelta('');
      setPaidFromDrawer(drawerEligible);
      userTouchedDrawer.current = false;
      setAllocations([]);
      setErr(null);
    }
    last.current = open;
    // Intentionally NOT depending on drawerEligible — that's handled by the
    // follow-up effect below so a late-arriving currentShift query doesn't
    // wipe the rest of the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cats.data]);

  // If currentShift loads (or the user switches back to cash) AFTER the modal
  // opened, default the drawer checkbox to on — but only until the user
  // touches it themselves.
  useEffect(() => {
    if (open && drawerEligible && !userTouchedDrawer.current) {
      setPaidFromDrawer(true);
    }
  }, [open, drawerEligible]);

  // Auto-clear paid_from_drawer if the user switches to a non-cash method or
  // there's no open shift — keeps the form internally consistent.
  useEffect(() => {
    if (!drawerEligible && paidFromDrawer) setPaidFromDrawer(false);
  }, [drawerEligible, paidFromDrawer]);

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
              paid_at: new Date(`${paidAt}T${paidTime}:00`).toISOString(),
              payment_method: paymentMethod,
              reference_no: referenceNo,
              notes,
              linked_inventory_item_id: invId || null,
              delta_units: invId ? delta : undefined,
              paid_from_drawer: paidFromDrawer,
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
        </div>

        <div>
          <label>Paid at</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 8 }}>
            <DatePicker value={paidAt} onChange={setPaidAt} max={new Date().toISOString().slice(0, 10)} />
            <input
              type="time"
              value={paidTime}
              onChange={(e) => setPaidTime(e.target.value)}
              step={60}
            />
          </div>
        </div>

        <div>
          <label>Reference</label>
          <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="optional" />
        </div>

        {/* Drawer linkage: only meaningful when the cashier paid in cash AND
         * there is an open shift. Reconciles close-shift variance so a
         * 100rs grocery run from the till stops showing as 'short'. */}
        {paymentMethod === 'cash' && (
          <div className="drawer-toggle">
            <label
              className="drawer-toggle-row"
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                padding: '10px 12px',
                marginBottom: 14,
                background: shiftIsOpen ? 'rgba(163, 240, 44, 0.06)' : 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--ink-800)',
                borderRadius: 6,
                cursor: shiftIsOpen ? 'pointer' : 'not-allowed',
                opacity: shiftIsOpen ? 1 : 0.6,
                fontSize: 12,
                letterSpacing: 0,
                textTransform: 'none',
                fontFamily: 'var(--font-sans)',
                color: 'var(--ink-100)',
              }}
            >
              <input
                type="checkbox"
                checked={paidFromDrawer}
                disabled={!shiftIsOpen}
                onChange={(e) => {
                  userTouchedDrawer.current = true;
                  setPaidFromDrawer(e.target.checked);
                }}
                style={{ marginTop: 2 }}
              />
              <span style={{ flex: 1 }}>
                <strong style={{ color: 'var(--ink-50)', fontWeight: 500 }}>
                  Paid from cash drawer
                </strong>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    letterSpacing: '0.06em',
                    color: 'var(--ink-400)',
                    marginTop: 4,
                  }}
                >
                  {shiftIsOpen
                    ? 'Defaults on for cash + open shift. Uncheck only if you paid from your own pocket.'
                    : 'No shift open. Open a shift in Operations → Shift to use this.'}
                </div>
                {shiftIsOpen && !paidFromDrawer && (
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      letterSpacing: '0.06em',
                      color: 'var(--amber-500)',
                      marginTop: 6,
                    }}
                  >
                    If you took this cash from the till, leaving this off will show as a shortfall at close-shift.
                  </div>
                )}
              </span>
            </label>
          </div>
        )}

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
