/**
 * Shift / cash drawer (M8). Shows the open shift's live drawer (opening float,
 * cash in/out, expected), lets you open a shift, record cash drops, and close
 * with a counted-cash variance preview. Money surfaces are gated by shift:*.
 */
import { useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Wallet, AlertTriangle } from 'lucide-react-native';
import type { Shift, CashDropKind, ShiftPayment } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { AppSheet } from '@/components/ui/AppSheet';
import { AmountInput } from '@/components/ui/AmountInput';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { Stamp } from '@/components/ui/Stamp';
import { Section } from '@/components/ui/Section';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import {
  useCurrentShift,
  useShifts,
  useOpenShift,
  useCloseShift,
  useCashDrops,
  useCreateCashDrop,
  useShiftPayments,
} from '@/api/shift';
import { useReclassifyPayment } from '@/api/settle';
import { cashVariance, varianceTone, findVarianceMatch, latestClose, type VarianceTone } from '@/finance/calc';
import { formatNPR, timeAgo } from '@/lib/format';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';

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
  // Shift history answers "what number do I open with?" — without it this
  // screen showed nothing but a button when no shift was open.
  const shifts = useShifts();
  const lastClosed = latestClose(shifts.data ?? []);
  const closedShifts = (shifts.data ?? []).filter((h) => h.closed_at);

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
          <ErrorState detail={errorText(shift.error)} onRetry={() => void shift.refetch()} />
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
          <>
            <EmptyState
              icon={<Wallet size={28} color={theme.colors.textFaint} />}
              title="No shift is open."
              hint="Cash and online payments are blocked until a shift is open."
              action={canOpen ? { label: 'Open shift', onPress: () => setOpenForm(true) } : undefined}
            />
            {lastClosed ? <LastCloseCard shift={lastClosed} /> : null}
            {closedShifts.length > 0 ? <RecentShifts shifts={closedShifts} /> : null}
          </>
        ) : (
          <>
            <View style={{ gap: theme.spacing[2] }}>
              <Stat label="Expected in drawer" value={formatNPR(s.live_expected_cash_cents)} size="lg" />
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Stat label="Opening float" value={formatNPR(s.opening_float_cents)} style={{ flex: 1 }} />
                <Stat label="Cash in" value={formatNPR(s.live_cash_in_cents)} style={{ flex: 1 }} />
                <Stat label="Cash out" value={formatNPR(s.live_cash_out_cents)} style={{ flex: 1 }} />
              </View>
              {(s.live_tab_settlements_cash_cents ?? 0) > 0 ? (
                // Part of "Cash in" — spelled out so a drawer holding more than
                // the day's sales doesn't read as an overage at close.
                <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
                  Includes {formatNPR(s.live_tab_settlements_cash_cents ?? 0)} credit collected
                  (paying off earlier serves)
                </AppText>
              ) : null}
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

      {openForm ? <OpenShiftForm lastClosed={lastClosed} onClose={() => setOpenForm(false)} /> : null}
      {closeForm && s ? <CloseShiftForm shift={s} onClose={() => setCloseForm(false)} onClosed={() => { setCloseForm(false); }} /> : null}
      {dropForm && s ? <CashDropForm shiftId={s.id} onClose={() => setDropForm(false)} /> : null}
    </View>
  );
}

/** Map a variance to a stamp tone — same reading as the close sheet's colors. */
const VARIANCE_STAMP: Record<VarianceTone, 'success' | 'info' | 'danger'> = {
  balanced: 'success',
  over: 'info',
  short: 'danger',
};

/** Variance as a short stamp label: "matched expected" / "+Rs 200 over". */
function varianceLabel(variance: number): string {
  if (variance === 0) return 'matched expected';
  return `${variance > 0 ? '+' : '−'}${formatNPR(Math.abs(variance))} ${variance > 0 ? 'over' : 'short'}`;
}

/** How long ago, phrased for a sentence ("just now" already reads as one). */
function closedAgo(iso: string): string {
  const t = timeAgo(iso);
  if (!t) return 'Closed';
  return t === 'just now' ? 'Closed just now' : `Closed ${t} ago`;
}

