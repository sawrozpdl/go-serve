/**
 * Shift / cash drawer (M8). Shows the open shift's live drawer (opening float,
 * cash in/out, expected), lets you open a shift, record cash drops, and close
 * with a counted-cash variance preview. Money surfaces are gated by shift:*.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import type { Shift, CashDropKind } from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Sheet } from '@/components/ui/Sheet';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useCurrentShift, useOpenShift, useCloseShift, useCashDrops, useCreateCashDrop } from '@/api/shift';
import { cashVariance, varianceTone } from '@/finance/calc';
import { parsePriceToCents } from '@/catalog/money';
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
  const router = useRouter();
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
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
        refreshControl={<RefreshControl refreshing={shift.isRefetching} onRefresh={() => void shift.refetch()} tintColor={theme.colors.primary} />}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <ChevronLeft size={26} color={theme.colors.primary} />
          </Pressable>
          <Heading style={{ fontSize: 26 }}>Cash drawer</Heading>
        </View>

        {shift.isLoading ? (
          <AppText variant="faint">Loading…</AppText>
        ) : !s ? (
          <View style={{ gap: theme.spacing[3], alignItems: 'center', marginTop: theme.spacing[8] }}>
            <AppText variant="muted">No shift is open.</AppText>
            {canOpen ? <Button title="Open shift" onPress={() => setOpenForm(true)} /> : null}
          </View>
        ) : (
          <>
            <View style={{ gap: theme.spacing[2] }}>
              <Stat label="Expected in drawer" value={formatNPR(s.live_expected_cash_cents)} big />
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Stat label="Opening float" value={formatNPR(s.opening_float_cents)} />
                <Stat label="Cash in" value={formatNPR(s.live_cash_in_cents)} />
                <Stat label="Cash out" value={formatNPR(s.live_cash_out_cents)} />
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

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.card,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        padding: theme.spacing[4],
        gap: 2,
      }}
    >
      <AppText variant="faint" style={{ fontSize: theme.text.xs }}>{label}</AppText>
      <AppText style={{ fontFamily: theme.fonts.bodyBold, fontSize: big ? 26 : theme.text.lg }}>{value}</AppText>
    </View>
  );
}

function CashDropList({ shiftId }: { shiftId: string }) {
  const theme = useTheme();
  const drops = useCashDrops(shiftId);
  const rows = drops.data ?? [];
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">Cash drops</AppText>
      {rows.map((d) => (
        <View
          key={d.id}
          style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[3] }}
        >
          <AppText style={{ textTransform: 'capitalize' }}>{d.kind.replace(/_/g, ' ')}{d.reason ? ` · ${d.reason}` : ''}</AppText>
          <AppText style={{ fontFamily: theme.fonts.bodySemi, color: d.direction === 'out' ? theme.colors.dangerFg : theme.colors.successFg }}>
            {d.direction === 'out' ? '−' : '+'}{formatNPR(d.amount_cents)}
          </AppText>
        </View>
      ))}
    </View>
  );
}

function OpenShiftForm({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const open = useOpenShift();
  const [float, setFloat] = useState('');
  const submit = () => {
    open.mutate(
      { opening_float_cents: parsePriceToCents(float) },
      { onSuccess: () => { toast.success('Shift opened'); onClose(); }, onError: (e) => toast.error('Could not open', (e as Error).message) },
    );
  };
  return (
    <Sheet open onClose={onClose} title="Open shift">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <TextField label="Opening float (cash in drawer)" value={float} onChangeText={setFloat} placeholder="0" keyboardType="decimal-pad" autoFocus />
        <Button title="Open shift" onPress={submit} loading={open.isPending} />
      </View>
    </Sheet>
  );
}

function CloseShiftForm({ shift, onClose, onClosed }: { shift: Shift; onClose: () => void; onClosed: () => void }) {
  const theme = useTheme();
  const close = useCloseShift();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const countedCents = parsePriceToCents(counted);
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
    <Sheet open onClose={onClose} title="Close shift">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <AppText variant="muted">Expected in drawer</AppText>
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{formatNPR(shift.live_expected_cash_cents)}</AppText>
        </View>
        <TextField label="Counted cash" value={counted} onChangeText={setCounted} placeholder="0" keyboardType="decimal-pad" autoFocus />
        {counted.trim() ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <AppText variant="muted">Variance</AppText>
            <AppText style={{ fontFamily: theme.fonts.bodyBold, color: toneColor }}>
              {variance === 0 ? 'Balanced' : `${variance > 0 ? '+' : '−'}${formatNPR(Math.abs(variance))} ${tone}`}
            </AppText>
          </View>
        ) : null}
        <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Anything worth recording" multiline />
        <Button title="Close shift" onPress={submit} loading={close.isPending} disabled={!counted.trim()} />
      </View>
    </Sheet>
  );
}

function CashDropForm({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const theme = useTheme();
  const drop = useCreateCashDrop(shiftId);
  const [kind, setKind] = useState<CashDropKind>('bank_deposit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const submit = () => {
    const cents = parsePriceToCents(amount);
    if (cents <= 0) return toast.error('Enter an amount');
    drop.mutate(
      { kind, amount_cents: cents, reason: reason.trim() },
      { onSuccess: () => { toast.success('Cash drop recorded'); onClose(); }, onError: (e) => toast.error('Could not record', (e as Error).message) },
    );
  };
  return (
    <Sheet open onClose={onClose} title="Cash drop">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <SegmentedField label="Type" value={kind} options={DROP_KINDS} onChange={setKind} />
        <TextField label="Amount" value={amount} onChangeText={setAmount} placeholder="0" keyboardType="decimal-pad" autoFocus />
        <TextField label="Reason (optional)" value={reason} onChangeText={setReason} placeholder="e.g. deposit slip #" />
        <Button title="Record" onPress={submit} loading={drop.isPending} />
      </View>
    </Sheet>
  );
}
