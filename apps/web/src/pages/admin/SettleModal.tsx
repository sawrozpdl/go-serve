import { useEffect, useState } from 'react';
import {
  Receipt,
  Banknote,
  Smartphone,
  X,
  AlertTriangle,
  ArrowLeftRight,
  Bookmark,
  Percent,
  Plus,
} from 'lucide-react';

import { Modal } from '@/components/Modal';
import { SearchSelect } from '@/components/SearchSelect';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { toast } from '@/lib/toast';
import { useConnectivity } from '@/lib/connectivity';
import { usePermissions } from '@/lib/permissions';
import {
  useSettleQuote,
  useOrderPayments,
  useRecordPayment,
  useDeletePayment,
  useReclassifyPayment,
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

// Trim a percent string ("13.00" -> "13", "8.50" -> "8.5") for display.
const trimPct = (s: string) => String(parseFloat(s));

// The Settle modal subtitle must reflect the tenant's *actual* rates — VAT is
// per-tenant and can be 0, so a hardcoded "VAT 13%" lies for zero-VAT cafes.
function settleSubtitle(q: { vat_pct: string; service_charge_pct: string }): string {
  const vat = parseFloat(q.vat_pct) || 0;
  const sc = parseFloat(q.service_charge_pct) || 0;
  if (vat > 0 && sc > 0)
    return `VAT ${trimPct(q.vat_pct)}% · service ${trimPct(q.service_charge_pct)}% applied at close`;
  if (vat > 0) return `VAT ${trimPct(q.vat_pct)}% applied at close`;
  if (sc > 0) return `Service charge ${trimPct(q.service_charge_pct)}% applied at close`;
  return 'Applied at close';
}

export function SettleModal({
  open,
  orderId,
  tableLabel,
  onClose,
  onClosed,
}: {
  open: boolean;
  orderId: string;
  /** Which tab is being settled (e.g. "Table 4" / "Take-away") — shown in the
   *  title so the cashier always knows what they're closing. */
  tableLabel: string;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { can } = usePermissions();
  const offline = useConnectivity().mode === 'offline';
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

  // No method state and no default: the method IS the commit (tender
  // buttons). A payment can't be recorded without consciously choosing
  // cash or online — the root cause of mis-recorded methods was the old
  // preselected-cash chip row.
  const [amountStr, setAmountStr] = useState('');
  const [refNo, setRefNo] = useState('');
  const [houseTabId, setHouseTabId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // Which tender shows "Recording…" while the mutation is in flight.
  const [pendingMethod, setPendingMethod] = useState<UIMethod | null>(null);
  // Online two-step: when the tenant requires a txn ref, the Online tender
  // first reveals the ref field + a confirm button.
  const [onlineRefOpen, setOnlineRefOpen] = useState(false);
  // House tab is the rare path — tucked behind a tertiary expander.
  const [houseTabOpen, setHouseTabOpen] = useState(false);
  // Payment row with the reclassify confirm open (manager fix-up).
  const [confirmSwapId, setConfirmSwapId] = useState<string | null>(null);
  const reclassify = useReclassifyPayment();

  // Combined mode discount controls. Inlined so the cashier doesn't bounce
  // between two modals to discount + collect on the same tab.
  const [discMode, setDiscMode] = useState<'flat' | 'percent'>(defaultMode);
  const [discAmt, setDiscAmt] = useState('');
  const [discReason, setDiscReason] = useState(defaultReason);
  // The discount entry form is hidden behind an "Add a discount" toggle so a
  // no-discount settle (the common case) stays uncluttered.
  const [showDiscountForm, setShowDiscountForm] = useState(false);

  // Only fetch the tabs list when this modal is actually open and the user
  // has switched to the house-tab method, so we don't pay the round-trip
  // for every regular cash settle.
  const houseTabs = useHouseTabs();
  const activeTabs = (houseTabs.data ?? []).filter((t) => t.is_active);

  // Suggest the outstanding balance whenever the quote refreshes.
  const balance = quote.data?.balance_cents ?? 0;

  // Prefill the amount with the outstanding balance — full settle is the
  // overwhelming common case. Re-prefills after every recorded payment
  // (balance changes); overtyping a smaller amount still allows splits.
  useEffect(() => {
    if (!open) return;
    setAmountStr(balance > 0 ? (balance / 100).toString() : '');
  }, [open, balance]);

  // Reset the transient steps whenever the modal closes.
  useEffect(() => {
    if (open) return;
    setOnlineRefOpen(false);
    setHouseTabOpen(false);
    setConfirmSwapId(null);
    setRefNo('');
    setErr(null);
  }, [open]);

  const doRecord = async (method: UIMethod, cents: number): Promise<boolean> => {
    setErr(null);
    // Money movement is never queued offline: the authoritative quote, cash
    // drawer, and another device's concurrent settle all live server-side.
    // (TabPage disables the Settle button offline; this is belt-and-braces.)
    if (offline) {
      setErr('settlement needs a connection — reconnect and try again');
      return false;
    }
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
    setPendingMethod(method);
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
      setRefNo('');
      setOnlineRefOpen(false);
      // amountStr re-prefills with the new remaining balance via the effect.
      // Intentionally do NOT auto-close when the payment zeroes the balance.
      // Closing is a deliberate, audit-visible action — the cashier must
      // verify the line items and click "Close tab". This leaves room to
      // edit (remove a mis-typed payment, apply a discount) before the
      // table is freed and the receipt is finalised.
      return true;
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
      return false;
    } finally {
      setPendingMethod(null);
    }
  };

  const tenderAmount = parsePriceInput(amountStr) ?? 0;
  const tender = (method: UIMethod) => void doRecord(method, tenderAmount);

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
      setShowDiscountForm(false); // collapse back once applied
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  const closeTab = async () => {
    setErr(null);
    if (offline) {
      setErr('closing a tab needs a connection — reconnect and try again');
      return;
    }
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

  const appliedDiscounts = (adjustments.data ?? []).filter((a) => a.type === 'discount');
  const canApplyDiscount = can('adjustment:apply');
  const canDeleteDiscount = can('adjustment:delete');
  const reasonLabel = (r: string) =>
    COMBINED_DISCOUNT_REASONS.find((o) => o.value === r)?.label ?? r;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Settle · ${tableLabel}`}
      subtitle={quote.data ? settleSubtitle(quote.data) : undefined}
    >
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

          {combined && (canApplyDiscount || appliedDiscounts.length > 0) && (
            <div className="settle-discount">
              {appliedDiscounts.length > 0 && (
                <div className="discount-applied">
                  {appliedDiscounts.map((a) => (
                    <div key={a.id} className="discount-applied-row">
                      <span className="discount-tag">
                        <Percent size={10} strokeWidth={1.8} />
                        {reasonLabel(a.reason)}
                      </span>
                      <span className="discount-applied-amt">−{formatNPR(a.amount_cents)}</span>
                      {canDeleteDiscount && (
                        <button
                          type="button"
                          className="btn icon"
                          aria-label="remove discount"
                          onClick={() =>
                            removeAdj
                              .mutateAsync({ orderId, adjId: a.id })
                              .catch((e) =>
                                setErr((e as { message?: string }).message ?? 'Failed'),
                              )
                          }
                        >
                          <X size={13} strokeWidth={1.6} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {canApplyDiscount && !showDiscountForm && (
                <button
                  type="button"
                  className="discount-add"
                  onClick={() => setShowDiscountForm(true)}
                >
                  <Plus size={14} strokeWidth={1.8} />
                  {appliedDiscounts.length > 0 ? 'Add another discount' : 'Add a discount'}
                </button>
              )}

              {canApplyDiscount && showDiscountForm && (
                <div className="discount-form">
                  <div className="discount-form-head">
                    <span className="discount-form-title">
                      <Percent size={11} strokeWidth={1.8} /> Discount
                    </span>
                    <div className="discount-mode" role="group" aria-label="discount type">
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
                  </div>

                  <div className="discount-reason">
                    <SearchSelect
                      options={COMBINED_DISCOUNT_REASONS}
                      value={discReason}
                      onChange={setDiscReason}
                      placeholder="pick a reason"
                    />
                  </div>

                  <div className="discount-entry">
                    <div className="discount-amount-field">
                      <span className="discount-affix">{discMode === 'percent' ? '%' : 'रू'}</span>
                      <input
                        inputMode="decimal"
                        value={discAmt}
                        onChange={(e) => setDiscAmt(e.target.value)}
                        placeholder={discMode === 'percent' ? '10' : '50'}
                        autoFocus
                      />
                    </div>
                    <button
                      type="button"
                      className="btn primary discount-apply"
                      onClick={applyCombinedDiscount}
                      disabled={!discAmt || computedDiscount <= 0 || applyAdj.isPending}
                    >
                      {applyAdj.isPending ? 'Applying…' : 'Apply'}
                    </button>
                  </div>

                  <div className="discount-form-foot">
                    {computedDiscount > 0 ? (
                      <span className="discount-preview">
                        −{formatNPR(computedDiscount)} off the tab
                      </span>
                    ) : (
                      <span className="discount-hint">
                        {discMode === 'percent' ? 'percentage off the subtotal' : 'amount off the subtotal'}
                      </span>
                    )}
                    <button
                      type="button"
                      className="discount-cancel"
                      onClick={() => {
                        setShowDiscountForm(false);
                        setDiscAmt('');
                        setErr(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {(payments.data?.length ?? 0) > 0 && (
            <div className="settle-payments">
              <div className="settle-payments-head">payments</div>
              {payments.data!.map((p) => {
                const cls = p.method === 'cash' ? 'cash' : p.method === 'house_tab' ? 'house_tab' : 'online';
                const swapTo = cls === 'cash' ? 'online' : 'cash';
                return (
                <div key={p.id}>
                <div
                  className="settle-payments-row"
                  style={{ gridTemplateColumns: 'auto 1fr auto auto auto' }}
                >
                  <span className="pill">{METHOD_DISPLAY[p.method]?.label ?? p.method}</span>
                  <span className="ref">{p.reference_no || ''}</span>
                  <span className="amt">{formatNPR(p.amount_cents)}</span>
                  {cls !== 'house_tab' && can('payment:reclassify') ? (
                    <button
                      type="button"
                      className="btn icon"
                      onClick={() => setConfirmSwapId(confirmSwapId === p.id ? null : p.id)}
                      aria-label={`change method to ${swapTo}`}
                      title="Wrong method? Switch cash/online"
                    >
                      <ArrowLeftRight size={12} strokeWidth={1.5} />
                    </button>
                  ) : (
                    <span />
                  )}
                  {can('payment:delete') && (
                    <button
                      type="button"
                      className="btn icon danger"
                      onClick={async () => {
                        setErr(null);
                        // Snapshot before deletion so the undo can re-record
                        // the identical payment (incl. house-tab linkage).
                        const restore = {
                          orderId,
                          method: p.method,
                          amount_cents: p.amount_cents,
                          reference_no: p.reference_no || undefined,
                          house_tab_id: p.house_tab_id || undefined,
                        };
                        try {
                          await removePayment.mutateAsync({ orderId, paymentId: p.id });
                          toast.withAction(
                            'info',
                            `Removed ${formatNPR(p.amount_cents)} payment`,
                            {
                              label: 'Undo',
                              run: () =>
                                record.mutate(restore, {
                                  onError: (e) => toast.error("Couldn't restore payment", e.message),
                                }),
                            },
                          );
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
                  )}
                </div>
                {confirmSwapId === p.id && (
                  <div className="swap-confirm">
                    <span>
                      Make this {formatNPR(p.amount_cents)} payment{' '}
                      <strong>{swapTo === 'cash' ? 'Cash' : 'Online'}</strong>?
                    </span>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={reclassify.isPending}
                      onClick={async () => {
                        setErr(null);
                        try {
                          await reclassify.mutateAsync({
                            orderId,
                            paymentId: p.id,
                            method: swapTo,
                          });
                          setConfirmSwapId(null);
                          toast.success(
                            'Payment reclassified',
                            `${formatNPR(p.amount_cents)} is now ${swapTo}`,
                          );
                        } catch (e: unknown) {
                          setErr((e as { message?: string }).message ?? 'Failed');
                        }
                      }}
                    >
                      {reclassify.isPending ? 'Switching…' : 'Confirm'}
                    </button>
                    <button type="button" className="btn" onClick={() => setConfirmSwapId(null)}>
                      Keep
                    </button>
                  </div>
                )}
                </div>
                );
              })}
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

          {balance > 0 && can('payment:record') && (
            <div className="settle-form">
              <div className="field">
                <label>Amount (NPR)</label>
                <input
                  inputMode="decimal"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  aria-invalid={err?.startsWith('amount') ? true : undefined}
                  // Tablets: the on-screen keyboard can cover the bottom half
                  // of the sheet — keep the field (and the actions below it)
                  // in view when it grabs focus.
                  onFocus={(e) =>
                    e.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  }
                />
                <div className="field-hint">
                  prefilled with the balance — edit for a split payment
                </div>
              </div>

              {/* Tender buttons: the method IS the commit. One deliberate tap
                  per payment; no default, no separate submit to mis-route. */}
              <div className="tender-grid" role="group" aria-label="record payment">
                <button
                  type="button"
                  className="tender-btn cash"
                  disabled={record.isPending || offline || tenderAmount <= 0}
                  onClick={() => {
                    setOnlineRefOpen(false);
                    tender('cash');
                  }}
                >
                  <Banknote size={20} strokeWidth={1.5} aria-hidden="true" />
                  <span className="tender-label">
                    {pendingMethod === 'cash' ? 'Recording…' : 'Cash'}
                  </span>
                  <span className="tender-amt">{formatNPR(tenderAmount)}</span>
                </button>
                <button
                  type="button"
                  className="tender-btn online"
                  disabled={record.isPending || offline || tenderAmount <= 0}
                  onClick={() => {
                    if (requireTxnRef) setOnlineRefOpen(true);
                    else tender('online');
                  }}
                >
                  <Smartphone size={20} strokeWidth={1.5} aria-hidden="true" />
                  <span className="tender-label">
                    {pendingMethod === 'online' ? 'Recording…' : 'Online'}
                  </span>
                  <span className="tender-amt">{formatNPR(tenderAmount)}</span>
                </button>
              </div>

              {onlineRefOpen && (
                <div className="tender-ref-step">
                  <div className="field">
                    <label>Txn reference</label>
                    <input
                      value={refNo}
                      onChange={(e) => setRefNo(e.target.value)}
                      placeholder="transaction id from the customer's phone"
                      autoFocus
                    />
                  </div>
                  <div className="modal-actions" style={{ marginTop: 0 }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setOnlineRefOpen(false);
                        setRefNo('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={record.isPending}
                      onClick={() => tender('online')}
                    >
                      {pendingMethod === 'online'
                        ? 'Recording…'
                        : `Record online payment (${formatNPR(tenderAmount)})`}
                    </button>
                  </div>
                </div>
              )}

              {!houseTabOpen ? (
                <button
                  type="button"
                  className="tender-tertiary"
                  onClick={() => setHouseTabOpen(true)}
                >
                  <Bookmark size={13} strokeWidth={1.5} /> Charge to a house tab…
                </button>
              ) : (
                <div className="tender-ref-step">
                  <label>Charge to tab</label>
                  <select
                    value={houseTabId}
                    onChange={(e) => setHouseTabId(e.target.value)}
                    aria-invalid={err?.startsWith('pick a house tab') ? true : undefined}
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
                  <div className="field">
                    <label>Note (optional)</label>
                    <input
                      value={refNo}
                      onChange={(e) => setRefNo(e.target.value)}
                      placeholder="e.g. order code"
                    />
                  </div>
                  <div className="modal-actions" style={{ marginTop: 0 }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setHouseTabOpen(false);
                        setRefNo('');
                        setErr(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={record.isPending}
                      onClick={() => tender('house_tab')}
                    >
                      {pendingMethod === 'house_tab'
                        ? 'Recording…'
                        : `Charge to tab (${formatNPR(tenderAmount)})`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div
            className="modal-actions"
            style={{ marginTop: 14, borderTop: '1px solid var(--ink-800)', paddingTop: 14 }}
          >
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            {can('order:settle') && (
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
            )}
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
