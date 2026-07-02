/**
 * History — day-wise closed orders + takings. A pinned top bar holds the title
 * and a day picker (‹ / ›, can't go past today); the summary + order list
 * scroll beneath. Tap an order to expand its line items.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { resolveTableLabel, type HistoryOrder } from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { useTheme, hexToRgba } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useOrderHistory } from '@/api/history';
import { todayStr, shiftDay, formatDayLabel, isToday, summarizeHistory } from '@/history/summary';
import { formatNPR } from '@/lib/format';

const PAYMENT_LABEL: Record<string, string> = { cash: 'Cash', online: 'Online', house_tab: 'House tab' };
const payLabel = (m: string) => PAYMENT_LABEL[m] ?? 'Online';

export default function History() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const [date, setDate] = useState(() => todayStr());
  const history = useOrderHistory(date);

  const orders = history.data?.orders ?? [];
  const summary = summarizeHistory(orders);
  const atToday = isToday(date);
  const canRead = can(me.data, 'order:read') || can(me.data, 'report:read');

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
        <Heading style={{ fontSize: 26 }}>History</Heading>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <DayArrow dir="prev" onPress={() => setDate((d) => shiftDay(d, -1))} />
          <AppText style={{ fontFamily: theme.fonts.bodySemi, fontSize: theme.text.lg }}>{formatDayLabel(date)}</AppText>
          <DayArrow dir="next" disabled={atToday} onPress={() => setDate((d) => shiftDay(d, 1))} />
        </View>
      </View>

      {me.data && !canRead ? (
        <View style={{ padding: theme.spacing[6] }}>
          <AppText variant="muted">You don&rsquo;t have access to order history.</AppText>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: theme.spacing[5],
            paddingTop: theme.spacing[4],
            paddingBottom: insets.bottom + theme.spacing[8],
            gap: theme.spacing[4],
          }}
          refreshControl={<RefreshControl refreshing={history.isRefetching} onRefresh={() => void history.refetch()} tintColor={theme.colors.primary} />}
        >
          <SummaryCard summary={summary} />

          {history.isLoading ? (
            <AppText variant="faint">Loading…</AppText>
          ) : orders.length === 0 ? (
            <AppText variant="muted" style={{ textAlign: 'center', marginTop: theme.spacing[6] }}>
              No closed orders on this day.
            </AppText>
          ) : (
            <View style={{ gap: theme.spacing[3] }}>
              {orders.map((o) => (
                <OrderCard key={o.id} order={o} />
              ))}
            </View>
          )}
        </ScrollView>
      )}
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

function SummaryCard({ summary }: { summary: ReturnType<typeof summarizeHistory> }) {
  const theme = useTheme();
  const segs = [
    { label: 'Cash', cents: summary.cashCents },
    { label: 'Online', cents: summary.onlineCents },
    { label: 'House tab', cents: summary.tabCents },
  ].filter((s) => s.cents > 0);
  return (
    <View style={{ backgroundColor: theme.colors.card, borderRadius: theme.radii.lg, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4], gap: theme.spacing[2], ...theme.elevation.card }}>
      <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
        {summary.orderCount} order{summary.orderCount === 1 ? '' : 's'}
      </AppText>
      <AppText style={{ fontFamily: theme.fonts.bodyBold, fontSize: 30 }}>{formatNPR(summary.salesCents)}</AppText>
      {segs.length > 0 ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing[4], flexWrap: 'wrap', marginTop: theme.spacing[1] }}>
          {segs.map((s) => (
            <AppText key={s.label} variant="faint" style={{ fontSize: theme.text.sm }}>
              {s.label} <AppText style={{ fontFamily: theme.fonts.bodySemi, color: theme.colors.text }}>{formatNPR(s.cents)}</AppText>
            </AppText>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function OrderCard({ order }: { order: HistoryOrder }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const items = (order.items ?? []).filter((i) => !i.voided_at);
  const when = order.closed_at ? new Date(order.closed_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <Pressable
      onPress={() => setOpen((v) => !v)}
      style={{ backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4], gap: theme.spacing[2] }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{resolveTableLabel(order, 'Take-away')}</AppText>
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {when}
            {when ? ' · ' : ''}
            {order.item_count} item{order.item_count === 1 ? '' : 's'}
          </AppText>
        </View>
        <AppText style={{ fontFamily: theme.fonts.bodyBold, fontSize: theme.text.lg }}>{formatNPR(order.total_cents)}</AppText>
      </View>

      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {order.payments.map((p) => (
          <View key={p.id} style={{ paddingHorizontal: theme.spacing[2], paddingVertical: 2, borderRadius: theme.radii.pill, backgroundColor: hexToRgba(theme.colors.primary, 0.12) }}>
            <AppText style={{ color: theme.colors.primary, fontSize: theme.text.xs }}>
              {payLabel(p.method)} {formatNPR(p.amount_cents)}
            </AppText>
          </View>
        ))}
      </View>

      {open && items.length > 0 ? (
        <View style={{ gap: 2, marginTop: theme.spacing[2], borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: theme.spacing[2] }}>
          {items.map((it) => (
            <View key={it.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <AppText variant="muted" style={{ flex: 1 }} numberOfLines={1}>
                {it.qty}× {it.menu_item_name}
              </AppText>
              <AppText variant="muted">{formatNPR(it.line_cents)}</AppText>
            </View>
          ))}
          {order.discount_cents > 0 ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <AppText variant="faint">Discount</AppText>
              <AppText variant="faint">−{formatNPR(order.discount_cents)}</AppText>
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
