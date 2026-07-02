/**
 * Shift / cash drawer (M8). Shows the open shift's live drawer (opening float,
 * cash in/out, expected), lets you open a shift, record cash drops, and close
 * with a counted-cash variance preview. Money surfaces are gated by shift:*.
 */
import { useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Wallet } from 'lucide-react-native';
import type { Shift, CashDropKind } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { AppSheet } from '@/components/ui/AppSheet';
import { AmountInput } from '@/components/ui/AmountInput';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { Section } from '@/components/ui/Section';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useCurrentShift, useOpenShift, useCloseShift, useCashDrops, useCreateCashDrop } from '@/api/shift';
import { cashVariance, varianceTone } from '@/finance/calc';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';

const DROP_KINDS: { value: CashDropKind; label: string }[] = [
  { value: 'bank_deposit', label: 'Bank deposit' },
  { value: 'owner_draw', label: 'Owner draw' },
  { value: 'paid_out', label: 'Paid out' },
  { value: 'transfer', label: 'Transfer' },
];

export default function ShiftScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const shift = useCurrentShift();

  const [openForm, setOpenForm] = useState(false);
  const [closeForm, setCloseForm] = useState(false);
  const [dropForm, setDropForm] = useState(false);

  const canRead = can(me.data, 'shift:read');
  const canOpen = can(me.data, 'shift:create');
  const canClose = can(me.data, 'shift:settle');
  const canDrop = can(me.data, 'shift:withdraw');
  if (me.data && !canRead) return <Redirect href="/more" />;

  const s = shift.data;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Cash drawer" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
        refreshControl={<RefreshControl refreshing={shift.isRefetching} onRefresh={() => void shift.refetch()} tintColor={theme.colors.primary} />}
      >
        {shift.isError && !s ? (
          <ErrorState detail={String(shift.error)} onRetry={() => void shift.refetch()} />
        ) : shift.isLoading ? (
          <View style={{ gap: theme.spacing[3] }}>
            <Skeleton height={84} radius={theme.radii.lg} />
            <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
              <Skeleton style={{ flex: 1 }} height={64} radius={theme.radii.lg} />
              <Skeleton style={{ flex: 1 }} height={64} radius={theme.radii.lg} />
              <Skeleton style={{ flex: 1 }} height={64} radius={theme.radii.lg} />
            </View>
          </View>
        ) : !s ? (
          <EmptyState
            icon={<Wallet size={28} color={theme.colors.textFaint} />}
            title="No shift is open."
            action={canOpen ? { label: 'Open shift', onPress: () => setOpenForm(true) } : undefined}
          />
        ) : (
          <>
            <View style={{ gap: theme.spacing[2] }}>
              <Stat label="Expected in drawer" value={formatNPR(s.live_expected_cash_cents)} size="lg" />
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Stat label="Opening float" value={formatNPR(s.opening_float_cents)} style={{ flex: 1 }} />
                <Stat label="Cash in" value={formatNPR(s.live_cash_in_cents)} style={{ flex: 1 }} />
                <Stat label="Cash out" value={formatNPR(s.live_cash_out_cents)} style={{ flex: 1 }} />
              </View>
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                Opened {new Date(s.opened_at).toLocaleString()}
                {s.opened_by_email ? ` · ${s.opened_by_email}` : ''}
              </AppText>
            </View>

            <View style={{ gap: theme.spacing[3] }}>
              {canClose ? <Button title="Close shift" onPress={() => setCloseForm(true)} /> : null}
              {canDrop ? <Button title="Record cash drop" variant="secondary" onPress={() => setDropForm(true)} /> : null}
            </View>

            <CashDropList shiftId={s.id} />
          </>
        )}
      </ScrollView>

      {openForm ? <OpenShiftForm onClose={() => setOpenForm(false)} /> : null}
      {closeForm && s ? <CloseShiftForm shift={s} onClose={() => setCloseForm(false)} onClosed={() => { setCloseForm(false); }} /> : null}
      {dropForm && s ? <CashDropForm shiftId={s.id} onClose={() => setDropForm(false)} /> : null}
    </View>
  );
}

