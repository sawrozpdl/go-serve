/**
 * History — day-wise closed serves and what they took. A pinned top bar holds
 * the title, a day picker (prev / next / tap to jump, never past today) and a
 * table filter; the summary and order list scroll beneath. Tap a serve to
 * expand its lines and its bill.
 *
 * The expanded serve shows VOIDED lines too, struck through. They carry no
 * money, but hiding them made an order look like it was always what it ended
 * as — and "why is this bill short?" is exactly the question history is opened
 * to answer.
 */
import { memo, useCallback, useState } from 'react';
import { View, Pressable, RefreshControl } from 'react-native';
// The chip strip is horizontal inside a screen that also scrolls vertically —
// gesture-handler's ScrollView composes with that; RN's loses the drag.
import { ScrollView } from 'react-native-gesture-handler';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, ChevronRight, ArrowLeftRight, CalendarDays } from 'lucide-react-native';
import { formatQty, resolveTableLabel, type HistoryOrder, type HistoryPayment } from '@cafe-mgmt/api-types';
import { Heading, AppText, MonoText } from '@/components/ui/Text';
import { Chip } from '@/components/ui/Chip';
import { DottedLeader } from '@/components/ui/DottedLeader';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { ErrorState } from '@/components/ui/ErrorState';
import { ReclassifySheet, type ReclassifyTarget } from '@/components/settle/ReclassifySheet';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useOrderHistory } from '@/api/history';
import { useServiceTables } from '@/api/tables';
import { DayJumpSheet } from '@/components/history/DayJumpSheet';
import { todayStr, shiftDay, formatDayLabel, isToday, summarizeHistory } from '@/history/summary';
import { formatNPR } from '@/lib/format';
import { errorText } from '@/lib/errorText';

const PAYMENT_LABEL: Record<string, string> = { cash: 'Cash', online: 'Online', house_tab: 'Credit' };
const payLabel = (m: string) => PAYMENT_LABEL[m] ?? 'Online';

export default function History() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const [date, setDate] = useState(() => todayStr());
  const [tableId, setTableId] = useState('');
  const [jumpOpen, setJumpOpen] = useState(false);
  const history = useOrderHistory(date, tableId || undefined);
  const tables = useServiceTables();
  // The wrong-method fix. One sheet for the whole screen: order cards are
  // memoized inside a virtualized list, so a sheet per card would mount and
  // tear down with recycling.
  const [swap, setSwap] = useState<ReclassifyTarget | null>(null);

  const orders = history.data?.orders ?? [];
  const summary = summarizeHistory(orders, history.data?.credit_collections);
  const atToday = isToday(date);
  const tableRows = tables.data ?? [];
  const canRead = can(me.data, 'order:read') || can(me.data, 'report:read');
  const canReclassify = can(me.data, 'payment:reclassify');

  const onReclassify = useCallback((orderId: string, p: HistoryPayment) => {
    setSwap({ orderId, paymentId: p.id, amountCents: p.amount_cents, method: p.method });
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {/* Sticky bar: title + day picker */}
      <View
        style={{
          paddingTop: insets.top + theme.spacing[2],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[3],
          backgroundColor: theme.colors.bg,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          gap: theme.spacing[3],
        }}
      >
        <Heading>History</Heading>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <DayArrow dir="prev" onPress={() => setDate((d) => shiftDay(d, -1))} />
          {/* The label is the jump target: the arrows alone made last month a
              thirty-tap trip. */}
          <Pressable
            onPress={() => setJumpOpen(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="jump-to-day"
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}
          >
            <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{formatDayLabel(date)}</AppText>
            <CalendarDays size={16} color={theme.colors.textFaint} />
          </Pressable>
          <DayArrow dir="next" disabled={atToday} onPress={() => setDate((d) => shiftDay(d, 1))} />
        </View>

        {tableRows.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.spacing[2], paddingRight: theme.spacing[4] }}
          >
            <Chip
              label="All tables"
              selected={!tableId}
              onPress={() => setTableId('')}
              testID="history-table-all"
            />
            {tableRows.map((t) => (
              <Chip
                key={t.id}
                label={t.name}
                selected={tableId === t.id}
                onPress={() => setTableId(t.id)}
                testID={`history-table-${t.id}`}
              />
            ))}
          </ScrollView>
        ) : null}
      </View>

      {me.data && !canRead ? (
        <View style={{ padding: theme.spacing[6] }}>
          <AppText variant="muted">You don&rsquo;t have access to order history.</AppText>
        </View>
      ) : (
        // Virtualized: a busy day closes hundreds of orders, and mounting them
        // all was the largest unbounded list in the app.
        <FlashList
          data={orders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing[5],
            paddingTop: theme.spacing[4],
            paddingBottom: insets.bottom + theme.spacing[8],
          }}
          refreshControl={<RefreshControl refreshing={history.isRefetching} onRefresh={() => void history.refetch()} tintColor={theme.colors.primary} />}
          ListHeaderComponent={
            <View style={{ marginBottom: theme.spacing[4] }}>
              <SummaryCard summary={summary} tableFiltered={!!tableId} />
            </View>
          }
          ListEmptyComponent={
            history.isError && !history.data ? (
              <ErrorState detail={errorText(history.error)} onRetry={() => void history.refetch()} />
            ) : history.isLoading ? (
              <AppText variant="faint">Loading…</AppText>
            ) : (
              <AppText variant="muted" style={{ textAlign: 'center', marginTop: theme.spacing[6] }}>
                {summary.creditCollectedCents > 0
                  ? `No closed orders on this day — the only money in was ${formatNPR(
                      summary.creditCollectedCents,
                    )} of credit collected for earlier serves.`
                  : tableId
                    ? 'Nothing closed on this table on this day.'
                    : 'No closed orders on this day.'}
              </AppText>
            )
          }
          renderItem={({ item: o }) => (
            <View style={{ marginBottom: theme.spacing[3] }}>
              <OrderCard order={o} canReclassify={canReclassify} onReclassify={onReclassify} />
            </View>
          )}
        />
      )}

      <DayJumpSheet open={jumpOpen} onClose={() => setJumpOpen(false)} value={date} onPick={setDate} />
      <ReclassifySheet target={swap} onClose={() => setSwap(null)} />
    </View>
  );
}

