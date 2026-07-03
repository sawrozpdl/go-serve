/**
 * Tabs — stakeholder running ledgers ("Owner A", "Staff meals", a regular
 * running on credit). Charging an order to a tab happens in the settle flow;
 * this screen is where you view the ledger, record a settlement, and
 * archive/delete. Mirrors web's HouseTabsPage. Distinct from a walk-in order's
 * table_label (see TicketPanel's rename) — this is a person/account, not a
 * single tab of items.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Bookmark } from 'lucide-react-native';
import { AppText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { Stamp } from '@/components/ui/Stamp';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useTheme } from '@/theme';
import { formatNPR } from '@/lib/format';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useHouseTabs } from '@/api/houseTabs';
import { NewHouseTabSheet } from '@/components/houseTabs/NewHouseTabSheet';
import { HouseTabDetailSheet } from '@/components/houseTabs/HouseTabDetailSheet';

export default function HouseTabs() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const tabs = useHouseTabs();

  const [newOpen, setNewOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const canCreate = can(me.data, 'house_tab:create');
  if (me.data && !can(me.data, 'house_tab:read')) return <Redirect href="/more" />;

  const list = tabs.data ?? [];
  const activeTabs = list.filter((t) => t.is_active);
  const archivedTabs = list.filter((t) => !t.is_active);
  const outstanding = list.reduce((sum, t) => sum + Math.max(0, t.balance_cents), 0);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Tabs"
        right={
          canCreate ? (
            <Pressable onPress={() => setNewOpen(true)} hitSlop={10} accessibilityLabel="add-house-tab">
              <Plus size={24} color={theme.colors.primary} />
            </Pressable>
          ) : undefined
        }
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
      >
        <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
          <Stat label="Outstanding" value={formatNPR(outstanding)} loading={tabs.isPending} style={{ flex: 1 }} />
          <Stat label="Active" value={String(activeTabs.length)} loading={tabs.isPending} style={{ flex: 1 }} />
          <Stat label="Archived" value={String(archivedTabs.length)} loading={tabs.isPending} style={{ flex: 1 }} />
        </View>

        {tabs.isPending ? (
          <View style={{ gap: theme.spacing[3] }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={72} radius={theme.radii.lg} />
            ))}
          </View>
        ) : tabs.isError ? (
          <ErrorState detail={String(tabs.error)} onRetry={() => void tabs.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Bookmark size={28} color={theme.colors.textMuted} />}
            title="No tabs yet"
            hint="Add a tab for each stakeholder you want to track separately — an owner, a regular running on credit, or a staff-meals bucket."
          />
        ) : (
          <View style={{ gap: theme.spacing[3] }}>
            {list.map((t) => (
              <Card key={t.id} onPress={() => setOpenId(t.id)} style={{ gap: theme.spacing[2] }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[2] }}>
                  <AppText style={{ fontFamily: theme.fonts.bodyMedium, flex: 1 }} numberOfLines={1}>
                    {t.name}
                  </AppText>
                  <Stamp label={t.is_active ? 'Active' : 'Archived'} tone={t.is_active ? 'success' : 'neutral'} size="sm" />
                </View>
                {t.notes ? (
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
                    {t.notes}
                  </AppText>
                ) : null}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
                    Charged {formatNPR(t.charged_cents)} · Settled {formatNPR(t.settled_cents)}
                  </AppText>
                  <AppText
                    style={{
                      fontFamily: theme.fonts.bodySemi,
                      color: t.balance_cents > 0 ? theme.colors.stamp.brand.fg : theme.colors.textFaint,
                    }}
                  >
                    {formatNPR(t.balance_cents)}
                  </AppText>
                </View>
              </Card>
            ))}
          </View>
        )}
      </ScrollView>

      <NewHouseTabSheet open={newOpen} onClose={() => setNewOpen(false)} />
      <HouseTabDetailSheet id={openId} onClose={() => setOpenId(null)} />
    </View>
  );
}
