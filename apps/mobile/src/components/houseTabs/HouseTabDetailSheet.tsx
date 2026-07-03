/**
 * HouseTabDetailSheet — a stakeholder ledger: charged/settled/balance totals,
 * a settle form (cash/online, amount with auto-fill-remaining, txn reference
 * for online, notes), the charges + settlements history, and footer actions
 * (archive/reactivate/delete). Mirrors web's HouseTabsPage DetailModal.
 */
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { Archive, RefreshCw, Trash2 } from 'lucide-react-native';
import type { PaymentMethod } from '@cafe-mgmt/api-types';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { Section } from '@/components/ui/Section';
import { AmountInput } from '@/components/ui/AmountInput';
import { DottedLeader } from '@/components/ui/DottedLeader';
import { useTheme, type Theme } from '@/theme';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useConnectivity } from '@/stores/connectivity';
import {
  useHouseTab,
  useUpdateHouseTab,
  useDeleteHouseTab,
  useCreateHouseTabSettlement,
} from '@/api/houseTabs';

type SettleMethod = 'cash' | 'online';

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export function HouseTabDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const theme = useTheme();
  const me = useMe();
  const offline = useConnectivity((s) => s.mode === 'offline');
  const detail = useHouseTab(id ?? undefined);
  const update = useUpdateHouseTab();
  const del = useDeleteHouseTab();
  const settle = useCreateHouseTabSettlement();

  const [method, setMethod] = useState<SettleMethod>('cash');
  const [amountCents, setAmountCents] = useState(0);
  const [refNo, setRefNo] = useState('');
  const [notes, setNotes] = useState('');

  const t = detail.data?.house_tab;
  const balance = t?.balance_cents ?? 0;

  async function onSettle() {
    if (offline) return toast.error('Offline', 'Settling needs a connection.');
    if (!t) return;
    const cents = amountCents > 0 ? amountCents : balance;
    if (cents <= 0) return toast.error('Enter an amount');
    if (cents > balance) return toast.error(`That's more than the ${formatNPR(balance)} balance`);
    try {
      await settle.mutateAsync({
        id: t.id,
        amount_cents: cents,
        payment_method: method as PaymentMethod,
        reference_no: refNo.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success('Settlement recorded', formatNPR(cents));
      setAmountCents(0);
      setRefNo('');
      setNotes('');
    } catch (e) {
      toast.error('Could not record settlement', (e as Error).message);
    }
  }

  async function toggleActive() {
    if (offline) return toast.error('Offline', 'This needs a connection.');
    if (!t) return;
    try {
      await update.mutateAsync({ id: t.id, patch: { is_active: !t.is_active } });
      toast.success(t.is_active ? 'Tab archived' : 'Tab reactivated');
    } catch (e) {
      toast.error('Could not update tab', (e as Error).message);
    }
  }

  function confirmDelete() {
    if (!t) return;
    Alert.alert(
      'Delete this tab?',
      `Permanently remove "${t.name}" and its full ledger history. Can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (offline) return toast.error('Offline', 'Deleting needs a connection.');
            try {
              await del.mutateAsync(t.id);
              toast.success('Tab deleted');
              onClose();
            } catch (e) {
              toast.error('Could not delete tab', (e as Error).message);
            }
          },
        },
      ],
    );
  }

  const canSettle = can(me.data, 'house_tab:settle');
  const canUpdate = can(me.data, 'house_tab:update');
  const canDelete = can(me.data, 'house_tab:delete');

  return (
    <AppSheet
      open={!!id}
      onClose={onClose}
      title={t?.name ?? 'Tab'}
      full
      footer={
        canUpdate || canDelete ? (
          <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
            {canUpdate && t ? (
              <Button
                title={t.is_active ? 'Archive' : 'Reactivate'}
                variant="secondary"
                icon={
                  t.is_active ? (
                    <Archive size={16} color={theme.colors.text} />
                  ) : (
                    <RefreshCw size={16} color={theme.colors.text} />
                  )
                }
                onPress={toggleActive}
                loading={update.isPending}
                disabled={offline}
              />
            ) : null}
            {canDelete && t ? (
              <Button
                title="Delete tab"
                variant="danger"
                icon={<Trash2 size={16} color="#fff" />}
                onPress={confirmDelete}
                loading={del.isPending}
                disabled={balance !== 0 || offline}
              />
            ) : null}
          </View>
        ) : undefined
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[6],
          gap: theme.spacing[5],
        }}
      >
        {detail.isPending ? (
          <AppText variant="muted">Loading…</AppText>
        ) : !t ? (
          <AppText variant="muted">Couldn&apos;t load this tab.</AppText>
        ) : (
          <>
            <View style={{ gap: theme.spacing[2] }}>
              <LedgerRow label="Charged (orders posted to this tab)" value={formatNPR(t.charged_cents)} theme={theme} />
              <LedgerRow
                label="Settled (paid down)"
                value={`−${formatNPR(t.settled_cents)}`}
                theme={theme}
                tone="success"
              />
              <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: theme.spacing[1] }} />
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <MonoText size="2xs" muted style={{ letterSpacing: 1.4 }}>
                  BALANCE OWED
                </MonoText>
                <MonoText
                  weight="bold"
                  size="xl"
                  style={{ color: balance > 0 ? theme.colors.stamp.brand.fg : theme.colors.successFg }}
                >
                  {formatNPR(balance)}
                </MonoText>
              </View>
            </View>

            {t.notes ? <AppText variant="muted">{t.notes}</AppText> : null}

            {balance > 0 && t.is_active && canSettle ? (
              <View style={{ gap: theme.spacing[3] }}>
                <AppText variant="label">Record settlement</AppText>
                <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
                  <Chip label="Cash" selected={method === 'cash'} onPress={() => setMethod('cash')} />
                  <Chip label="Online" selected={method === 'online'} onPress={() => setMethod('online')} />
                </View>
                <AmountInput
                  valueCents={amountCents}
                  onChangeCents={setAmountCents}
                  placeholderCents={balance}
                  quickAmounts={[balance]}
                  formatAmount={() => `Full balance · ${formatNPR(balance)}`}
                  insideSheet
                  disabled={offline}
                  testID="settle-amount"
                />
                {method === 'online' ? (
                  <AppSheet.TextInput
                    value={refNo}
                    onChangeText={setRefNo}
                    placeholder="Txn reference"
                    placeholderTextColor={theme.colors.textFaint}
                    accessibilityLabel="settle-ref"
                    style={fieldStyle(theme)}
                  />
                ) : null}
                <AppSheet.TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Notes (optional)"
                  placeholderTextColor={theme.colors.textFaint}
                  accessibilityLabel="settle-notes"
                  style={fieldStyle(theme)}
                />
                <Button
                  title="Record settlement"
                  onPress={onSettle}
                  loading={settle.isPending}
                  disabled={offline}
                />
              </View>
            ) : balance === 0 && t.is_active ? (
              <AppText variant="muted">
                Tab is fully settled. Archive it if it&apos;s no longer in use, or leave it open
                for the next charge.
              </AppText>
            ) : null}

            <Section title="Charges" count={detail.data?.charges.length}>
              {(detail.data?.charges.length ?? 0) === 0 ? (
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  No orders charged to this tab yet.
                </AppText>
              ) : (
                <View style={{ gap: theme.spacing[2] }}>
                  {detail.data!.charges.map((c) => (
                    <View
                      key={c.payment_id}
                      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <View style={{ flex: 1 }}>
                        <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>
                          {c.is_opening_balance ? 'Opening balance' : (c.service_table_name ?? 'take-away')}
                        </AppText>
                        <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
                          {shortDate(c.recorded_at)}
                        </AppText>
                      </View>
                      <MonoText style={{ color: theme.colors.stamp.brand.fg }}>
                        +{formatNPR(c.amount_cents)}
                      </MonoText>
                    </View>
                  ))}
                </View>
              )}
            </Section>

            <Section title="Settlements" count={detail.data?.settlements.length}>
              {(detail.data?.settlements.length ?? 0) === 0 ? (
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  No settlements yet.
                </AppText>
              ) : (
                <View style={{ gap: theme.spacing[2] }}>
                  {detail.data!.settlements.map((s) => (
                    <View
                      key={s.id}
                      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <View style={{ flex: 1 }}>
                        <AppText style={{ fontFamily: theme.fonts.bodyMedium, textTransform: 'capitalize' }}>
                          {s.payment_method}
                          {s.reference_no ? ` · ${s.reference_no}` : ''}
                        </AppText>
                        <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
                          {shortDate(s.recorded_at)}
                          {s.notes ? ` · ${s.notes}` : ''}
                        </AppText>
                      </View>
                      <MonoText style={{ color: theme.colors.successFg }}>
                        −{formatNPR(s.amount_cents)}
                      </MonoText>
                    </View>
                  ))}
                </View>
              )}
            </Section>
          </>
        )}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function LedgerRow({
  label,
  value,
  theme,
  tone,
}: {
  label: string;
  value: string;
  theme: Theme;
  tone?: 'success';
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
      <AppText variant="muted" style={{ fontSize: theme.text.sm, flexShrink: 1 }}>
        {label}
      </AppText>
      <DottedLeader />
      <MonoText size="sm" style={tone === 'success' ? { color: theme.colors.successFg } : undefined}>
        {value}
      </MonoText>
    </View>
  );
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
