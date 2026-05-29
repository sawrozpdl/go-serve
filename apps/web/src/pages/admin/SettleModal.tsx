import { useState } from 'react';
import { Receipt, Banknote, Smartphone, X, AlertTriangle, Bookmark, Percent } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { SearchSelect } from '@/components/SearchSelect';
import { formatNPR, parsePriceInput } from '@/components/Money';
import {
  useSettleQuote,
  useOrderPayments,
  useRecordPayment,
  useDeletePayment,
  useCloseOrder,
  useHouseTabs,
  useApplyAdjustment,
  useOrderAdjustments,
  useRemoveAdjustment,
  useTenantSettings,
  type PaymentMethod,
} from '@/lib/api';

const COMBINED_DISCOUNT_REASONS = [
  { value: 'regular', label: 'Regular' },
  { value: 'promotion', label: 'Promotion' },
  { value: 'birthday', label: 'Birthday' },
  { value: 'staff', label: 'Staff' },
  { value: 'friends', label: 'Friends' },
  { value: 'other', label: 'Other' },
];

// User-visible method set is two: Cash or Online. The backend enum still
// carries the historical values (esewa / khalti / card / other) on past
// rows; everything outside the canonical set displays as "Online" so the
// payments list reads consistently without losing the wire value.
const METHOD_DISPLAY: Record<PaymentMethod, { label: string; icon: React.ReactNode }> = {
  cash: { label: 'Cash', icon: <Banknote size={14} strokeWidth={1.5} /> },
  online: { label: 'Online', icon: <Smartphone size={14} strokeWidth={1.5} /> },
  esewa: { label: 'Online', icon: <Smartphone size={14} strokeWidth={1.5} /> },
  khalti: { label: 'Online', icon: <Smartphone size={14} strokeWidth={1.5} /> },
  card: { label: 'Online', icon: <Smartphone size={14} strokeWidth={1.5} /> },
  other: { label: 'Online', icon: <Smartphone size={14} strokeWidth={1.5} /> },
  house_tab: { label: 'House tab', icon: <Bookmark size={14} strokeWidth={1.5} /> },
};

type UIMethod = 'cash' | 'online' | 'house_tab';