/** The counted cash at the last close — what the drawer should still hold, and
 *  the figure the open-shift form recommends as the next opening float. */
function LastCloseCard({ shift }: { shift: Shift }) {
  const theme = useTheme();
  const variance = shift.variance_cents ?? 0;
  return (
    <Card level={2} elevated={false} style={{ gap: theme.spacing[3] }}>
      <Stat
        label="Last close"
        value={formatNPR(shift.closing_count_cents ?? 0)}
        size="lg"
        hint={`${closedAgo(shift.closed_at as string)}${shift.opened_by_email ? ` · run by ${shift.opened_by_email}` : ''}`}
      />
      <Stamp tone={VARIANCE_STAMP[varianceTone(variance)]} label={varianceLabel(variance)} size="sm" />
    </Card>
  );
}

/** A compact echo of web's shift-history panel, so the screen carries context
 *  before you open anything. Newest first, capped — this is orientation, not a
 *  report (Reports owns the full picture). */
function RecentShifts({ shifts }: { shifts: Shift[] }) {
  const theme = useTheme();
  const rows = shifts.slice(0, 5);
  return (
    <Section title="Recent shifts" gap={theme.spacing[2]}>
      {rows.map((h) => (
        <Card
          key={h.id}
          level={2}
          elevated={false}
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <AppText numberOfLines={1}>
              {new Date(h.opened_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              float {formatNPR(h.opening_float_cents)}
            </AppText>
          </View>
          {h.closing_count_cents != null ? (
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <MonoText size="sm">{formatNPR(h.closing_count_cents)}</MonoText>
              <Stamp
                tone={VARIANCE_STAMP[varianceTone(h.variance_cents ?? 0)]}
                label={varianceLabel(h.variance_cents ?? 0)}
                size="sm"
              />
            </View>
          ) : null}
        </Card>
      ))}
    </Section>
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

function OpenShiftForm({ lastClosed, onClose }: { lastClosed?: Shift; onClose: () => void }) {
  const theme = useTheme();
  const open = useOpenShift();
  const [floatCents, setFloatCents] = useState(0);
  const [notes, setNotes] = useState('');

  const expected = lastClosed?.closing_count_cents ?? null;
  // Non-blocking: the float SHOULD equal what was counted at close, but cafés
  // bank cash overnight, so this is a nudge and never a gate. Zero stays
  // submittable too — an emptied till is a real way to start a day.
  const mismatch = expected != null && floatCents !== expected ? floatCents - expected : null;

  const submit = () => {
    open.mutate(
      { opening_float_cents: floatCents, notes: notes.trim() || undefined },
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
        {expected != null ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <AppText variant="muted">Last close</AppText>
            <MonoText weight="bold">{formatNPR(expected)}</MonoText>
          </View>
        ) : null}

        {/* The quick-amount chip is the one-tap prefill web lacks (web only puts
            the figure in a placeholder you have to retype). */}
        <AmountInput
          label="Opening float (cash in drawer)"
          valueCents={floatCents}
          onChangeCents={setFloatCents}
          placeholderCents={expected ?? undefined}
          quickAmounts={expected != null ? [expected] : undefined}
          formatAmount={(c) => `Same as last close · ${formatNPR(c)}`}
          insideSheet
          autoFocus
          testID="open-float"
        />

        {mismatch != null ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2] }}>
            <AlertTriangle size={13} color={theme.colors.stamp.warn.fg} style={{ marginTop: 2 }} />
            <AppText variant="faint" style={{ flex: 1, fontSize: theme.text.sm }}>
              {mismatch > 0 ? '+' : '−'}{formatNPR(Math.abs(mismatch))} vs. last close — proceed only
              if you intentionally adjusted the till.
            </AppText>
          </View>
        ) : null}

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Notes (optional)</AppText>
          <AppSheet.TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="reason for any float adjustment"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Notes (optional)"
            style={fieldStyle(theme)}
          />
        </View>
      </View>
    </AppSheet>
  );
}

