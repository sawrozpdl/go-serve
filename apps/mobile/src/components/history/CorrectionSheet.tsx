/**
 * Correct an issued IRD invoice (procedure 2082 §6.2(ज)). The bill itself is
 * never edited: a reverse entry cancels it the same day, a sales return credits
 * all or part of it later. Both need a reason, print as their own document and
 * are reported to CBMS. Mirrors web CorrectionModal; the server is the
 * authority on every rule (same-day reversal, over-return, refund channel).
 */
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { defaultRefundMethod, type InvoiceView } from '@cafe-mgmt/api-types';
import { issuedTodayNepal, returnedByLine } from '../../history/fiscal';
import { AppSheet } from '../ui/AppSheet';
import { AppText, MonoText } from '../ui/Text';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Stepper } from '../ui/Stepper';
import { useTheme, type Theme } from '../../theme';
import { formatNPR } from '../../lib/format';
import { toast } from '../../lib/toast';
import { errorText } from '../../lib/errorText';
import { haptics } from '../../lib/haptics';
import { useCreateCreditNote, usePrintCreditNote } from '../../api/fiscal';
import { useTenantSettings } from '../../api/tenant';
import { receiptTargets } from '../../printing/printerConfig';
import { printCreditNote } from '../../printing/receipt';

type Kind = 'reversal' | 'sales_return';
type Refund = 'cash' | 'online' | 'credit';

const QUICK_REASONS = ['Returned by guest', 'Wrong item billed', 'Wrong payment method', 'Billing mistake'];

