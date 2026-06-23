import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Trash2,
  Tag,
  Boxes,
  Banknote,
  Wallet,
  Crown,
  AlertTriangle,
  Pencil,
  Info,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

import { todayIso, addDaysIso } from '@/lib/dates';
import { Modal } from '@/components/Modal';
import { PageShell } from '@/components/PageShell';
import { ColorField } from '@/components/ColorField';
import { DatePicker } from '@/components/DatePicker';
import { TimePicker } from '@/components/TimePicker';
import { SearchInput } from '@/components/SearchInput';
import { useConfirm } from '@/components/ConfirmDialog';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { formatNPR, parsePriceInput } from '@/components/Money';
import {
  useExpenseCategories,
  useCreateExpenseCategory,
  useDeleteExpenseCategory,
  useExpenses,
  useExpense,
  useExpenseVendors,
  useCreateExpense,
  useUpdateExpense,
  useDeleteExpense,
  useMenuCategories,
  useInventoryItems,
  useCurrentShift,
  useCafeBalance,
  useCafeOwners,
  type Expense,
  type ExpensePaidFrom,
} from '@/lib/api';
import { usePermissions } from '@/lib/permissions';


export function ExpensesPage() {
  // Filters — search is debounced so the request fires on typing pauses,
  // everything else hits the server immediately (lists are ≤200 rows).
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [paidFromFilter, setPaidFromFilter] = useState<'' | ExpensePaidFrom>('');
  // Default to today so the page opens on "what did I spend today" instead of
  // an undifferentiated all-time list.
  const [fromDate, setFromDate] = useState(() => todayIso());
  const [toDate, setToDate] = useState(() => todayIso());
  useEffect(() => {
    const t = window.setTimeout(() => setQ(search), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  // A single calendar day is the common case; the From/To pickers can still
  // open a wider range for power users.
  const today = todayIso();
  const singleDay = !!fromDate && fromDate === toDate;
  const refDay = toDate || fromDate || today;
  // Filters count as "active" when anything departs from the default (today,
  // no text/category/source filter) — that drives the Clear button + empty copy.
  const filtersActive = !!(
    q ||
    catFilter ||
    paidFromFilter ||
    !singleDay ||
    fromDate !== today
  );

  const stepDay = (delta: number) => {
    const next = addDaysIso(singleDay ? fromDate : refDay, delta);
    setFromDate(next);
    setToDate(next);
  };
  const goToday = () => {
    setFromDate(today);
    setToDate(today);
  };

  const list = useExpenses({
    q: q || undefined,
    expense_category_id: catFilter || undefined,
    paid_from: paidFromFilter || undefined,
    from: fromDate || undefined,
    // paid_at is a timestamp — stretch the "to" day to its end so the
    // boundary day's expenses are included.
    to: toDate ? `${toDate}T23:59:59` : undefined,
  });
  const cats = useExpenseCategories();
  const del = useDeleteExpense();
  const confirm = useConfirm();
  const { can, canAny } = usePermissions();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [managingCats, setManagingCats] = useState(false);

  // Period label for the day stepper + summary.
  const dayLabel = singleDay
    ? fromDate === today
      ? 'Today'
      : fromDate === addDaysIso(today, -1)
        ? 'Yesterday'
        : new Date(`${fromDate}T00:00:00`).toLocaleDateString('en-GB', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          })
    : fromDate && toDate
      ? `${fromDate} → ${toDate}`
      : fromDate
        ? `From ${fromDate}`
        : toDate
          ? `Until ${toDate}`
          : 'All dates';

  // Running total + count for whatever the filters currently match.
  const total = useMemo(
    () => (list.data ?? []).reduce((s, e) => s + e.amount_cents, 0),
    [list.data],
  );
  const count = list.data?.length ?? 0;

  const clearFilters = () => {
    setSearch('');
    setQ('');
    setCatFilter('');
    setPaidFromFilter('');
    setFromDate(today);
    setToDate(today);
  };

  return (
    <PageShell
      eyebrow="Money out"
      title="Expenses"
      actions={
        <>
          {canAny('expense:create', 'expense:delete') && (
            <button type="button" className="btn" onClick={() => setManagingCats(true)}>
              <Tag size={14} strokeWidth={1.5} /> Categories
            </button>
          )}
          {can('expense:create') && (
            <button
              type="button"
              className="btn primary"
              disabled={(cats.data?.length ?? 0) === 0}
              title={(cats.data?.length ?? 0) === 0 ? 'Create a category first' : undefined}
              onClick={() => setCreating(true)}
            >
              <Plus size={14} strokeWidth={1.5} /> New expense
            </button>
          )}
        </>
      }
    >
      <div className="expenses-daybar">
        <div className="day-stepper">
          <button
            type="button"
            className="btn icon"
            aria-label="Previous day"
            onClick={() => stepDay(-1)}
          >
            <ChevronLeft size={15} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className={`btn day-stepper-label ${!(singleDay && fromDate === today) ? 'active' : ''}`}
            onClick={goToday}
            title="Jump to today"
          >
            {dayLabel}
          </button>
          <button
            type="button"
            className="btn icon"
            aria-label="Next day"
            disabled={refDay >= today}
            onClick={() => stepDay(1)}
          >
            <ChevronRight size={15} strokeWidth={1.6} />
          </button>
        </div>
        <div className="expenses-summary">
          <span className="num">{count}</span>{' '}
          <span className="lbl">{count === 1 ? 'expense' : 'expenses'}</span>
          <span className="sep">·</span>
          <span className="num">{formatNPR(total)}</span>
        </div>
      </div>

      <div className="history-filters">
        <SearchInput
          value={search}
          onChange={setSearch}
          compact
          placeholder="Vendor, notes, reference…"
          ariaLabel="Search expenses"
          minWidth={200}
        />
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          aria-label="Filter by category"
          style={{ width: 'auto', marginBottom: 0 }}
        >
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={paidFromFilter}
          onChange={(e) => setPaidFromFilter(e.target.value as '' | ExpensePaidFrom)}
          aria-label="Filter by payment source"
          style={{ width: 'auto', marginBottom: 0 }}
        >
          <option value="">Any source</option>
          <option value="drawer">Drawer</option>
          <option value="bank">Bank</option>
          <option value="owner">Owner</option>
        </select>
        <div className="filter-daterange">
          <label className="fdr-field">
            <span>From</span>
            <DatePicker value={fromDate} onChange={setFromDate} placeholder="From" />
          </label>
          <label className="fdr-field">
            <span>To</span>
            <DatePicker value={toDate} onChange={setToDate} placeholder="To" />
          </label>
        </div>
        {filtersActive && (
          <button type="button" className="btn" onClick={clearFilters}>
            Clear
          </button>
        )}
      </div>

      <div className="panel">
        {list.isPending && <LoadingState />}
        {list.isError && !list.data && <ErrorState onRetry={() => list.refetch()} />}
        {list.data?.length === 0 &&
          (filtersActive ? (
            <div className="empty-state">
              No expenses match these filters.
              <br />
              <button type="button" className="btn" style={{ marginTop: 10 }} onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="empty-state">
              No expenses logged for {dayLabel.toLowerCase()}.
              <br />
              Step to another day with the arrows, or log a purchase with “New expense”.
            </div>
          ))}
        {list.data && list.data.length > 0 && (
          <table className="t">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Category</th>
                <th>Linked inventory</th>
                <th>Paid from</th>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ width: 92 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((e) => (
                <tr key={e.id}>
                  <td>
                    <strong>{e.vendor || '—'}</strong>
                    {e.notes && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-400)' }}>{e.notes}</div>}
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
                    {e.paid_from === 'drawer' && (
                      <span className="pill warn" style={{ fontSize: 9 }}>
                        <Banknote size={10} strokeWidth={1.5} /> Drawer
                      </span>
                    )}
                    {e.paid_from === 'bank' && (
                      <span className="pill" style={{ fontSize: 9 }}>
                        <Wallet size={10} strokeWidth={1.5} /> Bank
                      </span>
                    )}
                    {e.paid_from === 'owner' && (
                      <span className="pill warn" style={{ fontSize: 9 }}>
                        <Crown size={10} strokeWidth={1.5} /> {e.owner_name ?? 'Owner'} loan
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
                    {can('expense:update') && (
                      <button
                        type="button"
                        className="btn icon"
                        onClick={() => setEditing(e)}
                        aria-label="edit"
                        title="Edit expense"
                      >
                        <Pencil size={14} strokeWidth={1.5} />
                      </button>
                    )}
                    {can('expense:delete') && (
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
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ExpenseModal open={creating} onClose={() => setCreating(false)} />
      <ExpenseModal open={editing !== null} editing={editing} onClose={() => setEditing(null)} />
      <CategoriesModal open={managingCats} onClose={() => setManagingCats(false)} />
    </PageShell>
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
  const { can } = usePermissions();
  const [name, setName] = useState('');
  const [color, setColor] = useState('');

  return (
    <Modal open={open} onClose={onClose} title="Expense Categories" subtitle="Operating cost buckets">
      <div className="settle-payments" style={{ borderTop: 0, paddingTop: 0, marginTop: 0 }}>
        {list.isPending && <LoadingState compact />}
        {list.isError && !list.data && <ErrorState compact onRetry={() => list.refetch()} />}
        {list.data?.length === 0 && (
          <div className="empty-state">No categories yet. Add Rent, Utilities, Salaries, Supplies…</div>
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
                    marginRight: 'var(--space-2)',
                    verticalAlign: 'middle',
                    borderRadius: 2,
                  }}
                />
              )}
              {c.name}
            </span>
            {can('expense:delete') && (
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
            )}
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
        {can('expense:create') && (
          <>
            <div className="field">
              <label>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Rent, Utilities, Supplies…"
              />
            </div>
            <div className="field">
              <label>Color</label>
              <ColorField value={color} onChange={setColor} allowEmpty />
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
          {can('expense:create') && (
            <button type="submit" className="btn primary" disabled={!name.trim() || create.isPending}>
              {create.isPending ? 'Adding…' : 'Add category'}
            </button>
          )}
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

function ExpenseModal({
  open,
  onClose,
  editing = null,
}: {
  open: boolean;
  onClose: () => void;
  /** When set, the modal edits this expense instead of creating one. */
  editing?: Expense | null;
}) {
  const cats = useExpenseCategories();
  const menuCats = useMenuCategories();
  const inv = useInventoryItems();
  const currentShift = useCurrentShift();
  const owners = useCafeOwners({ activeOnly: true });
  const balance = useCafeBalance();
  const vendors = useExpenseVendors();
  const create = useCreateExpense();
  const update = useUpdateExpense();
  // The list row doesn't carry allocations — fetch the detail when editing.
  const detail = useExpense(editing?.id);
  const isEdit = editing !== null;

  const [expenseCatId, setExpenseCatId] = useState<string>('');
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [paidAt, setPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [paidTime, setPaidTime] = useState(() => nowLocalHHMM());
  const [notes, setNotes] = useState('');
  const [invId, setInvId] = useState('');
  const [delta, setDelta] = useState('');
  // The new 0014 model: where the money came from.
  const [paidFrom, setPaidFrom] = useState<ExpensePaidFrom>('drawer');
  const [ownerId, setOwnerId] = useState<string>('');
  const [allocations, setAllocations] = useState<AllocRow[]>([]);
  // Only send allocations on edit once the detail loaded them — submitting
  // before that would silently wipe the stored split.
  const allocsHydrated = useRef(false);
  const [err, setErr] = useState<string | null>(null);

  const shiftIsOpen = !!currentShift.data && !currentShift.data.closed_at;
  const amountCents = parsePriceInput(amount) ?? 0;

  const last = useRef(false);
  useEffect(() => {
    if (open !== last.current && open) {
      if (editing) {
        const paid = new Date(editing.paid_at);
        setExpenseCatId(editing.expense_category_id ?? '');
        setVendor(editing.vendor);
        setAmount((editing.amount_cents / 100).toString());
        setReferenceNo(editing.reference_no);
        setPaidAt(
          `${paid.getFullYear()}-${String(paid.getMonth() + 1).padStart(2, '0')}-${String(paid.getDate()).padStart(2, '0')}`,
        );
        setPaidTime(
          `${String(paid.getHours()).padStart(2, '0')}:${String(paid.getMinutes()).padStart(2, '0')}`,
        );
        setNotes(editing.notes);
        setInvId(editing.linked_inventory_item_id ?? '');
        setDelta('');
        setPaidFrom(editing.paid_from);
        setOwnerId(editing.owner_id ?? '');
        setAllocations([]);
        allocsHydrated.current = false;
      } else {
        setExpenseCatId(cats.data?.[0]?.id ?? '');
        setVendor('');
        setAmount('');
        setReferenceNo('');
        setPaidAt(new Date().toISOString().slice(0, 10));
        setPaidTime(nowLocalHHMM());
        setNotes('');
        setInvId('');
        setDelta('');
        // Default: drawer if shift is open (covers the common "till-paid groceries"
        // case); otherwise bank (the second most common — utility/rent bills).
        setPaidFrom(shiftIsOpen ? 'drawer' : 'bank');
        setOwnerId(owners.data?.[0]?.id ?? '');
        setAllocations([]);
        allocsHydrated.current = true;
      }
      setErr(null);
    }
    last.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, cats.data, owners.data]);

  // Hydrate allocations from the detail fetch (edit mode only, once per open).
  useEffect(() => {
    if (!open || !isEdit || allocsHydrated.current || !detail.data) return;
    setAllocations(
      (detail.data.allocations ?? []).map((a) => ({
        menuCategoryId: a.menu_category_id,
        sharePct: a.share_pct,
      })),
    );
    allocsHydrated.current = true;
  }, [open, isEdit, detail.data]);

  // If user picked 'drawer' but the shift closes, bump them to 'bank'.
  // (Create only — an existing drawer expense keeps its source.)
  useEffect(() => {
    if (!isEdit && paidFrom === 'drawer' && !shiftIsOpen) {
      setPaidFrom('bank');
    }
  }, [isEdit, paidFrom, shiftIsOpen]);

  const totalShare = allocations.reduce((sum, a) => sum + (parseFloat(a.sharePct) || 0), 0);

  const bankBalance = balance.data?.bank_cents ?? 0;
  const ownersList = owners.data ?? [];
  const selectedOwner = ownersList.find((o) => o.id === ownerId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Expense' : 'New Expense'}
      subtitle="Cost-center allocation"
    >
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
          if (!isEdit && invId && !delta.trim()) {
            setErr('how many units did you buy? (delta_units)');
            return;
          }
          if (totalShare > 100.001) {
            setErr('allocation shares sum to more than 100%');
            return;
          }
          if (!isEdit && paidFrom === 'owner' && !ownerId) {
            setErr('pick an owner');
            return;
          }
          const allocationsBody = allocations
            .filter((a) => a.menuCategoryId && parseFloat(a.sharePct) > 0)
            .map((a) => ({ menu_category_id: a.menuCategoryId, share_pct: a.sharePct }));
          try {
            if (isEdit && editing) {
              await update.mutateAsync({
                id: editing.id,
                patch: {
                  vendor,
                  expense_category_id: expenseCatId || undefined,
                  clear_category: expenseCatId === '',
                  amount_cents: cents,
                  paid_at: new Date(`${paidAt}T${paidTime}:00`).toISOString(),
                  reference_no: referenceNo,
                  notes,
                  ...(allocsHydrated.current ? { allocations: allocationsBody } : {}),
                },
              });
            } else {
              await create.mutateAsync({
                expense_category_id: expenseCatId || null,
                vendor,
                amount_cents: cents,
                paid_at: new Date(`${paidAt}T${paidTime}:00`).toISOString(),
                reference_no: referenceNo,
                notes,
                linked_inventory_item_id: invId || null,
                delta_units: invId ? delta : undefined,
                paid_from: paidFrom,
                owner_id: paidFrom === 'owner' ? ownerId : null,
                allocations: allocationsBody,
              });
            }
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <div className="row-inputs">
          <div className="field">
            <label>Vendor</label>
            <input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="Local mill, NEA, …"
              list="expense-vendors"
              autoComplete="off"
            />
            <datalist id="expense-vendors">
              {(vendors.data ?? []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </div>
          <div className="field">
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

        <div className="field">
          <label>Amount (NPR)</label>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            placeholder="5000"
            aria-invalid={err === 'amount required' ? true : undefined}
          />
        </div>

        {/* Paid-from segmented picker — the heart of the 0014 expense flow.
            Immutable once recorded: changing the money source would rewrite
            the drawer / owner ledgers, so edit mode shows it read-only. */}
        <label style={{ marginTop: 'var(--space-3)' }}>Paid from</label>
        {isEdit ? (
          <div style={{ marginBottom: 'var(--space-3)' }}>
            {paidFrom === 'drawer' && (
              <span className="pill warn">
                <Banknote size={10} strokeWidth={1.5} /> Drawer
              </span>
            )}
            {paidFrom === 'bank' && (
              <span className="pill">
                <Wallet size={10} strokeWidth={1.5} /> Bank
              </span>
            )}
            {paidFrom === 'owner' && (
              <span className="pill warn">
                <Crown size={10} strokeWidth={1.5} /> {editing?.owner_name ?? 'Owner'} loan
              </span>
            )}
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-2xs)',
                letterSpacing: '0.06em',
                color: 'var(--ink-400)',
                marginTop: 6,
              }}
            >
              payment source can't change — delete and re-create to move it.
              {paidFrom === 'drawer' && ' Amount edits need the shift still open.'}
              {paidFrom === 'owner' && ' Amount edits are blocked once repayments exist.'}
            </div>
          </div>
        ) : (
          <div
            role="radiogroup"
            aria-label="paid from"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 6,
              padding: 'var(--space-1)',
              background: 'var(--ink-900)',
              border: '1px solid var(--ink-800)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 'var(--space-1)',
            }}
          >
            <PaidFromBtn
              active={paidFrom === 'drawer'}
              disabled={!shiftIsOpen}
              disabledHint="No shift open"
              icon={<Banknote size={14} strokeWidth={1.5} />}
              label="Drawer"
              sub={shiftIsOpen ? 'cash from till' : 'shift required'}
              onClick={() => setPaidFrom('drawer')}
            />
            <PaidFromBtn
              active={paidFrom === 'bank'}
              icon={<Wallet size={14} strokeWidth={1.5} />}
              label="Bank"
              sub={`avail ${formatNPR(bankBalance)}`}
              onClick={() => setPaidFrom('bank')}
            />
            <PaidFromBtn
              active={paidFrom === 'owner'}
              disabled={ownersList.length === 0}
              disabledHint="Add an owner first"
              icon={<Crown size={14} strokeWidth={1.5} />}
              label="Owner"
              sub="own pocket → loan"
              onClick={() => setPaidFrom('owner')}
            />
          </div>
        )}

        {/* Contextual hint per source. */}
        {!isEdit && paidFrom === 'drawer' && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              letterSpacing: '0.06em',
              color: 'var(--ink-400)',
              marginBottom: 'var(--space-3)',
              padding: '6px 0',
            }}
          >
            cash leaves the till during this open shift — close-shift math reconciles automatically.
          </div>
        )}
        {!isEdit && paidFrom === 'bank' && (
          <div
            style={{
              fontSize: 'var(--text-xs)',
              color: amountCents > bankBalance ? 'var(--danger-fg)' : 'var(--ink-400)',
              marginBottom: 'var(--space-3)',
              padding: '6px 0',
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.06em',
            }}
          >
            {amountCents > 0 && amountCents > bankBalance ? (
              <>
                <AlertTriangle size={11} strokeWidth={1.5} style={{ verticalAlign: '-2px' }} />{' '}
                exceeds bank balance — record a deposit first
              </>
            ) : amountCents > 0 ? (
              <>
                bank: {formatNPR(bankBalance)} → {formatNPR(bankBalance - amountCents)}
              </>
            ) : (
              <>debits cafe bank balance</>
            )}
          </div>
        )}
        {!isEdit && paidFrom === 'owner' && (
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '8px 10px',
                marginBottom: 10,
                background: 'rgba(var(--amber-glow), 0.08)',
                border: '1px solid rgba(var(--amber-glow), 0.22)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--text-2xs)',
                lineHeight: 1.5,
                letterSpacing: '0.04em',
                color: 'var(--ink-300)',
              }}
            >
              <Info size={13} strokeWidth={1.6} style={{ flexShrink: 0, marginTop: 1, color: 'var(--amber-fg)' }} />
              <span>
                Use this only when the owner paid from their <strong style={{ color: 'var(--ink-100)' }}>own
                pocket</strong> — the cafe will owe them back. If they spent cafe cash they'd already taken
                from the drawer, record it under{' '}
                <strong style={{ color: 'var(--ink-100)' }}>Owners → Cash with owners → Spend on cafe</strong>{' '}
                instead, so it draws down what they're holding rather than creating a new debt.
              </span>
            </div>
            <label>Which owner advanced this?</label>
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {ownersList.length === 0 && <option value="">no active owners</option>}
              {ownersList.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.display_name} ({o.share_units}sh)
                </option>
              ))}
            </select>
            {selectedOwner && amountCents > 0 && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-2xs)',
                  letterSpacing: '0.06em',
                  color: 'var(--amber-fg)',
                  marginTop: 6,
                }}
              >
                creates a {formatNPR(amountCents)} loan from {selectedOwner.display_name}. Repay
                from bank on the Owners page.
              </div>
            )}
          </div>
        )}

        <div>
          <label>Paid at</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 'var(--space-2)' }}>
            <DatePicker value={paidAt} onChange={setPaidAt} max={new Date().toISOString().slice(0, 10)} />
            <TimePicker value={paidTime} onChange={setPaidTime} />
          </div>
        </div>

        <div className="field">
          <label>Reference</label>
          <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="Optional" />
        </div>

        <div className="field">
          <label>Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was this for?" />
        </div>

        {isEdit ? (
          <div style={{ marginBottom: 14 }}>
            <label>Inventory link</label>
            {editing?.linked_inventory_name ? (
              <div>
                <span className="pill ok">
                  <Boxes size={10} strokeWidth={1.5} /> {editing.linked_inventory_name}
                </span>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-2xs)',
                    letterSpacing: '0.06em',
                    color: 'var(--ink-400)',
                    marginTop: 6,
                  }}
                >
                  link can't change — amount edits recompute the purchase's unit cost.
                </div>
              </div>
            ) : (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-2xs)',
                  letterSpacing: '0.06em',
                  color: 'var(--ink-400)',
                }}
              >
                none — delete and re-create to link a stock purchase.
              </div>
            )}
          </div>
        ) : (
        <div className="field-group" style={{ marginBottom: 14 }}>
          <label>Add to inventory (optional)</label>
          <div
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--ink-400)',
              margin: '2px 0 8px',
            }}
          >
            Bought stock? Pick the item and how many units — we&apos;ll add it to inventory for you,
            so you don&apos;t have to log it twice.
          </div>
          <div className="row-inputs">
            <div className="field">
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
            <div className="field">
              <label>Units bought</label>
              <input
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder="200"
                disabled={!invId}
                aria-invalid={err?.startsWith('how many units') ? true : undefined}
              />
            </div>
          </div>
          {invId && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-2xs)',
                letterSpacing: '0.08em',
                color: 'var(--ink-400)',
              }}
            >
              creates a purchase movement; unit cost = amount ÷ units
            </div>
          )}
        </div>
        )}

        <details open={allocations.length > 0}>
          <summary
            style={{
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
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
                style={{ gridTemplateColumns: '1fr 110px auto', alignItems: 'end', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}
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
            <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 'var(--space-1)' }}>
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
                fontSize: 'var(--text-2xs)',
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
          <button type="submit" className="btn primary" disabled={create.isPending || update.isPending}>
            {create.isPending || update.isPending
              ? 'Saving…'
              : isEdit
                ? 'Save changes'
                : 'Log expense'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------
// PaidFromBtn — segmented-control button used inside the expense modal.

function PaidFromBtn({
  active,
  disabled,
  disabledHint,
  icon,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  disabledHint?: string;
  icon: React.ReactNode;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledHint : undefined}
      style={{
        padding: '12px 10px',
        background: active ? 'var(--ink-800)' : 'transparent',
        border: '1px solid ' + (active ? 'var(--amber-fg)' : 'transparent'),
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        color: 'var(--ink-50)',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        transition: 'border-color 120ms ease, background 120ms ease',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: active ? 'var(--amber-fg)' : 'var(--ink-200)',
          fontWeight: 500,
          fontSize: 'var(--text-md)',
        }}
      >
        {icon}
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-2xs)',
          letterSpacing: '0.04em',
          color: 'var(--ink-400)',
        }}
      >
        {sub}
      </span>
    </button>
  );
}

// helper not used directly but exported to silence unused-import warnings would land here
export const _useExpense = (e: Expense) => e.id;
