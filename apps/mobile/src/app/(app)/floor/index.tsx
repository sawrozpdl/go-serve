/**
 * Floor — the table grid + walk-in tabs on the Docket surface. A pinned top
 * bar carries the cafe wordmark, a live/offline stamp and the "New walk-in"
 * action; only the grid scrolls beneath it. Occupied tiles carry the amber
 * edge + live total; free tiles stay quiet; dirty tiles sweep.
 */
import { useMemo } from 'react';
import { View, RefreshControl, ScrollView } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Armchair } from 'lucide-react-native';
import { type Order, type ServiceTable } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Section } from '@/components/ui/Section';
import { Grid } from '@/components/ui/Grid';
import { Stamp } from '@/components/ui/Stamp';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { TabCard } from '@/components/order/TabCard';
import { TableTile } from '@/components/order/TableTile';
import { useTheme } from '@/theme';
import { enterUp, exitFade, listLayout } from '@/theme/motion';
import { useLayout } from '@/lib/layout';
import { useServiceTables, useSweepTable } from '@/api/tables';
import { useOrders } from '@/api/orders';
import { useMe } from '@/api/auth';
import { useTenantStore } from '@/stores/tenant';
import { useConnectivity } from '@/stores/connectivity';
import { can } from '@/auth/permissions';

export default function Floor() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const me = useMe();
  const tables = useServiceTables();
  const orders = useOrders('open');
  const sweep = useSweepTable();
  const cafeName = useTenantStore((s) => s.active?.name);
  const offline = useConnectivity((s) => s.mode === 'offline');

  const canCreate = can(me.data, 'order:create');

  const { byTable, walkIns } = useMemo(() => {
    const map = new Map<string, Order>();
    const walk: Order[] = [];
    for (const o of orders.data ?? []) {
      if (o.service_table_id) map.set(o.service_table_id, o);
      else walk.push(o);
    }
    return { byTable: map, walkIns: walk };
  }, [orders.data]);

  const tablesData = tables.data ?? [];
  const cols = layout.columns(170, 2, 6);
  const titleKey = layout.isTablet ? '4xl' : '3xl';
  const refreshing = tables.isRefetching || orders.isRefetching;
  const refresh = () => {
    void tables.refetch();
    void orders.refetch();
  };

  function openTable(t: ServiceTable) {
    void Haptics.selectionAsync();
    const existing = byTable.get(t.id);
    if (existing) router.push({ pathname: '/floor/[orderId]', params: { orderId: existing.id } });
    else if (canCreate)
      router.push({ pathname: '/floor/[orderId]', params: { orderId: 'new', tableId: t.id, tableName: t.name } });
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {/* Pinned header */}
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
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ gap: theme.spacing[1], flex: 1 }}>
            {cafeName ? (
              <MonoText
                size="2xs"
                style={{ letterSpacing: 1.6, textTransform: 'uppercase', color: theme.colors.stamp.brand.fg }}
              >
                {cafeName}
              </MonoText>
            ) : null}
            <AppText
              style={{
                fontFamily: theme.fonts.bodySemi,
                fontSize: theme.typeStyles[titleKey].size,
                lineHeight: theme.typeStyles[titleKey].lineHeight,
              }}
            >
              Floor
            </AppText>
          </View>
          <View style={{ paddingTop: theme.spacing[1] }}>
            <Stamp label={offline ? 'Offline' : 'Live'} tone={offline ? 'warn' : 'success'} size="sm" dot />
          </View>
        </View>

        {canCreate ? (
          <Button
            title="New walk-in tab"
            accessibilityLabel="new-walkin"
            onPress={() => {
              void Haptics.selectionAsync();
              router.push({ pathname: '/floor/[orderId]', params: { orderId: 'new' } });
            }}
          />
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[8],
          gap: theme.spacing[6],
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.colors.primary} />
        }
      >
        {walkIns.length > 0 ? (
          <Section title="Walk-ins" count={walkIns.length}>
            <View style={{ gap: theme.spacing[3] }}>
              {walkIns.map((o) => (
                <Animated.View key={o.id} entering={enterUp} exiting={exitFade} layout={listLayout}>
                  <TabCard
                    order={o}
                    onPress={() => router.push({ pathname: '/floor/[orderId]', params: { orderId: o.id } })}
                  />
                </Animated.View>
              ))}
            </View>
          </Section>
        ) : null}

        <Section title="Tables" count={tablesData.length || undefined}>
          {tables.isLoading ? (
            <Grid columns={cols}>
              {Array.from({ length: cols * 2 }, (_, i) => (
                <Skeleton.Card key={i} lines={1} />
              ))}
            </Grid>
          ) : tables.isError ? (
            <ErrorState detail={String(tables.error)} onRetry={refresh} />
          ) : tablesData.length === 0 ? (
            <EmptyState
              icon={<Armchair size={28} color={theme.colors.textMuted} />}
              title="No tables yet"
              hint="Add tables from the web dashboard to seat guests here."
            />
          ) : (
            <Grid columns={cols} testID="tables-grid">
              {tablesData.map((t) => (
                <Animated.View key={t.id} entering={enterUp} exiting={exitFade} layout={listLayout}>
                  <TableTile
                    table={t}
                    order={byTable.get(t.id)}
                    onPress={() => openTable(t)}
                    onSweep={() => sweep.mutate(t.id)}
                    canCreate={canCreate}
                  />
                </Animated.View>
              ))}
            </Grid>
          )}
        </Section>
      </ScrollView>
    </View>
  );
}