export function CorrectionSheet({
  view,
  onClose,
}: {
  /** null = closed. */
  view: InvoiceView | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const create = useCreateCreditNote();
  const printNote = usePrintCreditNote();
  const settings = useTenantSettings();
  const prefs = settings.data?.preferences;

  const inv = view?.invoice;
  const returned = useMemo(() => returnedByLine(view?.credit_notes ?? []), [view?.credit_notes]);
  const canReverse = !!view && view.credit_notes.length === 0 && issuedTodayNepal(view.invoice.issued_at);
  const paidOnCredit = !!inv?.payment_method.includes('Credit');

  const [kind, setKind] = useState<Kind>('sales_return');
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<Refund>('cash');
  const [ref, setRef] = useState('');
  const [reopen, setReopen] = useState(false);

  // Reset whenever a different bill opens the sheet.
  const [forId, setForId] = useState<string | null>(null);
  if ((inv?.id ?? null) !== forId) {
    setForId(inv?.id ?? null);
    if (inv) {
      setKind(canReverse ? 'reversal' : 'sales_return');
      setQty({});
      setReason('');
      setRefund(defaultRefundMethod(inv.payment_method));
      setRef('');
      setReopen(false);
    }
  }

  if (!view || !inv) {
    return <AppSheet open={false} onClose={onClose}><View /></AppSheet>;
  }

  const left = (lineNo: number, billed: string) => Math.max(0, Number(billed) - (returned.get(lineNo) ?? 0));
  const picked = inv.lines.map((l) => ({ l, q: qty[l.line_no] ?? 0 })).filter((x) => x.q > 0);
  const estimate =
    kind === 'reversal'
      ? inv.total_cents
      : picked.reduce((s, x) => s + Math.round((x.l.amount_cents * x.q) / Number(x.l.qty)), 0);

  async function submit() {
    if (!inv) return;
    if (!reason.trim()) return toast.error('Give the reason', 'It is printed and reported to IRD.');
    if (kind === 'sales_return' && picked.length === 0) return toast.error('Choose what is being returned');
    haptics.selection();
    try {
      const cn = await create.mutateAsync({
        invoiceId: inv.id,
        kind,
        reason: reason.trim(),
        refund_method: refund,
        refund_reference: refund === 'online' && ref.trim() ? ref.trim() : undefined,
        lines:
          kind === 'sales_return'
            ? picked.map((x) => ({ line_no: x.l.line_no, qty: String(x.q) }))
            : undefined,
        reopen: kind === 'reversal' ? reopen : undefined,
      });
      haptics.notifySuccess();
      toast.success(
        `${cn.kind === 'reversal' ? 'Reverse entry' : 'Sales return'} ${cn.number} issued`,
        `${formatNPR(cn.total_cents)} refunded${cn.reopened_order_id ? ' · items re-opened on a new tab' : ''}`,
      );
      const printer = receiptTargets(prefs)[0];
      if (prefs?.printingEnabled && printer) {
        try {
          const printed = await printNote.mutateAsync({ creditNoteId: cn.id, device: `mobile ${printer.ip}` });
          await printCreditNote(printed, printer);
        } catch (e) {
          toast.error('Issued, but printing failed', `${errorText(e)} — reprint it from History.`);
        }
      }
      onClose();
      if (cn.reopened_order_id) {
        router.push({ pathname: '/floor/[orderId]', params: { orderId: cn.reopened_order_id } });
      }
    } catch (e) {
      toast.error('Could not issue the correction', errorText(e));
    }
  }

  return (
    <AppSheet
      open
      onClose={onClose}
      title={`Correct bill ${inv.number}`}
      size="full"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button
            variant="danger"
            title={
              kind === 'reversal'
                ? `Issue reverse entry · ${formatNPR(estimate)}`
                : `Issue sales return · ≈ ${formatNPR(estimate)}`
            }
            onPress={submit}
            loading={create.isPending}
            disabled={kind === 'sales_return' && picked.length === 0}
          />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[6],
          gap: theme.spacing[4],
        }}
      >
        <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
          FY {inv.fiscal_year} · {formatNPR(inv.total_cents)} · issued {inv.bs_date} BS
        </AppText>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
          <Chip
            label="Cancel bill (reverse entry)"
            selected={kind === 'reversal'}
            disabled={!canReverse}
            onPress={() => setKind('reversal')}
            testID="correction-kind-reversal"
          />
          <Chip
            label="Sales return"
            selected={kind === 'sales_return'}
            onPress={() => setKind('sales_return')}
            testID="correction-kind-return"
          />
        </View>
        {!canReverse ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            Cancelling is only for a bill issued today that has not been corrected before. Use a sales
            return instead.
          </AppText>
        ) : null}

        {kind === 'reversal' ? (
          <View style={{ gap: theme.spacing[3] }}>
            <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
              Cancels the whole bill. It stays on record, marked cancelled, with this reverse entry.
            </AppText>
            <Chip
              label="Re-open items on a new tab"
              selected={reopen}
              onPress={() => setReopen((v) => !v)}
              testID="correction-reopen"
            />
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              For a bill closed wrong (wrong payment method, table or buyer): the same items go on a
              new tab to settle again{reopen ? ', and you land on it' : ''}.
            </AppText>
          </View>
        ) : (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">What is being returned</AppText>
            {inv.lines.map((l) => {
              const max = left(l.line_no, l.qty);
              const v = qty[l.line_no] ?? 0;
              const done = returned.get(l.line_no) ?? 0;
              return (
                <View
                  key={l.line_no}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText numberOfLines={2}>{l.description}</AppText>
                    <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
                      billed {fmtQty(l.qty)}
                      {done ? `, returned ${fmtQty(String(done))}` : ''} · {formatNPR(l.amount_cents)}
                    </AppText>
                  </View>
                  <Stepper
                    value={v}
                    min={0}
                    max={max}
                    disabled={max === 0}
                    label={l.description}
                    format={(n) => fmtQty(String(n))}
                    onIncrement={() => setQty({ ...qty, [l.line_no]: Math.min(max, v + 1) })}
                    onDecrement={() => setQty({ ...qty, [l.line_no]: Math.max(0, v - 1) })}
                  />
                </View>
              );
            })}
          </View>
        )}

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Reason</AppText>
          <AppSheet.TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. dish returned cold"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="correction-reason"
            maxLength={300}
            style={fieldStyle(theme)}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
            {QUICK_REASONS.map((r) => (
              <Chip key={r} label={r} selected={reason === r} onPress={() => setReason(r)} />
            ))}
          </View>
        </View>

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Refund</AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
            <Chip label="Cash from drawer" selected={refund === 'cash'} onPress={() => setRefund('cash')} testID="refund-cash" />
            <Chip label="Online" selected={refund === 'online'} onPress={() => setRefund('online')} testID="refund-online" />
            <Chip
              label="Reduce credit account"
              selected={refund === 'credit'}
              disabled={!paidOnCredit}
              onPress={() => setRefund('credit')}
              testID="refund-credit"
            />
          </View>
          {refund === 'online' ? (
            <AppSheet.TextInput
              value={ref}
              onChangeText={setRef}
              placeholder="Refund transaction reference (optional)"
              placeholderTextColor={theme.colors.textFaint}
              accessibilityLabel="refund-reference"
              maxLength={120}
              style={fieldStyle(theme)}
            />
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <AppText variant="muted">{kind === 'reversal' ? 'Refund' : 'Refund (estimate)'}</AppText>
          <MonoText weight="bold">{formatNPR(estimate)}</MonoText>
        </View>
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function fmtQty(q: string): string {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function fieldStyle(theme: Theme) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaces[2],
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
  };
}