function CashDropList({ shiftId }: { shiftId: string }) {
  const theme = useTheme();
  const drops = useCashDrops(shiftId);
  const rows = drops.data ?? [];
  if (rows.length === 0) return null;
  return (
    <Section title="Cash drops" gap={theme.spacing[2]}>
      {rows.map((d) => (
        <Card
          key={d.id}
          level={2}
          elevated={false}
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[3] }}
        >
          <AppText style={{ flex: 1, textTransform: 'capitalize' }} numberOfLines={1}>
            {d.kind.replace(/_/g, ' ')}{d.reason ? ` · ${d.reason}` : ''}
          </AppText>
          <MonoText weight="bold" style={{ color: d.direction === 'out' ? theme.colors.dangerFg : theme.colors.successFg }}>
            {d.direction === 'out' ? '−' : '+'}{formatNPR(d.amount_cents)}
          </MonoText>
        </Card>
      ))}
    </Section>
  );
}

function OpenShiftForm({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const open = useOpenShift();
  const [floatCents, setFloatCents] = useState(0);
  const submit = () => {
    open.mutate(
      { opening_float_cents: floatCents },
      { onSuccess: () => { toast.success('Shift opened'); onClose(); }, onError: (e) => toast.error('Could not open', (e as Error).message) },
    );
  };
  return (
    <AppSheet
      open
      onClose={onClose}
      title="Open shift"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button title="Open shift" onPress={submit} loading={open.isPending} />
        </View>
      }
    >
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <AmountInput label="Opening float (cash in drawer)" valueCents={floatCents} onChangeCents={setFloatCents} insideSheet autoFocus />
      </View>
    </AppSheet>
  );
}

function CloseShiftForm({ shift, onClose, onClosed }: { shift: Shift; onClose: () => void; onClosed: () => void }) {
  const theme = useTheme();
  const close = useCloseShift();
  const [countedCents, setCountedCents] = useState(0);
  const [notes, setNotes] = useState('');
  const variance = cashVariance(countedCents, shift.live_expected_cash_cents);
  const tone = varianceTone(variance);
  const toneColor = tone === 'balanced' ? theme.colors.successFg : tone === 'over' ? theme.colors.infoFg : theme.colors.dangerFg;

  const submit = () => {
    close.mutate(
      { id: shift.id, closing_count_cents: countedCents, notes: notes.trim() || undefined },
      { onSuccess: () => { toast.success('Shift closed'); onClosed(); }, onError: (e) => toast.error('Could not close', (e as Error).message) },
    );
  };
  return (
    <AppSheet
      open
      onClose={onClose}
      title="Close shift"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button title="Close shift" onPress={submit} loading={close.isPending} disabled={countedCents <= 0} />
        </View>
      }
    >
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <AppText variant="muted">Expected in drawer</AppText>
          <MonoText weight="bold">{formatNPR(shift.live_expected_cash_cents)}</MonoText>
        </View>
        <AmountInput label="Counted cash" valueCents={countedCents} onChangeCents={setCountedCents} insideSheet autoFocus />
        {countedCents > 0 ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <AppText variant="muted">Variance</AppText>
            <MonoText weight="bold" style={{ color: toneColor }}>
              {variance === 0 ? 'Balanced' : `${variance > 0 ? '+' : '−'}${formatNPR(Math.abs(variance))} ${tone}`}
            </MonoText>
          </View>
        ) : null}
        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Notes (optional)</AppText>
          <AppSheet.TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Anything worth recording"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Notes (optional)"
            multiline
            style={fieldStyle(theme, { minHeight: 88, textAlignVertical: 'top' })}
          />
        </View>
      </View>
    </AppSheet>
  );
}

function CashDropForm({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const theme = useTheme();
  const drop = useCreateCashDrop(shiftId);
  const [kind, setKind] = useState<CashDropKind>('bank_deposit');
  const [amountCents, setAmountCents] = useState(0);
  const [reason, setReason] = useState('');
  const submit = () => {
    if (amountCents <= 0) return toast.error('Enter an amount');
    drop.mutate(
      { kind, amount_cents: amountCents, reason: reason.trim() },
      { onSuccess: () => { toast.success('Cash drop recorded'); onClose(); }, onError: (e) => toast.error('Could not record', (e as Error).message) },
    );
  };
  return (
    <AppSheet
      open
      onClose={onClose}
      title="Cash drop"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button title="Record" onPress={submit} loading={drop.isPending} />
        </View>
      }
    >
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <SegmentedField label="Type" value={kind} options={DROP_KINDS} onChange={setKind} />
        <AmountInput label="Amount" valueCents={amountCents} onChangeCents={setAmountCents} insideSheet autoFocus />
        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Reason (optional)</AppText>
          <AppSheet.TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. deposit slip #"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Reason (optional)"
            style={fieldStyle(theme)}
          />
        </View>
      </View>
    </AppSheet>
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
