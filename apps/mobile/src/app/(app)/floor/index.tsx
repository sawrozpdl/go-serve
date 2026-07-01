/**
 * Floor — the table grid + walk-in tabs. Occupied tiles show the live tab
 * amount, item count, age, and a derived state badge; free tiles open a tab;
 * dirty tiles can be swept clean.
 */
import { useMemo } from 'react';
import { View, Pressable, RefreshControl, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { deriveTabState, resolveTableLabel, type Order, type ServiceTable } from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { useTheme } from '@/theme';
import { useServiceTables, useSweepTable } from '@/api/tables';
import { useOrders } from '@/api/orders';
import { useMe } from '@/api/auth';
import { useTenantStore } from '@/stores/tenant';
import { can } from '@/auth/permissions';
import { formatNPR, timeAgo } from '@/lib/format';

type ToneColorKey = 'textFaint' | 'infoFg' | 'warnFgTile' | 'primary' | 'successFg';
const TONE: Record<string, ToneColorKey> = {
  neutral: 'textFaint',
  info: 'infoFg',
  warn: 'warnFgTile',
  action: 'primary',
  success: 'successFg',
};

export default function Floor() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const active = useTenantStore((s) => s.active);
  const me = useMe();
  const tables = useServiceTables();
  const orders = useOrders('open');
  const sweep = useSweepTable();

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
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + theme.spacing[4],
        paddingHorizontal: theme.spacing[5],
        paddingBottom: theme.spacing[8],
        gap: theme.spacing[6],
      }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.colors.primary} />
      }
    >
      <View style={{ gap: theme.spacing[1] }}>
        <Heading style={{ fontSize: 30 }}>Floor</Heading>
        <AppText variant="muted">{active?.name ?? 'Workspace'}</AppText>
      </View>

      {canCreate ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void Haptics.selectionAsync();
            router.push({ pathname: '/floor/[orderId]', params: { orderId: 'new' } });
          }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing[2],
            paddingVertical: theme.spacing[4],
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: theme.colors.border,
          }}
        >
          <AppText style={{ color: theme.colors.primary, fontFamily: theme.fonts.bodySemi }}>
            + New walk-in tab
          </AppText>
        </Pressable>
      ) : null}

      {walkIns.length > 0 ? (
        <Section title="Walk-ins">
          <View style={{ gap: theme.spacing[3] }}>
            {walkIns.map((o) => (
              <TabCard
                key={o.id}
                order={o}
                onPress={() => router.push({ pathname: '/floor/[orderId]', params: { orderId: o.id } })}
              />
            ))}
          </View>
        </Section>
      ) : null}

      <Section title="Tables">
        {tables.isLoading ? (
          <AppText variant="faint">Loading tables…</AppText>
        ) : (tables.data ?? []).length === 0 ? (
          <AppText variant="muted">No tables yet. Add them in Menu → Tables.</AppText>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[3] }}>
            {(tables.data ?? []).map((t) => (
              <TableTile
                key={t.id}
                table={t}
                order={byTable.get(t.id)}
                onPress={() => openTable(t)}
                onSweep={() => sweep.mutate(t.id)}
                canCreate={canCreate}
              />
            ))}
          </View>
        )}
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[3] }}>
      <AppText variant="label">{title}</AppText>
      {children}
    </View>
  );
}

function TabCard({ order, onPress }: { order: Order; onPress: () => void }) {
  const theme = useTheme();
  const state = deriveTabState(order);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radii.lg,
        padding: theme.spacing[4],
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <View style={{ gap: 2 }}>
        <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{resolveTableLabel(order)}</AppText>
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {order.items_total} items · {timeAgo(order.opened_at)}
        </AppText>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <AppText style={{ fontFamily: theme.fonts.bodySemi }}>
          {formatNPR(order.live_subtotal_cents)}
        </AppText>
        {state ? <StateBadge label={state.label} tone={state.tone} /> : null}
      </View>
    </Pressable>
  );
}

function TableTile({
  table,
  order,
  onPress,
  onSweep,
  canCreate,
}: {
  table: ServiceTable;
  order?: Order;
  onPress: () => void;
  onSweep: () => void;
  canCreate: boolean;
}) {
  const theme = useTheme();
  const occupied = !!order;
  const dirty = table.status === 'dirty' && !occupied;
  const state = order ? deriveTabState(order) : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`table-${table.name}`}
      onPress={onPress}
      disabled={dirty || (!occupied && !canCreate)}
      style={{
        width: '48%',
        minHeight: 108,
        backgroundColor: occupied ? theme.colors.card : 'transparent',
        borderColor: occupied ? theme.colors.primary : theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radii.lg,
        padding: theme.spacing[4],
        justifyContent: 'space-between',
        opacity: dirty ? 0.55 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <AppText style={{ fontFamily: theme.fonts.bodySemi, fontSize: theme.text.lg }}>
          {table.name}
        </AppText>
        <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
          {table.capacity ? `${table.capacity}p` : ''}
        </AppText>
      </View>

      {occupied ? (
        <View style={{ gap: 2 }}>
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>
            {formatNPR(order!.live_subtotal_cents)}
          </AppText>
          <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
            {order!.items_total} items · {timeAgo(order!.opened_at)}
          </AppText>
          {state ? <StateBadge label={state.label} tone={state.tone} /> : null}
        </View>
      ) : dirty ? (
        <Pressable
          accessibilityRole="button"
          onPress={onSweep}
          hitSlop={8}
          style={{ alignSelf: 'flex-start' }}
        >
          <AppText variant="label" style={{ color: theme.colors.warnFgTile }}>
            Dirty · tap to clear
          </AppText>
        </Pressable>
      ) : (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {table.area || 'Open tab'}
        </AppText>
      )}
    </Pressable>
  );
}

function StateBadge({ label, tone }: { label: string; tone: string }) {
  const theme = useTheme();
  const colorKey = TONE[tone] ?? 'textFaint';
  const color = theme.colors[colorKey];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        marginTop: 2,
        paddingHorizontal: theme.spacing[2],
        paddingVertical: 1,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: color,
      }}
    >
      <AppText style={{ color, fontSize: theme.text['2xs'], fontFamily: theme.fonts.bodySemi }}>
        {label}
      </AppText>
    </View>
  );
}
