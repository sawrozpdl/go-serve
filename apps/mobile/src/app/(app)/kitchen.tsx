/**
 * Kitchen display (KDS). A live board of sent tickets, split into In progress
 * and Ready via a segmented toggle (phone-first; one column at a time reads
 * better than two cramped columns). Follows the app's colour scheme like every
 * other screen. Marking ready/served syncs across devices over the WS `kitchen`
 * topic. A per-device alert buzzes when a genuinely new ticket lands.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Pressable, RefreshControl } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haptics } from '@/lib/haptics';
import { Bell, BellOff, ChefHat, UtensilsCrossed } from 'lucide-react-native';
import { resolveTableLabel, type KitchenTicket } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { TicketCard } from '@/components/kitchen/TicketCard';
import { useTheme } from '@/theme';
import { useLayout } from '@/lib/layout';
import { useKitchenTickets, useUpdateKitchenTicket } from '@/api/kitchen';
import { useKitchenPrefs } from '@/stores/kitchenPrefs';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { partitionTickets, findNewInProgress } from '@/kitchen/board';
import { toast } from '@/lib/toast';

type Column = 'in_progress' | 'ready';

export default function Kitchen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const me = useMe();
  const tickets = useKitchenTickets();
  const update = useUpdateKitchenTicket();
  const alertsOn = useKitchenPrefs((s) => s.alertsOn);
  const setAlertsOn = useKitchenPrefs((s) => s.setAlertsOn);

  const canAct = can(me.data, 'kitchen:update');
  const [col, setCol] = useState<Column>('in_progress');

  // Tick "now" so elapsed labels stay current without refetching.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  // Buzz once when a genuinely-new in-progress ticket arrives (not every
  // refetch, and not for the queue already present on open). Ref + haptic only
  // — no setState here, so no render cascade.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!tickets.data) return;
    const { ids, hasNew } = findNewInProgress(seen.current, tickets.data);
    seen.current = ids;
    if (hasNew && alertsOn) haptics.notifySuccess();
  }, [tickets.data, alertsOn]);

  const { inProgress, ready } = partitionTickets(tickets.data ?? []);
  const list = col === 'in_progress' ? inProgress : ready;

  function markReady(t: KitchenTicket) {
    haptics.selection();
    update.mutate(
      { itemId: t.item_id, kitchen_status: 'ready' },
      {
        onSuccess: () => toast.success(`${t.menu_item_name} ready`, resolveTableLabel(t, 'Take-away')),
        onError: (e) => toast.error('Could not mark ready', (e as Error).message),
      },
    );
  }
  function markServed(t: KitchenTicket) {
    haptics.selection();
    update.mutate(
      { itemId: t.item_id, kitchen_status: 'served' },
      {
        onSuccess: () => toast.success(`${t.menu_item_name} served`, resolveTableLabel(t, 'Take-away')),
        onError: (e) => toast.error('Could not mark served', (e as Error).message),
      },
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {/* Sticky top bar */}
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
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <AppText
            style={{
              fontFamily: theme.fonts.bodySemi,
              fontSize: theme.typeStyles['3xl'].size,
              lineHeight: theme.typeStyles['3xl'].lineHeight,
            }}
          >
            Kitchen
          </AppText>
          <Pressable
            onPress={() => {
              haptics.selection();
              setAlertsOn(!alertsOn);
            }}
            hitSlop={10}
            accessibilityRole="switch"
            accessibilityState={{ checked: alertsOn }}
            accessibilityLabel="new-order-alerts"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: theme.spacing[3],
              height: 38,
              borderRadius: theme.radii.pill,
              borderWidth: 1,
              borderColor: alertsOn ? theme.colors.primary : theme.colors.border,
              backgroundColor: alertsOn ? theme.colors.primaryWash : 'transparent',
            }}
          >
            {alertsOn ? (
              <Bell size={16} color={theme.colors.primary} />
            ) : (
              <BellOff size={16} color={theme.colors.textMuted} />
            )}
            <AppText
              style={{
                color: alertsOn ? theme.colors.primary : theme.colors.textMuted,
                fontFamily: theme.fonts.bodySemi,
                fontSize: theme.text.sm,
              }}
            >
              {alertsOn ? 'Alerts on' : 'Muted'}
            </AppText>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
          <Segment label="In progress" count={inProgress.length} active={col === 'in_progress'} onPress={() => setCol('in_progress')} />
          <Segment label="Ready" count={ready.length} active={col === 'ready'} onPress={() => setCol('ready')} />
        </View>
      </View>

      {tickets.isError && !tickets.data ? (
        // A failed fetch used to read as "No tickets cooking" — actively harmful
        // in a kitchen. Say what happened and offer a retry.
        <ErrorState detail={String(tickets.error)} onRetry={() => void tickets.refetch()} />
      ) : (
        <FlashList
          data={list}
          numColumns={layout.isTablet ? 2 : 1}
          keyExtractor={(t) => t.item_id}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing[5],
            paddingTop: theme.spacing[4],
            paddingBottom: insets.bottom + theme.spacing[8],
          }}
          ItemSeparatorComponent={() => <View style={{ height: theme.spacing[3] }} />}
          refreshControl={
            <RefreshControl refreshing={tickets.isRefetching} onRefresh={() => void tickets.refetch()} tintColor={theme.colors.primary} />
          }
          ListEmptyComponent={
            tickets.isLoading ? (
              <AppText variant="faint" style={{ textAlign: 'center', marginTop: theme.spacing[8] }}>
                Loading tickets…
              </AppText>
            ) : (
              <EmptyState
                icon={
                  col === 'ready' ? (
                    <UtensilsCrossed size={28} color={theme.colors.textMuted} />
                  ) : (
                    <ChefHat size={28} color={theme.colors.textMuted} />
                  )
                }
                title={col === 'ready' ? 'Nothing waiting for pickup' : 'No tickets cooking'}
                hint={
                  col === 'ready'
                    ? 'Items you mark ready show up here.'
                    : 'New orders appear the moment a waiter sends them.'
                }
              />
            )
          }
          renderItem={({ item }) => (
            <TicketCard
              ticket={item}
              now={now}
              canAct={canAct}
              busy={update.isPending}
              onAction={() => (col === 'in_progress' ? markReady(item) : markServed(item))}
            />
          )}
        />
      )}
    </View>
  );
}

function Segment({ label, count, active, onPress }: { label: string; count: number; active: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: active ? theme.colors.primary : theme.colors.border,
        backgroundColor: active ? theme.colors.primaryTint : theme.colors.card,
      }}
    >
      <AppText style={{ fontFamily: theme.fonts.bodySemi, color: active ? theme.colors.text : theme.colors.textMuted }}>
        {label}
      </AppText>
      <View
        style={{
          minWidth: 22,
          paddingHorizontal: 6,
          paddingVertical: 1,
          borderRadius: theme.radii.pill,
          backgroundColor: active ? theme.colors.primary : theme.colors.border,
        }}
      >
        <AppText style={{ fontSize: theme.text.xs, textAlign: 'center', fontFamily: theme.fonts.bodyBold, color: active ? theme.colors.onBrand : theme.colors.textMuted }}>
          {count}
        </AppText>
      </View>
    </Pressable>
  );
}
