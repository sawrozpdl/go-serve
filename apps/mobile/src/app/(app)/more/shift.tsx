/**
 * Shift / cash drawer (M8). Shows the open shift's live drawer (opening float,
 * cash in/out, expected), lets you open a shift, record cash drops, and close
 * with a counted-cash variance preview. Money surfaces are gated by shift:*.
 */
import { useState } from 'react';
import { View, ScrollView, RefreshControl, Alert } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Wallet, AlertTriangle, Trash2, ArrowUpRight, ArrowDownRight } from 'lucide-react-native';
import type { Shift, CashDrop, CashDropDirection, ShiftPayment } from '@cafe-mgmt/api-types';
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
  useDeleteCashDrop,
  useShiftPayments,
} from '@/api/shift';
import { useReclassifyPayment } from '@/api/settle';
import {
  cashVariance,
  varianceTone,
  varianceSeverity,
  varianceAdvice,
  varianceNeedsNote,
  findVarianceMatch,
  latestClose,
  isLinkedDrop,
  linkedDropSource,
  dropKindLabel,
  type VarianceTone,
} from '@/finance/calc';
import { formatNPR, timeAgo } from '@/lib/format';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';

/**
 * The only two movements this panel posts.
 *
 * Migration 0014 retired the rest: an owner draw is a Finance payout, and an
 * eSewa-to-bank move is an inter-account transfer. Both still WRITE a drawer
 * row, which is why the list below can show kinds this form cannot create —
 * but offering them here posted a bare cash movement with no counterpart, so
 * the drawer and the ledger it was supposed to mirror drifted apart. Web
 * narrowed to these two; the phone was still offering all four.
 */
const DROP_KINDS: { value: 'bank_deposit' | 'correction'; label: string }[] = [
  { value: 'bank_deposit', label: 'Bank deposit' },
  { value: 'correction', label: 'Correction' },
];

