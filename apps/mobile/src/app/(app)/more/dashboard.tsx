/**
 * Reports dashboard (M8). KPI tiles, a payment-mix bar, and a daily-sales bar
 * chart (hand-drawn with react-native-svg — no chart lib). Advanced analytics
 * (hourly / heatmap / mix / velocity / profitability) are a tracked follow-up.
 */
import { useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect } from 'react-native-svg';
import type { DashboardRange } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { Stat } from '@/components/ui/Stat';
import { ErrorState } from '@/components/ui/ErrorState';
import { useTheme } from '@/theme';
import { useLayout } from '@/lib/layout';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useReportsDashboard } from '@/api/reports';
import { paymentMixPercents, barGeometry } from '@/finance/calc';
import { formatNPR } from '@/lib/format';

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
  const [range, setRange] = useState<DashboardRange>('today');
  const report = useReportsDashboard(range);

  if (me.data && !can(me.data, 'report:read')) return <Redirect href="/more" />;

  const d = report.data;
  const k = d?.kpis;
  const loading = report.isLoading || !k;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Dashboard" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
        refreshControl={<RefreshControl refreshing={report.isRefetching} onRefresh={() => void report.refetch()} tintColor={theme.colors.primary} />}
      >
        <SegmentedField value={range} options={RANGES} onChange={setRange} />

        {report.isError && !d ? (
          <ErrorState detail={String(report.error)} onRetry={() => void report.refetch()} />
        ) : (
          <>
            <View style={{ gap: theme.spacing[3] }}>
              <Stat
                label="Sales"
                value={k ? formatNPR(k.sales_cents) : ''}
                size="lg"
                loading={loading}
                hint={k && k.tab_cents > 0 ? `Includes ${formatNPR(k.tab_cents)} on house tabs (owed, not cash in hand)` : undefined}
              />
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Stat label="Orders" value={k ? String(k.order_count) : ''} loading={loading} style={{ flex: 1 }} />
                <Stat label="Avg ticket" value={k ? formatNPR(k.avg_ticket_cents) : ''} loading={loading} style={{ flex: 1 }} />
              </View>
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Stat label="Expenses" value={k ? formatNPR(k.expenses_cents) : ''} loading={loading} style={{ flex: 1 }} />
                <Stat
                  label="Net"
                  value={k ? formatNPR(k.net_cents) : ''}
                  tone={k && k.net_cents < 0 ? 'danger' : 'success'}
                  loading={loading}
                  style={{ flex: 1 }}
                />
              </View>
            </View>

            {d ? <PaymentMixBar mix={d.payment_mix} /> : null}
            {d && d.daily.length > 1 ? <SalesChart daily={d.daily} /> : null}

            {d && d.top_sellers.length > 0 ? (
              <View style={{ gap: theme.spacing[2] }}>
                <AppText variant="label">Top sellers</AppText>
                {d.top_sellers.slice(0, 5).map((t) => (
                  <View key={t.menu_item_id} style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
                    <MonoText weight="bold" style={{ color: theme.colors.stamp.brand.fg }}>
                      {t.qty}×
                    </MonoText>
                    <AppText style={{ flex: 1 }} numberOfLines={1}>
                      {t.name}
                    </AppText>
                    <MonoText>{formatNPR(t.revenue_cents)}</MonoText>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
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
  const chartH = 120;
  const bars = barGeometry(daily, chartW, chartH, daily.length > 20 ? 2 : 4);
  const maxCents = Math.max(...daily.map((x) => x.sales_cents), 0);
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">Daily sales</AppText>
      <Svg width={chartW} height={chartH}>
        {bars.map((b, i) => (
          <Rect
            key={i}
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            rx={2}
            // The peak day pops in full brand amber; the rest are the quiet tint.
            fill={maxCents > 0 && daily[i]?.sales_cents === maxCents ? theme.colors.primary : theme.colors.primaryTint}
          />
        ))}
      </Svg>
    </View>
  );
}
