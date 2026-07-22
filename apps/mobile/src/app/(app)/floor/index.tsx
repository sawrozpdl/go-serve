/**
 * Floor — the table grid + walk-in tabs on the Docket surface. A pinned top
 * bar carries the cafe wordmark, a live/offline stamp and the "New walk-in"
 * action; only the grid scrolls beneath it. Occupied tiles carry the amber
 * edge + live total; free tiles stay quiet; dirty tiles sweep.
 */
import { useMemo } from 'react';
import { View, RefreshControl, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { haptics } from '@/lib/haptics';
import { Armchair, Plus } from 'lucide-react-native';
import { type Order, type ServiceTable } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Fab } from '@/components/ui/Fab';
import { Section } from '@/components/ui/Section';
import { Grid } from '@/components/ui/Grid';
import { Stamp } from '@/components/ui/Stamp';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { EmptyState } from '@/components/ui/EmptyState';
import { TabCard } from '@/components/order/TabCard';
import { TableTile } from '@/components/order/TableTile';
import { useTheme } from '@/theme';
import { useLayout } from '@/lib/layout';
import { useServiceTables, useSweepTable } from '@/api/tables';
import { useOrders } from '@/api/orders';
import { useMe } from '@/api/auth';
import { useTenantStore } from '@/stores/tenant';
import { useConnectivity } from '@/stores/connectivity';
import { startDraft } from '@/stores/draftCart';
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
  // Compact 2-col tile grid on phones (matches the mockup's tile-grid), more
  // columns on tablets.
  const cols = layout.columns(170, 2, 6);
  const titleKey = layout.isTablet ? '4xl' : '3xl';
  const refreshing = tables.isRefetching || orders.isRefetching;
  const refresh = () => {
    void tables.refetch();
    void orders.refetch();
  };

  function openTable(t: ServiceTable) {
    haptics.selection();
    const existing = byTable.get(t.id);
    if (existing) router.push({ pathname: '/floor/[orderId]', params: { orderId: existing.id } });
    else if (canCreate) {
      // Begin a fresh on-device draft for this table — no order is created on
      // the server until it's first sent to the kitchen, so the table stays free.
      startDraft(t.id, t.name);
      router.push({ pathname: '/floor/[orderId]/menu', params: { orderId: 'new', tableId: t.id, tableName: t.name } });
    }
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
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[8],
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.colors.primary} />
        }
      >
        {walkIns.length > 0 ? (
          // Plain rows with explicit margins. Reanimated `layout`/`entering`
          // animations don't compose with sibling spacing — they repositioned
          // rows and left the last one bleeding into the Tables header — so the
          // per-row animation wrappers were dropped here. The Section's own
          // marginBottom guarantees clear separation before Tables.
          <Section title="Walk-ins" count={walkIns.length} style={{ marginBottom: theme.spacing[5] }}>
            <View>
              {walkIns.map((o) => (
                <View key={o.id} style={{ marginBottom: theme.spacing[3] }}>
                  <TabCard
                    order={o}
                    onPress={() => router.push({ pathname: '/floor/[orderId]', params: { orderId: o.id } })}
                  />
                </View>
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
                <TableTile
                  key={t.id}
                  table={t}
                  order={byTable.get(t.id)}
                  onPress={() => openTable(t)}
                  onSweep={() => sweep.mutate(t.id)}
                  canCreate={canCreate}
                />
              ))}
            </Grid>
          )}
        </Section>
      </ScrollView>

      {canCreate ? (
        <Fab
          accessibilityLabel="new-walkin"
          icon={<Plus size={26} color={theme.colors.onBrand} strokeWidth={2.4} />}
          onPress={() => {
            haptics.selection();
            // Fresh walk-in draft (no table) — created on the server only on send.
            startDraft(null, null);
            router.push({ pathname: '/floor/[orderId]/menu', params: { orderId: 'new' } });
          }}
        />
      ) : null}
    </View>
  );
}