const DROP_DIRECTIONS: { value: CashDropDirection; label: string }[] = [
  { value: 'out', label: 'Drawer was over' },
  { value: 'in', label: 'Drawer was short' },
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
  const canDeleteDrop = can(me.data, 'shift:delete');
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
                {/* "Float", not "Opening float": 13 tracked-out mono caps don't
                    fit a third-width tile and truncate to "OPENING F…". */}
                <Stat label="Float" value={formatNPR(s.opening_float_cents)} style={{ flex: 1 }} />
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
              {(s.live_online_in_cents ?? 0) > 0 ? (
                // Deliberately OUTSIDE expected cash — none of it touched the
                // drawer. It is here to be checked against the QR app, which is
                // the only place an online payment can be confirmed at all.
                <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
                  {formatNPR(s.live_online_in_cents ?? 0)} taken online this shift — cross-check
                  your QR app. Not part of expected cash.
                </AppText>
              ) : null}
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                Opened {new Date(s.opened_at).toLocaleString()}
                {s.opened_by_email ? ` · ${s.opened_by_email}` : ''}
              </AppText>
            </View>

            <View style={{ gap: theme.spacing[3] }}>
              {canClose ? <Button title="Close shift" onPress={() => setCloseForm(true)} /> : null}
              {canDrop ? <Button title="Record drawer movement" variant="secondary" onPress={() => setDropForm(true)} /> : null}
            </View>

            <CashDropList shiftId={s.id} canDelete={canDeleteDrop} />
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

/** Label ····· amount, on one line each. These labels are long ("↳ credit
 *  collected (earlier serves)" is 34 characters at 16px against a 304dp sheet),
 *  so without a shrinking label the amount got pushed past the edge. */
function MoneyRow({
  label,
  value,
  bold = false,
  valueColor,
}: {
  label: string;
  value: string;
  bold?: boolean;
  valueColor?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: theme.spacing[2],
      }}
    >
      <AppText variant="muted" style={{ flex: 1, minWidth: 0 }} numberOfLines={2}>
        {label}
      </AppText>
      <MonoText
        weight={bold ? 'bold' : 'medium'}
        numberOfLines={1}
        style={{ flexShrink: 0, ...(valueColor ? { color: valueColor } : null) }}
      >
        {value}
      </MonoText>
    </View>
  );
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
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <AppText numberOfLines={1}>
              {new Date(h.opened_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
              float {formatNPR(h.opening_float_cents)}
            </AppText>
          </View>
          {/* The variance stamp interpolates money, so this column has to be capped
              — unbounded it squeezed the date column toward zero. */}
          {h.closing_count_cents != null ? (
            <View style={{ alignItems: 'flex-end', gap: 2, maxWidth: '55%' }}>
              <MonoText size="sm" numberOfLines={1}>
                {formatNPR(h.closing_count_cents)}
              </MonoText>
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

function CashDropList({ shiftId, canDelete }: { shiftId: string; canDelete: boolean }) {
  const theme = useTheme();
  const drops = useCashDrops(shiftId);
  const remove = useDeleteCashDrop(shiftId);
  const rows = drops.data ?? [];
  if (rows.length === 0) return null;
  return (
    <Section title="Drawer ledger" gap={theme.spacing[2]}>
      {rows.map((d) => (
        <CashDropRow
          key={d.id}
          drop={d}
          canDelete={canDelete}
          deleting={remove.isPending}
          onDelete={() =>
            remove.mutate(d.id, { onError: (e) => toast.error('Could not remove', errorText(e)) })
          }
        />
      ))}
    </Section>
  );
}

function CashDropRow({
  drop: d,
  canDelete,
  deleting,
  onDelete,
}: {
  drop: CashDrop;
  canDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const isOut = d.direction === 'out';
  const linked = isLinkedDrop(d.kind);
  const money = `${isOut ? '−' : '+'}${formatNPR(d.amount_cents)}`;
  const at = new Date(d.recorded_at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const Arrow = isOut ? ArrowUpRight : ArrowDownRight;
  const tint = isOut ? theme.colors.dangerFg : theme.colors.successFg;

  const confirmDelete = () =>
    Alert.alert(
      'Remove this movement?',
      `${dropKindLabel(d.kind)} of ${money}${d.reason ? ` (${d.reason})` : ''}. The shift's expected cash is recalculated.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: onDelete },
      ],
    );

  return (
    <Card
      level={2}
      elevated={false}
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}
    >
      <Arrow size={16} color={tint} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText numberOfLines={1}>
          {dropKindLabel(d.kind)}
          {d.reason ? ` — ${d.reason}` : ''}
        </AppText>
        {/* Who and when: a drawer row with no author is unauditable, and the
            close panel's variance is usually explained by one of these. */}
        <MonoText size="2xs" muted numberOfLines={1}>
          {at}
          {d.recorded_by_email ? ` · ${d.recorded_by_email}` : ''}
        </MonoText>
        {d.notes ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={2}>
            {d.notes}
          </AppText>
        ) : null}
        {linked ? (
          // A bare "linked" stamp explains nothing. Say where the row is
          // actually managed, so the dead end has a direction.
          <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={2}>
            {linkedDropSource(d.kind)}
          </AppText>
        ) : null}
      </View>
      <MonoText weight="bold" numberOfLines={1} style={{ color: tint, flexShrink: 0 }}>
        {money}
      </MonoText>
      {linked ? (
        // The owning record created this row. Deleting the mirror alone would
        // leave the drawer and that ledger disagreeing, so the API refuses and
        // the UI says where to go instead of offering a button that fails.
        <Stamp tone="neutral" label="linked" size="sm" />
      ) : canDelete ? (
        <Button
          title=""
          variant="ghost"
          accessibilityLabel={`remove-drop-${d.id}`}
          icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
          onPress={confirmDelete}
          loading={deleting}
        />
      ) : null}
    </Card>
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
        {expected != null ? <MoneyRow label="Last close" value={formatNPR(expected)} bold /> : null}

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
  // How hard to lean on it. Rs 20 and Rs 2,000 are both "short"; only one of
  // them should stop the day.
  const severity = varianceSeverity(variance);
  const pressForNote = countedCents > 0 && varianceNeedsNote(severity);

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
        <MoneyRow label="Expected in drawer" value={formatNPR(shift.live_expected_cash_cents)} bold />
        {(shift.live_tab_settlements_cash_cents ?? 0) > 0 ? (
          <MoneyRow
            label="↳ credit collected (earlier serves)"
            value={formatNPR(shift.live_tab_settlements_cash_cents ?? 0)}
          />
        ) : null}
        <AmountInput label="Counted cash" valueCents={countedCents} onChangeCents={setCountedCents} insideSheet autoFocus testID="close-count" />
        {countedCents > 0 ? (
          <View style={{ gap: 2 }}>
            <MoneyRow
              label="Variance"
              value={
                variance === 0
                  ? 'Balanced'
                  : `${variance > 0 ? '+' : '−'}${formatNPR(Math.abs(variance))} ${tone}`
              }
              bold
              valueColor={toneColor}
            />
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
            {/* The grade, not just the number: Rs 20 is coin rounding and
                Rs 2,000 is a conversation. Advisory at every level — a shift
                that cannot be closed is a shift that gets closed dishonestly. */}
            {variance !== 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2] }}>
                {severity === 'warn' || severity === 'bad' ? (
                  <AlertTriangle
                    size={13}
                    color={severity === 'bad' ? theme.colors.dangerFg : theme.colors.stamp.warn.fg}
                    style={{ marginTop: 2 }}
                  />
                ) : null}
                <AppText
                  style={{
                    flex: 1,
                    fontSize: theme.text.sm,
                    color:
                      severity === 'bad'
                        ? theme.colors.dangerFg
                        : severity === 'warn'
                          ? theme.colors.stamp.warn.fg
                          : theme.colors.textFaint,
                  }}
                >
                  {varianceAdvice(severity)}
                </AppText>
              </View>
            ) : null}
          </View>
        ) : null}
        {match ? <VarianceMatchHint match={match} variance={variance} /> : null}
        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">{pressForNote ? 'Notes' : 'Notes (optional)'}</AppText>
          <AppSheet.TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder={
              pressForNote ? 'Explain the variance — this is what the audit reads' : 'Anything worth recording'
            }
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

/**
 * Post a drawer movement.
 *
 * Two shapes behind one sheet. A bank deposit always leaves the drawer, so its
 * direction is implied. A correction can go either way and is the only place
 * in the app where cash appears or vanishes without a counterpart — which is
 * exactly why the note is mandatory here and optional everywhere else. An
 * unexplained correction is indistinguishable from a till being quietly
 * balanced, and that is the thing the drawer ledger exists to catch.
 */
function CashDropForm({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const theme = useTheme();
  const drop = useCreateCashDrop(shiftId);
  const [kind, setKind] = useState<'bank_deposit' | 'correction'>('bank_deposit');
  const [direction, setDirection] = useState<CashDropDirection>('out');
  const [amountCents, setAmountCents] = useState(0);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  const isCorrection = kind === 'correction';
  const noteMissing = isCorrection && !notes.trim();

  const submit = () => {
    if (amountCents <= 0) return toast.error('Enter an amount');
    if (noteMissing) {
      return toast.error('Corrections need a note', 'Say what is being corrected, for the audit.');
    }
    drop.mutate(
      {
        kind,
        amount_cents: amountCents,
        reason: reason.trim(),
        notes: notes.trim(),
        // Every other kind infers its own direction; only a correction can go
        // either way, so sending it elsewhere would be the client overriding
        // the server's own rule.
        direction: isCorrection ? direction : undefined,
      },
      {
        onSuccess: () => {
          toast.success(isCorrection ? 'Correction recorded' : 'Deposit recorded');
          onClose();
        },
        onError: (e) => toast.error('Could not record', errorText(e)),
      },
    );
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title="Drawer movement"
      size="full"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button
            title={isCorrection ? 'Record correction' : 'Record deposit'}
            onPress={submit}
            loading={drop.isPending}
          />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          gap: theme.spacing[4],
          paddingBottom: theme.spacing[6],
        }}
      >
        <SegmentedField label="Type" value={kind} options={DROP_KINDS} onChange={setKind} />

        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {isCorrection
            ? 'Use this only to reconcile a counting mistake. Money the cafe actually spent is an expense; an owner taking cash is a payout.'
            : 'Money leaves the drawer and lands in the cafe bank balance.'}
        </AppText>

        <AmountInput
          label="Amount"
          valueCents={amountCents}
          onChangeCents={setAmountCents}
          insideSheet
          autoFocus
          testID="drop-amount"
        />

        {isCorrection ? (
          <SegmentedField
            label="Which way?"
            value={direction}
            options={DROP_DIRECTIONS}
            onChange={setDirection}
          />
        ) : null}

        {isCorrection ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {direction === 'out'
              ? 'The drawer held more than it should — this takes the difference out.'
              : 'The drawer held less than it should — this puts the difference back.'}
          </AppText>
        ) : null}

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">
            {isCorrection ? 'Reason (short label, optional)' : 'Deposit slip / reference (optional)'}
          </AppText>
          <AppSheet.TextInput
            value={reason}
            onChangeText={setReason}
            placeholder={isCorrection ? 'e.g. coin shortage' : 'e.g. NIBL slip 2034'}
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Reason"
            style={fieldStyle(theme)}
          />
        </View>

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">{isCorrection ? 'Notes (required)' : 'Notes (optional)'}</AppText>
          <AppSheet.TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder={isCorrection ? 'Explain the adjustment for the audit' : 'Anything worth recording'}
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Notes"
            multiline
            style={fieldStyle(theme, {
              minHeight: 88,
              textAlignVertical: 'top',
              borderColor: noteMissing ? theme.colors.stamp.warn.fg : theme.colors.border,
            })}
          />
          {noteMissing ? (
            <AppText style={{ fontSize: theme.text.sm, color: theme.colors.stamp.warn.fg }}>
              A correction without an explanation is indistinguishable from a till being quietly
              balanced.
            </AppText>
          ) : null}
        </View>
      </AppSheet.ScrollView>
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
