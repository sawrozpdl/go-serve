import { useEffect, useRef, useState } from 'react';

import { Modal } from '@/components/Modal';
import { SearchSelect } from '@/components/SearchSelect';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { usePermissions } from '@/lib/permissions';

const DISCOUNT_REASONS = [
  { value: 'regular', label: 'Regular' },
  { value: 'promotion', label: 'Promotion' },
  { value: 'birthday', label: 'Birthday' },
  { value: 'staff', label: 'Staff' },
  { value: 'friends', label: 'Friends' },
  { value: 'other', label: 'Other' },
];
import {
  useApplyAdjustment,
  useOrderAdjustments,
  useRemoveAdjustment,
  useSettleQuote,
  useTenantSettings,
} from '@/lib/api';
import { Trash2 } from 'lucide-react';

type Mode = 'percent' | 'flat';

export function DiscountModal({
  open,
  orderId,
  tableLabel,
  onClose,
}: {
  open: boolean;
  orderId: string;
  /** Which tab the discount applies to — shown in the title for context. */
  tableLabel: string;
  onClose: () => void;
}) {
  const { can } = usePermissions();
  const quote = useSettleQuote(open ? orderId : undefined);
  const list = useOrderAdjustments(open ? orderId : undefined);
  const apply = useApplyAdjustment();
  const remove = useRemoveAdjustment();
  const tenant = useTenantSettings();

  // Defaults: flat amount + "regular" reason mirror the most common
  // counter-front discount (a cashier rounding off Rs 7 because that's
  // what the customer handed over). Tenant can override defaults via
  // preferences.defaultDiscount once the settings UI lands.
  const prefDefaults = tenant.data?.preferences?.defaultDiscount;
  const defaultMode: Mode = (prefDefaults?.mode as Mode | undefined) ?? 'flat';
  const defaultReason = prefDefaults?.reason ?? 'regular';

  const [mode, setMode] = useState<Mode>(defaultMode);
  const [amountStr, setAmountStr] = useState('');
  const [reason, setReason] = useState(defaultReason);
  const [err, setErr] = useState<string | null>(null);

  const last = useRef(false);
  useEffect(() => {
    if (open !== last.current && open) {
      setMode(defaultMode);
      setAmountStr('');
      setReason(defaultReason);
      setErr(null);
    }
    last.current = open;
  }, [open, defaultMode, defaultReason]);

  const subtotal = quote.data?.subtotal_cents ?? 0;
  const totalCents = quote.data?.total_cents ?? 0;
  const existingDiscount = quote.data?.discount_cents ?? 0;
  const computed = (() => {
    if (!amountStr) return 0;
    if (mode === 'percent') {
      const pct = parseFloat(amountStr);
      if (isNaN(pct) || pct <= 0) return 0;
      return Math.round((subtotal * pct) / 100);
    }
    return parsePriceInput(amountStr) ?? 0;
  })();

  // Discounts require an explicit Apply tap — nothing is committed while the
  // cashier is still typing. (Auto-apply-on-change tripped up slow typers by
  // firing a discount for each partial number before they finished.)

  return (
    <Modal open={open} onClose={onClose} title={`Apply Discount · ${tableLabel}`} subtitle="Requires the adjustment:apply permission">
      <div className="settle-totals" style={{ marginBottom: 14 }}>
        <Row label="Subtotal" value={subtotal} />
        {existingDiscount > 0 && <Row label="Discount (so far)" value={-existingDiscount} accent />}
        <hr className="settle-rule" />
        <Row
          label={(() => {
            const vatMode = tenant.data?.vat_mode ?? 'none';
            const vatOn = vatMode !== 'none' && parseFloat(tenant.data?.vat_pct ?? '0') > 0;
            const svc = parseFloat(tenant.data?.service_charge_pct ?? '0') > 0;
            if (vatMode === 'inclusive' && vatOn) return 'Total (incl. VAT)';
            const extras = [vatOn && 'VAT', svc && 'svc'].filter(Boolean).join(' & ');
            return extras ? `Total (with ${extras})` : 'Total';
          })()}
          value={totalCents}
          bold
        />
      </div>

      {(list.data?.length ?? 0) > 0 && (
        <div className="settle-payments">
          <div className="settle-payments-head">already applied</div>
          {list.data!.map((a) => (
            <div
              key={a.id}
              className="settle-payments-row"
              style={{ gridTemplateColumns: 'auto 1fr auto auto' }}
            >
              <span className="pill">{a.type}</span>
              <span className="ref">{a.reason}</span>
              <span className="amt" style={{ color: 'var(--amber-fg)' }}>
                {formatNPR(a.amount_cents)}
              </span>
              {can('adjustment:delete') && (
                <button
                  type="button"
                  className="btn icon danger"
                  onClick={() =>
                    remove
                      .mutateAsync({ orderId, adjId: a.id })
                      .catch((e) => setErr((e as { message?: string }).message ?? 'Failed'))
                  }
                  aria-label="remove"
                >
                  <Trash2 size={12} strokeWidth={1.5} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {err && <div className="banner-error">{err}</div>}

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          if (computed <= 0) {
            setErr('amount must be > 0');
            return;
          }
          if (!reason.trim()) {
            setErr('reason required');
            return;
          }
          try {
            await apply.mutateAsync({
              orderId,
              type: 'discount',
              amount_cents: computed,
              reason: reason.trim(),
            });
            setAmountStr('');
            // Auto-close the modal once a discount is recorded — the cashier
            // typically applies one and moves on to settle. Leaving the modal
            // open invites accidental double-application.
            onClose();
          } catch (e: unknown) {
            setErr((e as { message?: string }).message ?? 'Failed');
          }
        }}
      >
        <label>Type</label>
        <div className="filter-row" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={`chip ${mode === 'flat' ? 'active' : ''}`}
            onClick={() => setMode('flat')}
          >
            flat NPR off
          </button>
          <button
            type="button"
            className={`chip ${mode === 'percent' ? 'active' : ''}`}
            onClick={() => setMode('percent')}
          >
            % off
          </button>
        </div>

        <div className="row-inputs">
          <div>
            <label>{mode === 'percent' ? 'Percent' : 'Amount (NPR)'}</label>
            <input
              inputMode="decimal"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder={mode === 'percent' ? '10' : '50'}
              required
              autoFocus
            />
          </div>
          <div>
            <label>Reason</label>
            <SearchSelect
              options={DISCOUNT_REASONS}
              value={reason}
              onChange={setReason}
              placeholder="pick a reason"
              required
            />
          </div>
        </div>

        {computed > 0 && (
          <div
            style={{
              fontFamily: 'var(--font-num)',
              fontVariantNumeric: 'tabular-nums',
              fontSize: 12,
              letterSpacing: '0.04em',
              padding: '10px 12px',
              borderRadius: 2,
              marginBottom: 14,
              background: 'rgba(255,163,25,0.08)',
              border: '1px solid rgba(255,163,25,0.3)',
              color: 'var(--amber-fg)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
            }}
          >
            <span>will deduct</span>
            <strong>{formatNPR(computed)}</strong>
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {can('adjustment:apply') && (
            <button type="submit" className="btn primary" disabled={apply.isPending}>
              {apply.isPending ? 'Applying…' : 'Apply'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: number;
  bold?: boolean;
  accent?: boolean;
}) {
  const cls = ['settle-row'];
  if (bold) cls.push('bold');
  if (accent) cls.push('accent');
  return (
    <div className={cls.join(' ')}>
      <span>{label}</span>
      <span className="num">{formatNPR(value)}</span>
    </div>
  );
}