function CloseShiftForm({ shift, onClose, onClosed }: { shift: Shift; onClose: () => void; onClosed: () => void }) {
  const theme = useTheme();
  const me = useMe();
  const close = useCloseShift();
  const [countedCents, setCountedCents] = useState(0);
  const [notes, setNotes] = useState('');
  const variance = cashVariance(countedCents, shift.live_expected_cash_cents);
  const tone = varianceTone(variance);
  const toneColor = tone === 'balanced' ? theme.colors.successFg : tone === 'over' ? theme.colors.infoFg : theme.colors.dangerFg;

  // Variance-match: a wrong-method payment is the usual cause of a variance
  // that equals one payment exactly. Only fetch the shift's payments once
  // there's a non-zero variance AND the user could act on the suggestion.
  const canReclassify = can(me.data, 'payment:reclassify');
  const counted = countedCents > 0;
  const payments = useShiftPayments(shift.id, canReclassify && counted && variance !== 0);
  const match = findVarianceMatch(payments.data ?? [], counted ? variance : null);

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
        {(shift.live_tab_settlements_cash_cents ?? 0) > 0 ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <AppText variant="muted">↳ credit collected (earlier serves)</AppText>
            <MonoText>{formatNPR(shift.live_tab_settlements_cash_cents ?? 0)}</MonoText>
          </View>
        ) : null}
        <AmountInput label="Counted cash" valueCents={countedCents} onChangeCents={setCountedCents} insideSheet autoFocus testID="close-count" />
        {countedCents > 0 ? (
          <View style={{ gap: 2 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <AppText variant="muted">Variance</AppText>
              <MonoText weight="bold" style={{ color: toneColor }}>
                {variance === 0 ? 'Balanced' : `${variance > 0 ? '+' : '−'}${formatNPR(Math.abs(variance))} ${tone}`}
              </MonoText>
            </View>
            {/* The word alone ("short"/"over") doesn't say what it is measured
                against — say it, the way the web close panel does. Kept even
                when the match hint is up: the hint names the likely cause but
                only this line promises the close isn't blocked (and the Maestro
                drawer flow asserts this wording). */}
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              {variance === 0
                ? 'Counted cash matches what the drawer should hold.'
                : `Counted cash ${variance > 0 ? 'exceeds' : 'is below'} the ${formatNPR(
                    shift.live_expected_cash_cents,
                  )} expected. The close is recorded either way.`}
            </AppText>
          </View>
        ) : null}
        {match ? <VarianceMatchHint match={match} variance={variance} /> : null}
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

/**
 * The drawer is short or over by exactly one payment's amount — name that
 * payment and offer the one-tap fix. No second confirmation: the hint itself
 * spells out which payment changes and to what, which is the confirmation
 * (same call web makes). Once it succeeds the shift's expected cash is
 * recomputed, so the variance falls to zero and this disappears on its own.
 */
function VarianceMatchHint({
  match,
  variance,
}: {
  match: { payment: ShiftPayment; to: 'cash' | 'online' };
  variance: number;
}) {
  const theme = useTheme();
  const reclassify = useReclassifyPayment();
  const p = match.payment;
  const at = new Date(p.recorded_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const was = p.method === 'cash' ? 'Cash' : 'Online';

  return (
    <Card level={2} elevated={false} style={{ gap: theme.spacing[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2] }}>
        <AlertTriangle size={14} color={theme.colors.stamp.warn.fg} style={{ marginTop: 2 }} />
        <AppText variant="muted" style={{ flex: 1 }}>
          {variance < 0 ? 'Short' : 'Over'} by exactly the {was.toLowerCase()} payment of{' '}
          {formatNPR(p.amount_cents)} at {at}
          {p.table_name ? ` (${p.table_name})` : ''}. Was it actually paid{' '}
          {match.to === 'online' ? 'online' : 'in cash'}?
        </AppText>
      </View>
      <Button
        title={`Reclassify to ${match.to === 'online' ? 'Online' : 'Cash'}`}
        variant="secondary"
        loading={reclassify.isPending}
        onPress={() =>
          reclassify.mutate(
            { orderId: p.order_id, paymentId: p.id, method: match.to },
            {
              onSuccess: () =>
                toast.success('Payment reclassified', `${formatNPR(p.amount_cents)} is now ${match.to}`),
              onError: (e) => toast.error('Could not reclassify', errorText(e)),
            },
          )
        }
      />
    </Card>
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
