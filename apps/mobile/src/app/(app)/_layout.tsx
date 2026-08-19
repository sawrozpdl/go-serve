/**
 * Authenticated app shell. Phone: bottom tabs (Floor / Kitchen / History / More),
 * each shown only if the user's permissions allow it (More is always present).
 * Tablet split-view lands in M2 alongside the real floor/detail panes.
 */
import { View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, Tabs } from 'expo-router';
import { LayoutGrid, ChefHat, Clock3, MoreHorizontal } from 'lucide-react-native';
import { OfflineBanner } from '@/components/OfflineBanner';
import { DemoBanner } from '@/components/DemoBanner';
import { TabBar, type TabBarProps } from '@/components/ui/TabBar';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useRealtime } from '@/realtime/useRealtime';
import { useConnectivityWatcher } from '@/realtime/useConnectivityWatcher';
import { useOfflineReplay } from '@/offline/useOfflineReplay';

export default function AppLayout() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const hasSession = useAuthStore((s) => s.hasSession);
  const demo = useAuthStore((s) => s.demo);
  const active = useTenantStore((s) => s.active);
  const insets = useSafeAreaInsets();
  const me = useMe();

  // Live updates + connectivity + offline-queue replay for the whole surface.
  useRealtime();
  useConnectivityWatcher();
  useOfflineReplay();

  if (hydrated && !hasSession) return <Redirect href="/(auth)/login" />;
  if (hydrated && hasSession && !active) return <Redirect href="/(workspace)/picker" />;

  const canFloor = can(me.data, 'order:read') || can(me.data, 'order:create');
  const canKitchen = can(me.data, 'kitchen:read') || can(me.data, 'kitchen:update');
  const canHistory = can(me.data, 'order:read') || can(me.data, 'report:read');

  return (
    <View style={{ flex: 1 }}>
    {/* The demo strip owns the top safe area, so the screens beneath it must not
        pad for a status bar it is already clearing — otherwise every screen gains
        a dead ~40pt band. Only `top` is overridden, and only for this subtree;
        Toasts and AppSheet render from the root provider and keep the real inset. */}
    <DemoBanner />
    <SafeAreaInsetsContext.Provider value={demo ? { ...insets, top: 0 } : insets}>
    <Tabs
      tabBar={(props) => <TabBar {...(props as unknown as TabBarProps)} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen
        name="floor"
        options={{
          title: 'Floor',
          href: canFloor ? '/(app)/floor' : null,
          tabBarIcon: ({ color, size }) => <LayoutGrid size={size} color={color} strokeWidth={2.2} />,
        }}
      />
      <Tabs.Screen
        name="kitchen"
        options={{
          title: 'Kitchen',
          href: canKitchen ? '/(app)/kitchen' : null,
          tabBarIcon: ({ color, size }) => <ChefHat size={size} color={color} strokeWidth={2.2} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          href: canHistory ? '/(app)/history' : null,
          tabBarIcon: ({ color, size }) => <Clock3 size={size} color={color} strokeWidth={2.2} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size }) => <MoreHorizontal size={size} color={color} strokeWidth={2.2} />,
        }}
      />
    </Tabs>
    </SafeAreaInsetsContext.Provider>
      <OfflineBanner />
    </View>
  );
}