export function SettleModal({
  open,
  orderId,
  onClose,
  onClosed,
}: {
  open: boolean;
  orderId: string;
  onClose: () => void;
  onClosed: () => void;
}) {
  const quote = useSettleQuote(open ? orderId : undefined);
  const payments = useOrderPayments(open ? orderId : undefined);
  const record = useRecordPayment();
  const removePayment = useDeletePayment();
  const closeMut = useCloseOrder();
  const tenant = useTenantSettings();
  const adjustments = useOrderAdjustments(open ? orderId : undefined);
  const applyAdj = useApplyAdjustment();
  const removeAdj = useRemoveAdjustment();

  const combined = !!tenant.data?.preferences?.combinedSettle;
  const defaultMode: 'flat' | 'percent' =
    (tenant.data?.preferences?.defaultDiscount?.mode as 'flat' | 'percent' | undefined) ?? 'flat';
  const defaultReason =
    tenant.data?.preferences?.defaultDiscount?.reason ?? 'regular';
  const requireTxnRef = tenant.data?.preferences?.requireTxnRef ?? false;

  const [method, setMethod] = useState<UIMethod>('cash');
  const [amountStr, setAmountStr] = useState('');
  const [refNo, setRefNo] = useState('');
  const [houseTabId, setHouseTabId] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // Combined mode discount controls. Inlined so the cashier doesn't bounce
  // between two modals to discount + collect on the same tab.
  const [discMode, setDiscMode] = useState<'flat' | 'percent'>(defaultMode);
  const [discAmt, setDiscAmt] = useState('');
  const [discReason, setDiscReason] = useState(defaultReason);

  // Only fetch the tabs list when this modal is actually open and the user
  // has switched to the house-tab method, so we don't pay the round-trip
  // for every regular cash settle.
  const houseTabs = useHouseTabs();
  const activeTabs = (houseTabs.data ?? []).filter((t) => t.is_active);

  // Suggest the outstanding balance whenever the quote refreshes.
  const balance = quote.data?.balance_cents ?? 0;
  const suggested = balance > 0 ? balance : 0;
  const suggestStr = suggested > 0 ? (suggested / 100).toString() : '';

  const doRecord = async (cents: number): Promise<boolean> => {
    setErr(null);
    if (cents <= 0) {
      setErr('amount required');
      return false;
    }
    if (cents > balance) {
      setErr(
        `amount exceeds outstanding balance of ${formatNPR(balance)} — enter ${formatNPR(balance)} or less`,
      );
      return false;
    }
    if (method === 'house_tab' && !houseTabId) {
      setErr('pick a house tab to charge to (or create one in Tabs)');
      return false;
    }
    try {
      // Three wire methods: cash, online, house_tab. The backend supports
      // the longer historical enum but the operator only ever picks from
      // these three — see migration 0015 for the consolidation rationale.
      const wire: PaymentMethod =
        method === 'cash' ? 'cash' : method === 'house_tab' ? 'house_tab' : 'online';
      await record.mutateAsync({
        orderId,
        method: wire,
        amount_cents: cents,
        reference_no: refNo.trim() || undefined,
        house_tab_id: method === 'house_tab' ? houseTabId : undefined,
      });
      setAmountStr('');
      setRefNo('');
      // Intentionally do NOT auto-close when the payment zeroes the balance.
      // Closing is a deliberate, audit-visible action — the cashier must
      // verify the line items and click "Close tab". This leaves room to
      // edit (remove a mis-typed payment, apply a discount) before the
      // table is freed and the receipt is finalised.
      return true;
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
      return false;
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cents = parsePriceInput(amountStr) ?? 0;
    await doRecord(cents);
  };

  const subtotalCents = quote.data?.subtotal_cents ?? 0;
  const computedDiscount = (() => {
    if (!discAmt) return 0;
    if (discMode === 'percent') {
      const pct = parseFloat(discAmt);
      if (isNaN(pct) || pct <= 0) return 0;
      return Math.round((subtotalCents * pct) / 100);
    }
    return parsePriceInput(discAmt) ?? 0;
  })();

  const applyCombinedDiscount = async () => {
    setErr(null);
    if (computedDiscount <= 0) {
      setErr('discount must be > 0');
      return;
    }
    try {
      await applyAdj.mutateAsync({
        orderId,
        type: 'discount',
        amount_cents: computedDiscount,
        reason: discReason.trim() || 'regular',
      });
      setDiscAmt('');
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  const closeTab = async () => {
    setErr(null);
    try {
      await closeMut.mutateAsync(orderId);
      onClosed();
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  // Close-tab gate: at least one billable item AND balance is exactly 0.
  // Strict equality matches the backend — overpayments must be undone via
  // the per-payment remove button before close is allowed.
  const subtotal = quote.data?.subtotal_cents ?? 0;
  const balanceSettled = subtotal > 0 && balance === 0;
  const overpaid = balance < 0;

  return (
    <Modal open={open} onClose={onClose} title="Settle" subtitle="VAT 13% applied at close">
      {!quote.data && <div className="empty-state">Computing…</div>}
      {quote.data && (
        <>
          <div className="settle-totals">
            <Row label="Subtotal" value={quote.data.subtotal_cents} />
            {quote.data.discount_cents > 0 && (
              <Row label="Discount" value={-quote.data.discount_cents} accent />
            )}
            {quote.data.service_charge_cents > 0 && (
              <Row
                label={`Service charge (${quote.data.service_charge_pct}%)`}
                value={quote.data.service_charge_cents}
              />
            )}
            <Row label={`VAT (${quote.data.vat_pct}%)`} value={quote.data.tax_cents} />
            <hr className="settle-rule" />
            <Row label="Total" value={quote.data.total_cents} bold />
            <Row label="paid" value={quote.data.paid_cents} muted />
            <Row
              label="balance"
              value={quote.data.balance_cents}
              accent={quote.data.balance_cents !== 0}
              bold
            />
          </div>

          {combined && (
            <div className="settle-payments">
              <div className="settle-payments-head">
                <Percent size={11} strokeWidth={1.6} style={{ verticalAlign: '-1px' }} /> discount
              </div>
              {(adjustments.data?.length ?? 0) > 0 && (
                <>
                  {adjustments.data!
                    .filter((a) => a.type === 'discount')
                    .map((a) => (
                      <div
                        key={a.id}
                        className="settle-payments-row"
                        style={{ gridTemplateColumns: 'auto 1fr auto auto' }}
                      >
                        <span className="pill">{a.reason}</span>
                        <span className="ref">{a.type}</span>
                        <span className="amt" style={{ color: 'var(--amber-fg)' }}>
                          −{formatNPR(a.amount_cents)}
                        </span>
                        <button
                          type="button"
                          className="btn icon danger"
                          aria-label="remove discount"
                          onClick={() =>
                            removeAdj
                              .mutateAsync({ orderId, adjId: a.id })
                              .catch((e) =>
                                setErr((e as { message?: string }).message ?? 'Failed'),
                              )
                          }
                        >
                          <X size={12} strokeWidth={1.5} />
                        </button>
                      </div>
                    ))}
                </>
              )}
              <div className="discount-grid">
                <div className="discount-mode" role="group" aria-label="discount mode">
                  <button
                    type="button"
                    className={`chip ${discMode === 'flat' ? 'active' : ''}`}
                    onClick={() => setDiscMode('flat')}
                  >
                    flat
                  </button>
                  <button
                    type="button"
                    className={`chip ${discMode === 'percent' ? 'active' : ''}`}
                    onClick={() => setDiscMode('percent')}
                  >
                    %
                  </button>
                </div>
                <div className="discount-reason">
                  <SearchSelect
                    options={COMBINED_DISCOUNT_REASONS}
                    value={discReason}
                    onChange={setDiscReason}
                    placeholder="pick a reason"
                  />
                </div>
                <div className="discount-amount">
                  <input
                    inputMode="decimal"
                    value={discAmt}
                    onChange={(e) => setDiscAmt(e.target.value)}
                    placeholder={discMode === 'percent' ? '10' : '50'}
                  />
                </div>
                <div className="discount-action">
                  <button
                    type="button"
                    className="btn"
                    onClick={applyCombinedDiscount}
                    disabled={!discAmt || applyAdj.isPending}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    <Percent size={12} strokeWidth={1.5} />
                    {applyAdj.isPending ? 'Applying…' : 'Apply discount'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {(payments.data?.length ?? 0) > 0 && (
            <div className="settle-payments">
              <div className="settle-payments-head">payments</div>
              {payments.data!.map((p) => (
                <div
                  key={p.id}
                  className="settle-payments-row"
                  style={{ gridTemplateColumns: 'auto 1fr auto auto' }}
                >
                  <span className="pill">{METHOD_DISPLAY[p.method]?.label ?? p.method}</span>
                  <span className="ref">{p.reference_no || ''}</span>
                  <span className="amt">{formatNPR(p.amount_cents)}</span>
                  <button
                    type="button"
                    className="btn icon danger"
                    onClick={async () => {
                      setErr(null);
                      try {
                        await removePayment.mutateAsync({ orderId, paymentId: p.id });
                      } catch (e: unknown) {
                        setErr((e as { message?: string }).message ?? 'Failed');
                      }
                    }}
                    aria-label="remove this payment"
                    title="Remove this payment"
                    disabled={removePayment.isPending}
                  >
                    <X size={12} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {overpaid && (
            <div
              className="banner-error"
              style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: 1.4 }}
            >
              <AlertTriangle size={14} strokeWidth={1.5} />
              <span>
                overpaid by <strong>{formatNPR(-balance)}</strong> — remove a payment above to
                continue. close requires a balance of zero.
              </span>
            </div>
          )}

          {err && <div className="banner-error">{err}</div>}

          {balance > 0 && (
            <form onSubmit={submit} className="settle-form">
              <label>Method</label>
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
                <button
                  type="button"
                  className={`chip ${method === 'house_tab' ? 'active' : ''}`}
                  onClick={() => setMethod('house_tab')}
                >
                  <Bookmark size={14} strokeWidth={1.5} /> House tab
                </button>
              </div>

              {method === 'house_tab' && (
                <>
                  <label>Charge to tab</label>
                  <select
                    value={houseTabId}
                    onChange={(e) => setHouseTabId(e.target.value)}
                    required
                  >
                    <option value="">— pick a tab —</option>
                    {activeTabs.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} {t.balance_cents > 0 && `(${formatNPR(t.balance_cents)} owed)`}
                      </option>
                    ))}
                  </select>
                  {activeTabs.length === 0 && (
                    <div className="field-hint" style={{ marginTop: -8, marginBottom: 14 }}>
                      no active house tabs — create one in <strong>Tabs</strong> first.
                    </div>
                  )}
                  <div className="field-hint" style={{ marginTop: -8, marginBottom: 14 }}>
                    revenue is recognised now; the cash isn't received until the tab is settled.
                  </div>
                </>
              )}

              <div className="row-inputs">
                <div>
                  <label>Amount (NPR)</label>
                  <input
                    inputMode="decimal"
                    placeholder={suggestStr || '0'}
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value)}
                    autoFocus
                  />
                  <div className="field-hint">remaining: {formatNPR(balance)}</div>
                </div>
                {method === 'online' && requireTxnRef && (
                  <div>
                    <label>Txn reference</label>
                    <input
                      value={refNo}
                      onChange={(e) => setRefNo(e.target.value)}
                      placeholder="transaction id from the customer's phone"
                    />
                  </div>
                )}
                {method === 'house_tab' && (
                  <div>
                    <label>Note (optional)</label>
                    <input
                      value={refNo}
                      onChange={(e) => setRefNo(e.target.value)}
                      placeholder="e.g. order code"
                    />
                  </div>
                )}
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (suggestStr) setAmountStr(suggestStr);
                  }}
                  disabled={!suggestStr}
                >
                  Auto-fill {suggestStr && `(${formatNPR(suggested)})`}
                </button>
                <button type="submit" className="btn primary" disabled={record.isPending}>
                  {record.isPending ? 'Recording…' : 'Add payment'}
                </button>
              </div>
            </form>
          )}

          <div
            className="modal-actions"
            style={{ marginTop: 14, borderTop: '1px solid var(--ink-800)', paddingTop: 14 }}
          >
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!balanceSettled || closeMut.isPending}
              onClick={closeTab}
              title={
                overpaid
                  ? 'remove a payment to bring balance to zero before closing'
                  : !balanceSettled
                  ? 'collect the outstanding balance to enable close'
                  : undefined
              }
            >
              <Receipt size={14} strokeWidth={1.5} />
              {closeMut.isPending ? 'Closing…' : 'Close tab'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
  accent,
}: {
  label: string;
  value: number;
  bold?: boolean;
  muted?: boolean;
  accent?: boolean;
}) {
  const cls = ['settle-row'];
  if (bold) cls.push('bold');
  if (muted) cls.push('muted');
  if (accent) cls.push('accent');
  return (
    <div className={cls.join(' ')}>
      <span>{label}</span>
      <span className="num">{formatNPR(value)}</span>
    </div>
  );
}
