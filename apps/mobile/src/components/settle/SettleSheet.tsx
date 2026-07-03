/**
 * Settle a tab: collect payment(s), optionally discount, then close. Payments
 * are recorded one at a time (supports splits); the tab closes only when the
 * balance hits zero. On close, prints a customer receipt if this device is a
 * receipt station. All money ops are blocked while offline.
 *
 * Built on AppSheet so the amount field's keyboard is tracked (the money-field
 * keyboard defect) — every input here is an AppSheet.TextInput / AmountInput.
 */
import { useState, type ReactNode } from 'react';
import { View, Pressable } from 'react-native';
import { haptics } from '../../lib/haptics';
import {
  Banknote,
  Smartphone,
  BookUser,
  Trash2,
  ArrowLeftRight,
  Percent,
  Plus,
} from 'lucide-react-native';
import { computeReceiptTotals } from '@cafe-mgmt/receipt-format';
import type { Payment, HouseTab } from '@cafe-mgmt/api-types';
import { AppSheet } from '../ui/AppSheet';
import { AppText, MonoText } from '../ui/Text';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { Stamp } from '../ui/Stamp';
import { ListRow } from '../ui/ListRow';
import { AmountInput } from '../ui/AmountInput';
import { DottedLeader } from '../ui/DottedLeader';
import { Perforation } from '../ui/Perforation';
import { useTheme, type Theme } from '../../theme';
import { formatNPR } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useMe } from '../../api/auth';
import { can } from '../../auth/permissions';
import { useOrder, useSettleQuote } from '../../api/orders';
import { useTenantSettings } from '../../api/tenant';
import { useHouseTabs, useCreateHouseTab } from '../../api/houseTabs';
import {
  useOrderPayments,
  useRecordPayment,
  useDeletePayment,
  useReclassifyPayment,
  useApplyAdjustment,
  useCloseOrder,
} from '../../api/settle';
import { useConnectivity } from '../../stores/connectivity';
import { receiptTargets } from '../../printing/printerConfig';
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

  const receiptPrinters = receiptTargets(prefs);

  const canDiscount = can(me.data, 'adjustment:apply');
  const requireTxnRef = prefs?.requireTxnRef ?? false;

  const [amountCents, setAmountCents] = useState(0);
  const [refNo, setRefNo] = useState('');
  const [houseTabId, setHouseTabId] = useState('');
  const [tab, setTab] = useState<UIMethod | null>(null); // which method's extra input is open
  const [discAmt, setDiscAmt] = useState('');
  const [discPct, setDiscPct] = useState(false);
  const [showDisc, setShowDisc] = useState(false);
  const [showNewTab, setShowNewTab] = useState(false);

  const q = quote.data;
  const balance = q?.balance_cents ?? 0;
  const subtotal = q?.subtotal_cents ?? 0;
  const canClose = subtotal > 0 && balance === 0;
  const overpaid = balance < 0;
  const totals = q ? computeReceiptTotals(q) : null;

  async function doRecord(method: UIMethod) {
    if (offline) return toast.error('Offline', 'Settling needs a connection.');
    const cents = amountCents > 0 ? amountCents : balance;
    if (cents <= 0) return toast.error('Enter an amount');
    if (cents > balance) return toast.error(`That's more than the ${formatNPR(balance)} balance`);
    if (method === 'house_tab' && !houseTabId) {
      setTab('house_tab');
      return;
    }
    haptics.selection();
    try {
      await record.mutateAsync({
        orderId,
        method,
        amount_cents: cents,
        reference_no: refNo.trim() || undefined,
        house_tab_id: method === 'house_tab' ? houseTabId : undefined,
      });
      setAmountCents(0);
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
      await applyAdj.mutateAsync({
        orderId,
        type: 'discount',
        amount_cents: cents,
        reason: 'regular',
      });
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
      haptics.notifySuccess();
      toast.success('Tab settled', formatNPR(q.total_cents));
      if (shouldPrintReceipt(prefs) && receiptPrinters.length > 0) {
        try {
          for (const printer of receiptPrinters) {
            await printReceipt(snap, printer);
          }
        } catch (e) {
          toast.error('Settled, but receipt failed', (e as Error).message);
        }
      }
      onClosed();
    } catch (e) {
      toast.error('Could not close', (e as Error).message);
    }
  }

  const closeLabel = overpaid
    ? 'Remove a payment to close'
    : canClose
      ? 'Close tab'
      : `Collect ${formatNPR(balance)} to close`;

  return (
    <>
      <AppSheet
        open={open}
        onClose={onClose}
        title="Settle"
        full
        footer={
          <View
            style={{
              paddingHorizontal: theme.spacing[5],
              paddingTop: theme.spacing[2],
              gap: theme.spacing[2],
            }}
          >
            {offline ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing[2],
                  justifyContent: 'center',
                }}
              >
                <Stamp tone="danger" label="Offline" size="sm" />
                <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
                  Settling is paused until you reconnect.
                </AppText>
              </View>
            ) : null}
            <Button
              title={closeLabel}
              onPress={onCloseTab}
              disabled={!canClose || offline}
              loading={closeOrder.isPending}
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
          {/* Totals — receipt card */}
          {totals ? (
            <Card level={2} padded style={{ overflow: 'hidden', gap: theme.spacing[2] }}>
              {totals.rows.map((r, i) => (
                <ReceiptRow key={i} label={r.label} value={formatNPR(r.cents)} theme={theme} />
              ))}
              <Perforation />
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                }}
              >
                <MonoText size="2xs" muted style={{ letterSpacing: 1.6 }}>
                  TOTAL
                </MonoText>
                <MonoText size="display" weight="bold">
                  {formatNPR(totals.totalCents)}
                </MonoText>
              </View>
              {totals.showPaid ? (
                <ReceiptRow label="Paid" value={formatNPR(totals.paidCents)} theme={theme} />
              ) : null}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                }}
              >
                <MonoText size="2xs" muted style={{ letterSpacing: 1.6 }}>
                  {overpaid ? 'OVERPAID' : 'BALANCE DUE'}
                </MonoText>
                <MonoText
                  weight="bold"
                  size="xl"
                  style={{
                    color: balance === 0 ? theme.colors.successFg : theme.colors.stamp.brand.fg,
                  }}
                >
                  {formatNPR(Math.abs(balance))}
                </MonoText>
              </View>
            </Card>
          ) : (
            <AppText variant="muted">Loading…</AppText>
          )}

          {/* Payments taken */}
          {(payments.data ?? []).length > 0 ? (
            <View style={{ gap: theme.spacing[2] }}>
              <AppText variant="label">Payments</AppText>
              {(payments.data ?? []).map((p) => (
                <ListRow
                  key={p.id}
                  title={paymentLabel(p)}
                  value={formatNPR(p.amount_cents)}
                  right={
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}
                    >
                      {p.method !== 'house_tab' ? (
                        <IconBtn
                          label="reclassify-payment"
                          onPress={() =>
                            reclassify.mutate({
                              orderId,
                              paymentId: p.id,
                              method: p.method === 'cash' ? 'online' : 'cash',
                            })
                          }
                        >
                          <ArrowLeftRight size={16} color={theme.colors.textFaint} />
                        </IconBtn>
                      ) : null}
                      <IconBtn
                        label="delete-payment"
                        onPress={() => removePayment.mutate({ orderId, paymentId: p.id })}
                      >
                        <Trash2 size={16} color={theme.colors.dangerFg} />
                      </IconBtn>
                    </View>
                  }
                />
              ))}
            </View>
          ) : null}

          {/* Discount */}
          {canDiscount && !canClose ? (
            <View style={{ gap: theme.spacing[2] }}>
              {showDisc ? (
                <View style={{ flexDirection: 'row', gap: theme.spacing[2], alignItems: 'center' }}>
                  <Chip
                    label="Rs"
                    selected={!discPct}
                    onPress={() => setDiscPct(false)}
                    testID="discount-flat"
                  />
                  <Chip
                    label="%"
                    selected={discPct}
                    onPress={() => setDiscPct(true)}
                    icon={
                      <Percent
                        size={13}
                        color={discPct ? theme.colors.stamp.brand.fg : theme.colors.textMuted}
                      />
                    }
                    testID="discount-pct"
                  />
                  <AppSheet.TextInput
                    value={discAmt}
                    onChangeText={setDiscAmt}
                    keyboardType="decimal-pad"
                    placeholder={discPct ? '10' : '100'}
                    placeholderTextColor={theme.colors.textFaint}
                    accessibilityLabel="discount-amount"
                    style={fieldStyle(theme, { flex: 1 })}
                  />
                  <View style={{ width: 92 }}>
                    <Button title="Apply" onPress={applyDiscount} loading={applyAdj.isPending} />
                  </View>
                </View>
              ) : (
                <Chip
                  label="+ Add discount"
                  onPress={() => setShowDisc(true)}
                  testID="add-discount"
                />
              )}
            </View>
          ) : null}

          {/* Take a payment */}
          {!canClose ? (
            <View style={{ gap: theme.spacing[3] }}>
              <AmountInput
                label="Take payment"
                valueCents={amountCents}
                onChangeCents={setAmountCents}
                placeholderCents={balance}
                quickAmounts={balance > 0 ? [balance] : undefined}
                formatAmount={() => `Full balance · ${formatNPR(balance)}`}
                disabled={offline}
                insideSheet
                autoFocus
                testID="pay-amount"
              />
              {tab === 'online' ? (
                <AppSheet.TextInput
                  value={refNo}
                  onChangeText={setRefNo}
                  placeholder="Transaction reference"
                  placeholderTextColor={theme.colors.textFaint}
                  accessibilityLabel="txn-ref"
                  autoFocus
                  style={fieldStyle(theme)}
                />
              ) : null}
              {tab === 'house_tab' ? (
                <View style={{ gap: theme.spacing[2] }}>
                  {(houseTabs.data ?? [])
                    .filter((t) => t.is_active)
                    .map((t) => (
                      <Card
                        key={t.id}
                        level={2}
                        selected={houseTabId === t.id}
                        onPress={() => setHouseTabId(t.id)}
                        accessibilityLabel={`housetab-${t.id}`}
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{t.name}</AppText>
                        <MonoText size="sm" muted>
                          {formatNPR(t.balance_cents)} owed
                        </MonoText>
                      </Card>
                    ))}
                  <Chip
                    label="+ New house tab"
                    icon={<Plus size={13} color={theme.colors.textMuted} />}
                    onPress={() => setShowNewTab(true)}
                    testID="new-house-tab"
                  />
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
                <TenderCard
                  icon="cash"
                  label="Cash"
                  onPress={onCash}
                  disabled={offline}
                  loading={record.isPending && tab !== 'house_tab'}
                />
                <TenderCard
                  icon="online"
                  label="Online"
                  selected={tab === 'online'}
                  onPress={onOnline}
                  disabled={offline}
                />
                <TenderCard
                  icon="house"
                  label="House tab"
                  selected={tab === 'house_tab'}
                  onPress={() => doRecord('house_tab')}
                  disabled={offline}
                />
              </View>
            </View>
          ) : null}
        </AppSheet.ScrollView>
      </AppSheet>

      <NewHouseTabSheet
        open={showNewTab}
        onClose={() => setShowNewTab(false)}
        onCreated={(created) => {
          setHouseTabId(created.id);
          setShowNewTab(false);
        }}
      />
    </>
  );
}

function NewHouseTabSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (tab: HouseTab) => void;
}) {
  const theme = useTheme();
  const create = useCreateHouseTab();
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [openingCents, setOpeningCents] = useState(0);

  const reset = () => {
    setName('');
    setNotes('');
    setOpeningCents(0);
  };

  async function submit() {
    if (!name.trim()) return;
    try {
      const tab = await create.mutateAsync({
        name: name.trim(),
        notes: notes.trim() || undefined,
        opening_balance_cents: openingCents > 0 ? openingCents : undefined,
      });
      reset();
      onCreated(tab);
    } catch (e) {
      toast.error('Could not create tab', (e as Error).message);
    }
  }

  return (
    <AppSheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New house tab"
    >
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3] }}>
        <AppSheet.TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Ram, Staff meals, Supplier loan"
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel="new-house-tab-name"
          autoFocus
          style={fieldStyle(theme)}
        />
        <AppSheet.TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Notes (optional)"
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel="new-house-tab-notes"
          style={fieldStyle(theme)}
        />
        <AmountInput
          label="Opening balance owed (optional)"
          valueCents={openingCents}
          onChangeCents={setOpeningCents}
          insideSheet
          testID="new-house-tab-opening-balance"
        />
        <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
          If this customer already owed you money before you started using this app, enter it here
          — it&apos;ll show up as the tab&apos;s starting balance.
        </AppText>
        <Button
          title="Create tab"
          onPress={submit}
          loading={create.isPending}
          disabled={!name.trim()}
        />
      </View>
    </AppSheet>
  );
}