function DayArrow({ dir, onPress, disabled }: { dir: 'prev' | 'next'; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  const Icon = dir === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={dir === 'prev' ? 'previous-day' : 'next-day'}
      style={{
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border,
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Icon size={22} color={theme.colors.primary} />
    </Pressable>
  );
}

function SummaryCard({
  summary,
  tableFiltered,
}: {
  summary: ReturnType<typeof summarizeHistory>;
  /** The server omits credit collections while a table filter is on, so the
   *  day's credit line must not be drawn as if it were zero. */
  tableFiltered: boolean;
}) {
  const theme = useTheme();
  const segs = [
    { label: 'Cash', cents: summary.cashCents, n: summary.cashCount },
    { label: 'Online', cents: summary.onlineCents, n: summary.onlineCount },
    { label: 'Credit', cents: summary.tabCents, n: summary.tabCount },
  ].filter((s) => s.cents > 0);

  // The one-line "what else happened" tail. Each part is omitted when zero so
  // a quiet day doesn't read as a list of noughts.
  const meta: string[] = [];
  if (summary.itemCount > 0) {
    meta.push(`${formatQty(summary.itemCount)} item${summary.itemCount === 1 ? '' : 's'} sold`);
  }
  if (summary.discountCents > 0) meta.push(`Discounts ${formatNPR(summary.discountCents)}`);
  if (summary.serviceCents > 0) meta.push(`Service ${formatNPR(summary.serviceCents)}`);
  if (summary.taxCents > 0) meta.push(`VAT ${formatNPR(summary.taxCents)}`);

  return (
    <Card style={{ gap: theme.spacing[2] }}>
      <MonoText size="2xs" muted>
        {summary.orderCount} order{summary.orderCount === 1 ? '' : 's'}
      </MonoText>
      <MonoText
        size="display"
        weight="bold"
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
      >
        {formatNPR(summary.salesCents)}
      </MonoText>
      {summary.orderCount > 0 ? (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {formatNPR(summary.avgTicketCents)} average ticket
        </AppText>
      ) : null}

      {segs.length > 0 ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing[4], flexWrap: 'wrap', marginTop: theme.spacing[1] }}>
          {segs.map((s) => (
            <View key={s.label} style={{ gap: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[1] }}>
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  {s.label}
                </AppText>
                <MonoText size="sm">{formatNPR(s.cents)}</MonoText>
              </View>
              {/* Two Rs 500 payments and one Rs 1,000 are the same money and a
                  very different day. */}
              <MonoText size="2xs" muted>
                {s.n} payment{s.n === 1 ? '' : 's'}
              </MonoText>
            </View>
          ))}
        </View>
      ) : null}

      {meta.length > 0 ? (
        <AppText variant="faint" style={{ fontSize: theme.text.sm, marginTop: theme.spacing[1] }}>
          {meta.join(' · ')}
        </AppText>
      ) : null}

      {summary.voidCount > 0 ? (
        <AppText style={{ fontSize: theme.text.sm, color: theme.colors.stamp.warn.fg }}>
          {summary.voidCount} voided item{summary.voidCount === 1 ? '' : 's'}
        </AppText>
      ) : null}

      {tableFiltered ? (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          One table only. Credit collected is a whole-day figure, so it is not shown here.
        </AppText>
      ) : summary.creditCollectedCents > 0 ? (
        // Kept out of the segments above: those split THIS day's sales, while
        // this is payment for serves already counted on an earlier day.
        <AppText variant="muted" style={{ fontSize: theme.text.sm, marginTop: theme.spacing[1] }}>
          + {formatNPR(summary.creditCollectedCents)} credit collected (earlier serves — not in
          the total above)
        </AppText>
      ) : null}
    </Card>
  );
}

