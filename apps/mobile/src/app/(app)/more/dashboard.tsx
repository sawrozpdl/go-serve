/**
 * Reports dashboard (M8). KPI cards, a payment-mix bar, and a daily-sales bar
 * chart (hand-drawn with react-native-svg — no chart lib). Advanced analytics
 * (hourly / heatmap / mix / velocity / profitability) are a tracked follow-up.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl, useWindowDimensions } from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect } from 'react-native-svg';
import { ChevronLeft } from 'lucide-react-native';
import type { DashboardRange } from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme } from '@/theme';
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
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const [range, setRange] = useState<DashboardRange>('today');
  const report = useReportsDashboard(range);

  if (me.data && !can(me.data, 'report:read')) return <Redirect href="/more" />;

  const d = report.data;
  const k = d?.kpis;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
        refreshControl={<RefreshControl refreshing={report.isRefetching} onRefresh={() => void report.refetch()} tintColor={theme.colors.primary} />}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <ChevronLeft size={26} color={theme.colors.primary} />
          </Pressable>
          <Heading style={{ fontSize: 26 }}>Dashboard</Heading>
        </View>

        <SegmentedField value={range} options={RANGES} onChange={setRange} />

        {report.isLoading || !k ? (
          <AppText variant="faint">Loading…</AppText>
        ) : (
          <>
            <View style={{ gap: theme.spacing[3] }}>
              <Kpi label="Sales" value={formatNPR(k.sales_cents)} big />
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Kpi label="Orders" value={String(k.order_count)} />
                <Kpi label="Avg ticket" value={formatNPR(k.avg_ticket_cents)} />
              </View>
              <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                <Kpi label="Expenses" value={formatNPR(k.expenses_cents)} />
                <Kpi label="Net" value={formatNPR(k.net_cents)} tone={k.net_cents < 0 ? theme.colors.dangerFg : theme.colors.successFg} />
              </View>
              {k.tab_cents > 0 ? (
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  Includes {formatNPR(k.tab_cents)} on house tabs (owed, not cash in hand)
                </AppText>
              ) : null}
            </View>

            {d ? <PaymentMixBar mix={d.payment_mix} /> : null}
            {d && d.daily.length > 1 ? <SalesChart daily={d.daily} /> : null}

            {d && d.top_sellers.length > 0 ? (
              <View style={{ gap: theme.spacing[2] }}>
                <AppText variant="label">Top sellers</AppText>
                {d.top_sellers.slice(0, 5).map((t) => (
                  <View key={t.menu_item_id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <AppText style={{ flex: 1 }} numberOfLines={1}>{t.qty}× {t.name}</AppText>
                    <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{formatNPR(t.revenue_cents)}</AppText>
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

function Kpi({ label, value, big, tone }: { label: string; value: string; big?: boolean; tone?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4], gap: 2 }}>
      <AppText variant="faint" style={{ fontSize: theme.text.xs }}>{label}</AppText>
      <AppText style={{ fontFamily: theme.fonts.bodyBold, fontSize: big ? 30 : theme.text.lg, color: tone ?? theme.colors.text }}>{value}</AppText>
    </View>
  );
}

function PaymentMixBar({ mix }: { mix: { cash_cents: number; online_cents: number; bank_cents: number } }) {
  const theme = useTheme();
  const pct = paymentMixPercents(mix);
  const total = mix.cash_cents + mix.online_cents + mix.bank_cents;
  if (total <= 0) return null;
  const segs = [
    { key: 'Cash', pct: pct.cash, color: theme.colors.primary, cents: mix.cash_cents },
    { key: 'Online', pct: pct.online, color: theme.colors.infoFg, cents: mix.online_cents },
    { key: 'Bank', pct: pct.bank, color: theme.colors.accent, cents: mix.bank_cents },
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
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>{s.key} {formatNPR(s.cents)}</AppText>
          </View>
        ))}
      </View>
    </View>
  );
}

function SalesChart({ daily }: { daily: { day: string; sales_cents: number }[] }) {
  const theme = useTheme();
  const { width: screenW } = useWindowDimensions();
  const chartW = screenW - theme.spacing[5] * 2;
  const chartH = 120;
  const bars = barGeometry(daily, chartW, chartH, daily.length > 20 ? 2 : 4);
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">Daily sales</AppText>
      <Svg width={chartW} height={chartH}>
        {bars.map((b, i) => (
          <Rect key={i} x={b.x} y={b.y} width={b.width} height={b.height} rx={2} fill={theme.colors.primary} />
        ))}
      </Svg>
    </View>
  );
}
