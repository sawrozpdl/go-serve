/**
 * Top sellers — the full item leaderboard behind the dashboard's Top-5 preview.
 * Range chips + search + revenue/qty sort, backed by /v1/reports/movers.
 */
import { useMemo, useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DashboardRange } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { TextField } from '@/components/ui/TextField';
import { Stamp } from '@/components/ui/Stamp';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useMovers } from '@/api/reports';
import { formatNPR } from '@/lib/format';

const RANGES: { value: DashboardRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export default function TopSellers() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const [range, setRange] = useState<DashboardRange>('30d');
  const [sort, setSort] = useState<'revenue' | 'qty'>('revenue');
  const [q, setQ] = useState('');

  const movers = useMovers(range, { sort, order: 'desc', q: q.trim() || undefined, limit: 200 });

  const rows = useMemo(() => movers.data?.rows ?? [], [movers.data]);

  if (me.data && !can(me.data, 'report:read')) return <Redirect href="/more" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Top sellers" />
      {/* Pinned filters — stay put while the list scrolls. */}
      <View
        style={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[3],
          paddingBottom: theme.spacing[3],
          gap: theme.spacing[3],
          backgroundColor: theme.colors.bg,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <SegmentedField value={range} options={RANGES} onChange={setRange} />
        <SegmentedField
          value={sort}
          options={[
            { value: 'revenue', label: 'By revenue' },
            { value: 'qty', label: 'By quantity' },
          ]}
          onChange={setSort}
        />
        <TextField
          placeholder="Search items…"
          value={q}
          onChangeText={setQ}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[3],
        }}
        refreshControl={
          <RefreshControl
            refreshing={movers.isRefetching}
            onRefresh={() => void movers.refetch()}
            tintColor={theme.colors.primary}
          />
        }
      >
        {movers.isLoading ? (
          Array.from({ length: 8 }, (_, i) => <Skeleton.Card key={i} lines={1} />)
        ) : movers.isError && !movers.data ? (
          <ErrorState detail={String(movers.error)} onRetry={() => void movers.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q.trim() ? 'No matching items' : 'No sales in this range'}
            hint={q.trim() ? 'Try a different search.' : 'Sales will show up here once orders are settled.'}
          />
        ) : (
          rows.map((r, i) => (
            <View
              key={r.menu_item_id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing[3],
                paddingVertical: theme.spacing[2],
                borderBottomWidth: i === rows.length - 1 ? 0 : 1,
                borderBottomColor: theme.colors.border,
              }}
            >
              <MonoText size="2xs" muted style={{ width: 24, textAlign: 'right' }}>
                {i + 1}
              </MonoText>
              <View style={{ flex: 1, gap: 2 }}>
                <AppText numberOfLines={1}>{r.name}</AppText>
                {r.category_name ? (
                  <MonoText size="2xs" muted numberOfLines={1}>
                    {r.category_name}
                  </MonoText>
                ) : null}
              </View>
              <Stamp label={`${r.qty}×`} tone="brand" size="sm" />
              <MonoText style={{ minWidth: 72, textAlign: 'right' }}>
                {formatNPR(r.revenue_cents)}
              </MonoText>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