const OrderCard = memo(function OrderCard({
  order,
  canReclassify,
  onReclassify,
}: {
  order: HistoryOrder;
  canReclassify: boolean;
  onReclassify: (orderId: string, p: HistoryPayment) => void;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  // Voided lines stay in the list, struck through. They add nothing to the
  // bill, but dropping them makes an order look like it was always what it
  // ended as, which is precisely the thing history gets opened to check.
  const items = order.items ?? [];
  // `reclassifiable` is the server's own gate (not credit, has a shift, shift
  // still open) — trusting it means we never offer a swap the API would reject.
  const swappable = canReclassify && order.payments.some((p) => p.reclassifiable);
  const when = order.closed_at ? new Date(order.closed_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <Card onPress={() => setOpen((v) => !v)} style={{ gap: theme.spacing[2] }}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: theme.spacing[3],
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText style={{ fontFamily: theme.fonts.bodySemi }} numberOfLines={1}>
            {resolveTableLabel(order, 'Take-away')}
          </AppText>
          <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
            {when}
            {when ? ' · ' : ''}
            {formatQty(order.item_count)} item{order.item_count === 1 ? '' : 's'}
          </AppText>
        </View>
        <MonoText weight="bold" size="lg" numberOfLines={1} style={{ flexShrink: 0 }}>
          {formatNPR(order.total_cents)}
        </MonoText>
      </View>

      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {order.payments.map((p) => (
          <Stamp key={p.id} tone="brand" label={`${payLabel(p.method)} ${formatNPR(p.amount_cents)}`} />
        ))}
      </View>

      {open ? (
        <View style={{ gap: 2, marginTop: theme.spacing[2], borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: theme.spacing[2] }}>
          {items.map((it) => {
            const voided = !!it.voided_at;
            return (
              <View key={it.id} style={{ gap: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing[2] }}>
                  <AppText
                    variant={voided ? 'faint' : 'muted'}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textDecorationLine: voided ? 'line-through' : 'none',
                    }}
                    numberOfLines={1}
                  >
                    {formatQty(it.qty)}× {it.menu_item_name}
                  </AppText>
                  <MonoText
                    size="sm"
                    muted
                    numberOfLines={1}
                    style={{
                      flexShrink: 0,
                      textDecorationLine: voided ? 'line-through' : 'none',
                    }}
                  >
                    {formatNPR(it.line_cents)}
                  </MonoText>
                </View>
                {/* The note is why the dish left the kitchen the way it did —
                    "no chilli", "extra hot" — and the only record of it. */}
                {it.notes || voided ? (
                  <AppText variant="faint" style={{ fontSize: theme.text.xs }} numberOfLines={2}>
                    {[it.notes, voided ? `voided${it.void_reason ? `: ${it.void_reason}` : ''}` : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </AppText>
                ) : null}
              </View>
            );
          })}

          {/* The bill as it was printed. Subtotal and total always; the middle
              rows only when the cafe actually charged them. */}
          <View style={{ gap: 1, marginTop: theme.spacing[2] }}>
            <BillRow label="Subtotal" cents={order.subtotal_cents} />
            {order.discount_cents > 0 ? (
              <BillRow label="Discount" cents={-order.discount_cents} />
            ) : null}
            {order.service_charge_cents > 0 ? (
              <BillRow label="Service charge" cents={order.service_charge_cents} />
            ) : null}
            {order.tax_cents > 0 ? <BillRow label="VAT" cents={order.tax_cents} /> : null}
            <BillRow label="Total" cents={order.total_cents} bold />
          </View>

          {/* Payments are read-only chips in the collapsed header; expanding
              turns them into rows with a real 44pt swap target — the fix for a
              tab settled as online that was actually paid in cash. Web reveals
              the same rows when a history row is expanded. */}
          {swappable ? (
            <View style={{ gap: theme.spacing[1], marginTop: theme.spacing[3] }}>
              <AppText variant="label">Payments</AppText>
              {order.payments.map((p) => (
                <View
                  key={p.id}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], minHeight: theme.touch.min }}
                >
                  <AppText variant="muted" style={{ flex: 1 }} numberOfLines={1}>
                    {payLabel(p.method)}
                    {p.reference_no ? ` · ${p.reference_no}` : ''}
                  </AppText>
                  <MonoText size="sm">{formatNPR(p.amount_cents)}</MonoText>
                  {p.reclassifiable ? (
                    <Pressable
                      onPress={() => onReclassify(order.id, p)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`reclassify-${p.id}`}
                      style={{ padding: theme.spacing[2] }}
                    >
                      <ArrowLeftRight size={16} color={theme.colors.textFaint} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
});

/** One line of the printed bill: label, dotted leader, amount. */
function BillRow({ label, cents, bold }: { label: string; cents: number; bold?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
      <AppText
        variant={bold ? undefined : 'faint'}
        style={{ fontSize: theme.text.sm, fontFamily: bold ? theme.fonts.bodySemi : undefined }}
      >
        {label}
      </AppText>
      <DottedLeader />
      <MonoText size="sm" weight={bold ? 'bold' : undefined} muted={!bold}>
        {cents < 0 ? `−${formatNPR(-cents)}` : formatNPR(cents)}
      </MonoText>
    </View>
  );
}
