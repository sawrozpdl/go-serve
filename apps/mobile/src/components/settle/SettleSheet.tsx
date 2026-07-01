/**
 * Settle a tab: collect payment(s), optionally discount, then close. Payments
 * are recorded one at a time (supports splits); the tab closes only when the
 * balance hits zero. On close, prints a customer receipt if this device is a
 * receipt station. All money ops are blocked while offline.
 */
import { useState } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Banknote, Smartphone, BookUser, Trash2, ArrowLeftRight, Percent } from 'lucide-react-native';
import { computeReceiptTotals } from '@cafe-mgmt/receipt-format';
import type { Payment } from '@cafe-mgmt/api-types';
import { Sheet } from '../ui/Sheet';
import { AppText } from '../ui/Text';
import { Button } from '../ui/Button';
import { useTheme } from '../../theme';
import { formatNPR } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useMe } from '../../api/auth';
import { can } from '../../auth/permissions';
import { useOrder, useSettleQuote } from '../../api/orders';
import { useTenantSettings } from '../../api/tenant';
import { useHouseTabs } from '../../api/houseTabs';
import {
  useOrderPayments,
  useRecordPayment,
  useDeletePayment,
  useReclassifyPayment,
  useApplyAdjustment,
  useCloseOrder,
} from '../../api/settle';
import { useConnectivity } from '../../stores/connectivity';
import { usePrintConfig } from '../../printing/printerConfig';
import { shouldPrintReceipt, printReceipt } from '../../printing/receipt';

type UIMethod = 'cash' | 'online' | 'house_tab';

