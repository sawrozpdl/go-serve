/**
 * Reports dashboard (M8). KPI tiles, a payment-mix bar, and a daily-sales bar
 * chart (hand-drawn with react-native-svg — no chart lib). Advanced analytics
 * (hourly / heatmap / mix / velocity / profitability) are a tracked follow-up.
 */
import { useState } from 'react';
import { View, ScrollView, RefreshControl, Pressable } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect } from 'react-native-svg';
import type { CreditCollectedRow, DashboardRange } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { Stat } from '@/components/ui/Stat';
import { AppSheet } from '@/components/ui/AppSheet';
import { DottedLeader } from '@/components/ui/DottedLeader';
import { ErrorState } from '@/components/ui/ErrorState';
import { useTheme } from '@/theme';
import { useLayout } from '@/lib/layout';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useReportsDashboard } from '@/api/reports';
import { paymentMixPercents, barGeometry } from '@/finance/calc';
import { formatNPR } from '@/lib/format';
import { errorText } from '@/lib/errorText';

const RANGES: { value: DashboardRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export default function Dashboard() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const router = useRouter();
  const [range, setRange] = useState<DashboardRange>('today');
  const [creditDrill, setCreditDrill] = useState(false);
  const report = useReportsDashboard(range);

  if (me.data && !can(me.data, 'report:read')) return <Redirect href="/more" />;

  const d = report.data;
  const k = d?.kpis;
  const loading = report.isLoading || !k;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Dashboard" />
      {/* Pinned range filter — stays put while the report scrolls. */}
      <View
        style={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[3],
          paddingBottom: theme.spacing[3],
          backgroundColor: theme.colors.bg,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <SegmentedField value={range} options={RANGES} onChange={setRange} />
      </View>
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[4],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
        refreshControl={<RefreshControl refreshing={report.isRefetching} onRefresh={() => void report.refetch()} tintColor={theme.colors.primary} />}
      >
        {report.isError && !d ? (
          <ErrorState detail={errorText(report.error)} onRetry={() => void report.refetch()} />
        ) : (
          <>
            <View style={{ gap: theme.spacing[3] }}>
              <Stat
                label="Sales"
                value={k ? formatNPR(k.sales_cents) : ''}
                size="lg"
                loading={loading}
                hint={
                  k && k.tab_cents > 0
                    ? `Includes ${formatNPR(k.tab_cents)} on credit (owed, not cash in hand)`
                    : undefined
                }
              />
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Stat label="Orders" value={k ? String(k.order_count) : ''} loading={loading} style={{ flex: 1 }}
                  hint="Serves closed (settled) in this period." />
                <Stat label="Avg ticket" value={k ? formatNPR(k.avg_ticket_cents) : ''} loading={loading} style={{ flex: 1 }}
                  hint="Billed sales ÷ serves." />
              </View>
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Stat label="Expenses" value={k ? formatNPR(k.expenses_cents) : ''} loading={loading} style={{ flex: 1 }}
                  hint="Every expense recorded in this period, by its paid date — including salary." />
                <Stat
                  label="Net"
                  value={k ? formatNPR(k.net_cents) : ''}
                  tone={k && k.net_cents < 0 ? 'danger' : 'success'}
                  loading={loading}
                  style={{ flex: 1 }}
                  // Web spells the formula out in the label; do the same here
                  // rather than leaving a colour-coded number unexplained.
                  hint="Sales − expenses for this period. Credit collected isn't in it (that pays off earlier serves), and stock cost is counted once, inside expenses."
                />
              </View>
              {k && (k.credit_collected_cents ?? 0) > 0 ? (
                // Its own tile, never inside Sales: this is payment for credit
                // serves counted as sales on an earlier day. Drills into who
                // paid — a bare total invites "collected from whom?".
                <Stat
                  label="Credit collected"
                  value={formatNPR(k.credit_collected_cents ?? 0)}
                  hint="Paying off earlier credit serves — in your balance, not in Sales"
                  onPress={() => setCreditDrill(true)}
                  drillLabel="credit-collected-drill"
                />
              ) : null}
            </View>

            {d ? <PaymentMixBar mix={d.payment_mix} /> : null}
            {d && d.daily.length > 1 ? <SalesChart daily={d.daily} /> : null}

            {d && d.top_sellers.length > 0 ? (
              <View style={{ gap: theme.spacing[2] }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="view-all-top-sellers"
                  onPress={() => router.push('/more/top-sellers')}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <AppText variant="label">Top sellers</AppText>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    <MonoText size="2xs" style={{ color: theme.colors.stamp.brand.fg }}>
                      View all
                    </MonoText>
                    <ChevronRight size={14} color={theme.colors.stamp.brand.fg} strokeWidth={2} />
                  </View>
                </Pressable>
                {d.top_sellers.slice(0, 5).map((t) => (
                  <View key={t.menu_item_id} style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
                    <MonoText weight="bold" style={{ color: theme.colors.stamp.brand.fg }}>
                      {t.qty}×
                    </MonoText>
                    <AppText style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>
                      {t.name}
                    </AppText>
                    <MonoText numberOfLines={1} style={{ flexShrink: 0 }}>
                      {formatNPR(t.revenue_cents)}
                    </MonoText>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      <CreditCollectedSheet
        open={creditDrill}
        onClose={() => setCreditDrill(false)}
        totalCents={k?.credit_collected_cents ?? 0}
        rows={d?.credit_collected_breakdown ?? []}
      />
    </View>
  );
}

/**
 * Who paid down credit in the period. Web shows this inside the Sales-breakdown
 * modal; on a phone the tile drills straight to the rows that matter, skipping
 * the cash/online/bank split that the payment-mix bar already covers.
 *
 * `medium` (not `hug`) because the list is unbounded — one row per paying tab —
 * and only a fixed-height sheet gives AppSheet.ScrollView a scroll region.
 */
function CreditCollectedSheet({
  open,
  onClose,
  totalCents,
  rows,
}: {
  open: boolean;
  onClose: () => void;
  totalCents: number;
  rows: CreditCollectedRow[];
}) {
  const theme = useTheme();
  return (
    <AppSheet open={open} onClose={onClose} title="Credit collected" size="medium">
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[8],
          gap: theme.spacing[1],
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            paddingBottom: theme.spacing[3],
            marginBottom: theme.spacing[2],
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <AppText variant="label">Total</AppText>
          <MonoText weight="bold" size="lg">
            {formatNPR(totalCents)}
          </MonoText>
        </View>

        {rows.length === 0 ? (
          <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
            No credit collections in this period.
          </AppText>
        ) : (
          rows.map((c) => (
            <View
              key={c.house_tab_id}
              style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], paddingVertical: theme.spacing[2] }}
            >
              <View style={{ flexShrink: 1, minWidth: 0 }}>
                <AppText numberOfLines={1}>{c.name}</AppText>
                {c.count > 1 ? (
                  <MonoText size="2xs" muted>
                    {c.count} payments
                  </MonoText>
                ) : null}
              </View>
              <DottedLeader />
              <MonoText numberOfLines={1} style={{ flexShrink: 0 }}>
                {formatNPR(c.amount_cents)}
              </MonoText>
            </View>
          ))
        )}

        <AppText variant="faint" style={{ fontSize: theme.text.xs, marginTop: theme.spacing[4] }}>
          Money taken in for serves closed on earlier days. Those serves counted as sales
          back then, so this is not part of Sales — but it is in your drawer and account
          balances today.
        </AppText>
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function PaymentMixBar({ mix }: { mix: { cash_cents: number; online_cents: number; bank_cents: number } }) {
  const theme = useTheme();
  const pct = paymentMixPercents(mix);
  const total = mix.cash_cents + mix.online_cents + mix.bank_cents;
  if (total <= 0) return null;
  const segs = [
    { key: 'Cash', pct: pct.cash, color: theme.colors.stamp.brand.fg, cents: mix.cash_cents },
    { key: 'Online', pct: pct.online, color: theme.colors.stamp.info.fg, cents: mix.online_cents },
    { key: 'Bank', pct: pct.bank, color: theme.colors.stamp.success.fg, cents: mix.bank_cents },
  ].filter((s) => s.pct > 0);
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">Payment mix</AppText>
      <View style={{ flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden' }}>
        {segs.map((s) => (
          <View key={s.key} style={{ width: `${s.pct}%`, backgroundColor: s.color }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: theme.spacing[4], flexWrap: 'wrap' }}>
        {segs.map((s) => (
          <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.color }} />
            <MonoText size="2xs" muted>
              {s.key} {formatNPR(s.cents)}
            </MonoText>
          </View>
        ))}
      </View>
    </View>
  );
}

function SalesChart({ daily }: { daily: { day: string; sales_cents: number }[] }) {
  const theme = useTheme();
  const layout = useLayout();
  const chartW = layout.width - theme.spacing[5] * 2;
  const chartH = 140;
  const bars = barGeometry(daily, chartW, chartH, daily.length > 20 ? 2 : 4);
  const maxCents = Math.max(...daily.map((x) => x.sales_cents), 0);
  const fmtDay = (s: string) => {
    const t = Date.parse(s);
    return Number.isNaN(t) ? s : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <AppText variant="label">Daily sales</AppText>
        {maxCents > 0 ? (
          <MonoText size="2xs" muted>
            peak {formatNPR(maxCents)}
          </MonoText>
        ) : null}
      </View>
      <Svg width={chartW} height={chartH}>
        {bars.map((b, i) => (
          <Rect
            key={i}
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            rx={2}
            // Peak day pops in full brand amber; the rest are a visible warm
            // tint (the old primaryTint was near-invisible on paper).
            fill={maxCents > 0 && daily[i]?.sales_cents === maxCents ? theme.colors.primary : theme.colors.stamp.brand.border}
          />
        ))}
        {/* baseline — grounds the bars so the chart reads as a chart */}
        <Rect x={0} y={chartH - 1} width={chartW} height={1} fill={theme.colors.border} />
      </Svg>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <MonoText size="2xs" muted>
          {fmtDay(daily[0]?.day ?? '')}
        </MonoText>
        <MonoText size="2xs" muted>
          {fmtDay(daily[daily.length - 1]?.day ?? '')}
        </MonoText>
      </View>
    </View>
  );
}
