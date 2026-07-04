/**
 * History — day-wise closed orders + takings. A pinned top bar holds the title
 * and a day picker (prev / next, can't go past today); the summary + order list
 * scroll beneath. Tap an order to expand its line items.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { formatQty, resolveTableLabel, type HistoryOrder } from '@cafe-mgmt/api-types';
import { Heading, AppText, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { ErrorState } from '@/components/ui/ErrorState';
import { useTheme } from '@/theme';
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
        <Heading>History</Heading>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <DayArrow dir="prev" onPress={() => setDate((d) => shiftDay(d, -1))} />
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{formatDayLabel(date)}</AppText>
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

          {history.isError && !history.data ? (
            <ErrorState detail={String(history.error)} onRetry={() => void history.refetch()} />
          ) : history.isLoading ? (
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
    <Card style={{ gap: theme.spacing[2] }}>
      <MonoText size="2xs" muted>
        {summary.orderCount} order{summary.orderCount === 1 ? '' : 's'}
      </MonoText>
      <MonoText size="display" weight="bold">
        {formatNPR(summary.salesCents)}
      </MonoText>
      {segs.length > 0 ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing[4], flexWrap: 'wrap', marginTop: theme.spacing[1] }}>
          {segs.map((s) => (
            <View key={s.label} style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[1] }}>
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                {s.label}
              </AppText>
              <MonoText size="sm">{formatNPR(s.cents)}</MonoText>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

function OrderCard({ order }: { order: HistoryOrder }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const items = (order.items ?? []).filter((i) => !i.voided_at);
  const when = order.closed_at ? new Date(order.closed_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <Card onPress={() => setOpen((v) => !v)} style={{ gap: theme.spacing[2] }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{resolveTableLabel(order, 'Take-away')}</AppText>
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {when}
            {when ? ' · ' : ''}
            {formatQty(order.item_count)} item{order.item_count === 1 ? '' : 's'}
          </AppText>
        </View>
        <MonoText weight="bold" size="lg">
          {formatNPR(order.total_cents)}
        </MonoText>
      </View>

      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {order.payments.map((p) => (
          <Stamp key={p.id} tone="brand" label={`${payLabel(p.method)} ${formatNPR(p.amount_cents)}`} />
        ))}
      </View>

      {open && items.length > 0 ? (
        <View style={{ gap: 2, marginTop: theme.spacing[2], borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: theme.spacing[2] }}>
          {items.map((it) => (
            <View key={it.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <AppText variant="muted" style={{ flex: 1 }} numberOfLines={1}>
                {formatQty(it.qty)}× {it.menu_item_name}
              </AppText>
              <MonoText size="sm" muted>
                {formatNPR(it.line_cents)}
              </MonoText>
            </View>
          ))}
          {order.discount_cents > 0 ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <AppText variant="faint">Discount</AppText>
              <MonoText size="sm" muted>
                −{formatNPR(order.discount_cents)}
              </MonoText>
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