function parsePrice(s: string): number {
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function SettleSheet({
  open,
  orderId,
  tableLabel,
  onClose,
  onClosed,
}: {
  open: boolean;
  orderId: string;
  tableLabel: string;
  onClose: () => void;
  onClosed: () => void;
}) {
  const theme = useTheme();
  const offline = useConnectivity((s) => s.mode === 'offline');
  const me = useMe();
  const order = useOrder(open ? orderId : undefined);
  const quote = useSettleQuote(open ? orderId : undefined);
  const payments = useOrderPayments(open ? orderId : undefined);
  const houseTabs = useHouseTabs();
  const settings = useTenantSettings();
  const prefs = settings.data?.preferences;

  const record = useRecordPayment();
  const removePayment = useDeletePayment();
  const reclassify = useReclassifyPayment();
  const applyAdj = useApplyAdjustment();
  const closeOrder = useCloseOrder();

  const role = usePrintConfig((s) => s.role);
  const receiptPrinter = usePrintConfig((s) => s.receiptPrinter);

  const canDiscount = can(me.data, 'adjustment:apply');
  const requireTxnRef = prefs?.requireTxnRef ?? false;

  const [amountStr, setAmountStr] = useState('');
  const [refNo, setRefNo] = useState('');
  const [houseTabId, setHouseTabId] = useState('');
  const [tab, setTab] = useState<UIMethod | null>(null); // which method's extra input is open
  const [discAmt, setDiscAmt] = useState('');
  const [discPct, setDiscPct] = useState(false);
  const [showDisc, setShowDisc] = useState(false);

  const q = quote.data;
  const balance = q?.balance_cents ?? 0;
  const subtotal = q?.subtotal_cents ?? 0;
  const canClose = subtotal > 0 && balance === 0;
  const overpaid = balance < 0;
  const totals = q ? computeReceiptTotals(q) : null;

  async function doRecord(method: UIMethod) {
    if (offline) return toast.error('Offline', 'Settling needs a connection.');
    const cents = amountStr.trim() ? parsePrice(amountStr) : balance;
    if (cents <= 0) return toast.error('Enter an amount');
    if (cents > balance) return toast.error(`That's more than the ${formatNPR(balance)} balance`);
    if (method === 'house_tab' && !houseTabId) {
      setTab('house_tab');
      return;
    }
    void Haptics.selectionAsync();
    try {
      await record.mutateAsync({
        orderId,
        method,
        amount_cents: cents,
        reference_no: refNo.trim() || undefined,
        house_tab_id: method === 'house_tab' ? houseTabId : undefined,
      });
      setAmountStr('');
      setRefNo('');
      setHouseTabId('');
      setTab(null);
    } catch (e) {
      toast.error('Could not record payment', (e as Error).message);
    }
  }

  async function onCash() {
    await doRecord('cash');
  }
  async function onOnline() {
    if (requireTxnRef && tab !== 'online') return setTab('online');
    await doRecord('online');
  }

  async function applyDiscount() {
    const cents = discPct
      ? Math.round((subtotal * (parseFloat(discAmt) || 0)) / 100)
      : parsePrice(discAmt);
    if (cents <= 0) return toast.error('Discount must be greater than zero');
    try {
      await applyAdj.mutateAsync({ orderId, type: 'discount', amount_cents: cents, reason: 'regular' });
      setDiscAmt('');
      setShowDisc(false);
    } catch (e) {
      toast.error('Could not apply discount', (e as Error).message);
    }
  }

  async function onCloseTab() {
    if (offline) return toast.error('Offline', 'Closing a tab needs a connection.');
    if (!q) return;
    // Snapshot receipt BEFORE close (close finalizes totals + refetches).
    const snap = {
      items: order.data?.items ?? [],
      quote: q,
      payments: (payments.data ?? []) as Payment[],
      tableLabel,
      header: (prefs?.receiptHeader || settings.data?.name || '').trim(),
      footer: (prefs?.receiptFooter || '').trim(),
      orderId,
      closedAt: new Date().toISOString(),
    };
    try {
      await closeOrder.mutateAsync(orderId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success('Tab settled', formatNPR(q.total_cents));
      if (shouldPrintReceipt(prefs, role) && receiptPrinter) {
        try {
          await printReceipt(snap, receiptPrinter);
        } catch (e) {
          toast.error('Settled, but receipt failed', (e as Error).message);
        }
      }
      onClosed();
    } catch (e) {
      toast.error('Could not close', (e as Error).message);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Settle" full>
      <ScrollView contentContainerStyle={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[6], gap: theme.spacing[4] }}>
        {/* Totals */}
        {totals ? (
          <View style={{ backgroundColor: theme.colors.card, borderRadius: theme.radii.lg, padding: theme.spacing[4], gap: theme.spacing[2], ...theme.elevation.card }}>
            {totals.rows.map((r, i) => (
              <Row key={i} label={r.label} value={formatNPR(r.cents)} muted />
            ))}
            <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: theme.spacing[1] }} />
            <Row label="Total" value={formatNPR(totals.totalCents)} strong />
            {totals.showPaid ? <Row label="Paid" value={formatNPR(totals.paidCents)} muted /> : null}
            <Row
              label={overpaid ? 'Overpaid' : 'Balance due'}
              value={formatNPR(Math.abs(balance))}
              strong
              color={balance === 0 ? theme.colors.successFg : theme.colors.primary}
            />
          </View>
        ) : (
          <AppText variant="muted">Loading…</AppText>
        )}

        {/* Payments taken */}
        {(payments.data ?? []).length > 0 ? (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Payments</AppText>
            {(payments.data ?? []).map((p) => (
              <PaymentRow
                key={p.id}
                payment={p}
                onDelete={() => removePayment.mutate({ orderId, paymentId: p.id })}
                onReclassify={
                  p.method === 'house_tab'
                    ? undefined
                    : () =>
                        reclassify.mutate({
                          orderId,
                          paymentId: p.id,
                          method: p.method === 'cash' ? 'online' : 'cash',
                        })
                }
              />
            ))}
          </View>
        ) : null}

        {/* Discount */}
        {canDiscount && !canClose ? (
          <View style={{ gap: theme.spacing[2] }}>
            {showDisc ? (
              <View style={{ gap: theme.spacing[2] }}>
                <View style={{ flexDirection: 'row', gap: theme.spacing[2], alignItems: 'center' }}>
                  <Pressable onPress={() => setDiscPct(false)} accessibilityLabel="discount-flat" style={chip(theme, !discPct)}>
                    <AppText style={{ color: !discPct ? theme.colors.primary : theme.colors.textMuted }}>Rs</AppText>
                  </Pressable>
                  <Pressable onPress={() => setDiscPct(true)} accessibilityLabel="discount-pct" style={chip(theme, discPct)}>
                    <Percent size={14} color={discPct ? theme.colors.primary : theme.colors.textMuted} />
                  </Pressable>
                  <TextInput
                    value={discAmt}
                    onChangeText={setDiscAmt}
                    keyboardType="decimal-pad"
                    placeholder={discPct ? '10' : '100'}
                    placeholderTextColor={theme.colors.textFaint}
                    accessibilityLabel="discount-amount"
                    style={inputStyle(theme, { flex: 1 })}
                  />
                  <View style={{ width: 96 }}>
                    <Button title="Apply" onPress={applyDiscount} loading={applyAdj.isPending} />
                  </View>
                </View>
              </View>
            ) : (
              <Pressable onPress={() => setShowDisc(true)} accessibilityLabel="add-discount" hitSlop={6}>
                <AppText style={{ color: theme.colors.primary, fontFamily: theme.fonts.bodySemi }}>+ Add discount</AppText>
              </Pressable>
            )}
          </View>
        ) : null}

        {/* Take a payment */}
        {!canClose ? (
          <View style={{ gap: theme.spacing[3] }}>
            <AppText variant="label">Take payment</AppText>
            <TextInput
              value={amountStr}
              onChangeText={setAmountStr}
              keyboardType="decimal-pad"
              placeholder={`Full balance · ${formatNPR(balance)}`}
              placeholderTextColor={theme.colors.textFaint}
              accessibilityLabel="pay-amount"
              editable={!offline}
              style={inputStyle(theme, { fontSize: 20 })}
            />
            {tab === 'online' ? (
              <TextInput
                value={refNo}
                onChangeText={setRefNo}
                placeholder="Transaction reference"
                placeholderTextColor={theme.colors.textFaint}
                accessibilityLabel="txn-ref"
                autoFocus
                style={inputStyle(theme)}
              />
            ) : null}
            {tab === 'house_tab' ? (
              <View style={{ gap: theme.spacing[2] }}>
                {(houseTabs.data ?? []).filter((t) => t.is_active).map((t) => (
                  <Pressable
                    key={t.id}
                    accessibilityLabel={`housetab-${t.id}`}
                    onPress={() => setHouseTabId(t.id)}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      padding: theme.spacing[3],
                      borderRadius: theme.radii.md,
                      borderWidth: 1,
                      borderColor: houseTabId === t.id ? theme.colors.primary : theme.colors.border,
                      backgroundColor: houseTabId === t.id ? theme.colors.primaryWash : 'transparent',
                    }}
                  >
                    <AppText>{t.name}</AppText>
                    <AppText variant="faint">{formatNPR(t.balance_cents)} owed</AppText>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
              <Tender icon="cash" label="Cash" onPress={onCash} disabled={offline} loading={record.isPending && tab !== 'house_tab'} />
              <Tender icon="online" label="Online" onPress={onOnline} disabled={offline} />
              <Tender icon="house" label="House tab" onPress={() => doRecord('house_tab')} disabled={offline} />
            </View>
          </View>
        ) : null}
      </ScrollView>

      {/* Close */}
      <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
        {offline ? (
          <AppText style={{ color: theme.colors.dangerFg, textAlign: 'center', marginBottom: theme.spacing[2] }}>
            You&apos;re offline — settling is paused until you reconnect.
          </AppText>
        ) : null}
        <Button
          title={overpaid ? 'Remove a payment to close' : canClose ? 'Close tab' : `Collect ${formatNPR(balance)} to close`}
          onPress={onCloseTab}
          disabled={!canClose || offline}
          loading={closeOrder.isPending}
        />
      </View>
    </Sheet>
  );
}

function Row({ label, value, strong, muted, color }: { label: string; value: string; strong?: boolean; muted?: boolean; color?: string }) {
  const theme = useTheme();
  const fam = strong ? theme.fonts.bodyBold : theme.fonts.body;
  const c = color ?? (muted ? theme.colors.textMuted : theme.colors.text);
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <AppText style={{ color: c, fontFamily: fam }}>{label}</AppText>
      <AppText style={{ color: c, fontFamily: fam }}>{value}</AppText>
    </View>
  );
}

function PaymentRow({ payment, onDelete, onReclassify }: { payment: Payment; onDelete: () => void; onReclassify?: () => void }) {
  const theme = useTheme();
  const label =
    payment.method === 'house_tab'
      ? `House tab${payment.house_tab_name ? ` · ${payment.house_tab_name}` : ''}`
      : payment.method === 'cash'
        ? 'Cash'
        : 'Online';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3], backgroundColor: theme.colors.card, borderRadius: theme.radii.md, padding: theme.spacing[3] }}>
      <AppText style={{ flex: 1, fontFamily: theme.fonts.bodyMedium }}>{label}</AppText>
      <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{formatNPR(payment.amount_cents)}</AppText>
      {onReclassify ? (
        <Pressable onPress={onReclassify} hitSlop={6} accessibilityLabel="reclassify-payment">
          <ArrowLeftRight size={16} color={theme.colors.textFaint} />
        </Pressable>
      ) : null}
      <Pressable onPress={onDelete} hitSlop={6} accessibilityLabel="delete-payment">
        <Trash2 size={16} color={theme.colors.dangerFg} />
      </Pressable>
    </View>
  );
}

function Tender({ icon, label, onPress, disabled, loading }: { icon: 'cash' | 'online' | 'house'; label: string; onPress: () => void; disabled?: boolean; loading?: boolean }) {
  const theme = useTheme();
  const Ico = icon === 'cash' ? Banknote : icon === 'online' ? Smartphone : BookUser;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`tender-${icon}`}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        gap: 4,
        paddingVertical: theme.spacing[4],
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.card,
        opacity: disabled ? 0.5 : pressed ? 0.9 : 1,
        ...theme.elevation.card,
      })}
    >
      <Ico size={22} color={theme.colors.primary} />
      <AppText style={{ fontSize: theme.text.sm, fontFamily: theme.fonts.bodyMedium }}>{label}</AppText>
    </Pressable>
  );
}

function chip(theme: ReturnType<typeof useTheme>, active: boolean) {
  return {
    width: 44,
    height: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: active ? theme.colors.primary : theme.colors.border,
    backgroundColor: active ? theme.colors.primaryWash : 'transparent',
  };
}

function inputStyle(theme: ReturnType<typeof useTheme>, extra?: object) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...extra,
  };
}