function paymentLabel(p: Payment): string {
  return p.method === 'house_tab'
    ? `House tab${p.house_tab_name ? ` · ${p.house_tab_name}` : ''}`
    : p.method === 'cash'
      ? 'Cash'
      : 'Online';
}

function ReceiptRow({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
      <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
        {label}
      </AppText>
      <DottedLeader />
      <MonoText size="sm" muted>
        {value}
      </MonoText>
    </View>
  );
}

function IconBtn({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityLabel={label} style={{ padding: 4 }}>
      {children}
    </Pressable>
  );
}

function TenderCard({
  icon,
  label,
  selected,
  onPress,
  disabled,
  loading,
}: {
  icon: 'cash' | 'online' | 'house';
  label: string;
  selected?: boolean;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const theme = useTheme();
  const Ico = icon === 'cash' ? Banknote : icon === 'online' ? Smartphone : BookUser;
  return (
    <View style={{ flex: 1 }}>
      <Card
        level={2}
        selected={selected}
        onPress={onPress}
        disabled={disabled || loading}
        accessibilityLabel={`tender-${icon}`}
        style={{
          minHeight: 64,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Ico size={22} color={theme.colors.stamp.brand.fg} />
        <AppText style={{ fontSize: theme.text.sm, fontFamily: theme.fonts.bodyMedium }}>
          {label}
        </AppText>
      </Card>
    </View>
  );
}

function fieldStyle(theme: Theme, extra?: object) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaces[2],
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...extra,
  };
}
