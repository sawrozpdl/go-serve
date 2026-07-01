/**
 * Authenticated app shell. Phone: bottom tabs (Floor / Kitchen / History / More),
 * each shown only if the user's permissions allow it (More is always present).
 * Tablet split-view lands in M2 alongside the real floor/detail panes.
 */
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/** Outline when inactive, filled when focused — the modern tab-bar idiom. */
function icon(active: IoniconName, inactive: IoniconName) {
  const TabBarIcon = ({ color, focused }: { color: ColorValue; focused: boolean }) => (
    <Ionicons name={focused ? active : inactive} size={23} color={color} />
  );
  return TabBarIcon;
}

export default function AppLayout() {
  const theme = useTheme();
  const hydrated = useAuthStore((s) => s.hydrated);
  const hasSession = useAuthStore((s) => s.hasSession);
  const active = useTenantStore((s) => s.active);
  const me = useMe();

  if (hydrated && !hasSession) return <Redirect href="/(auth)/login" />;
  if (hydrated && hasSession && !active) return <Redirect href="/(workspace)/picker" />;

  const canFloor = can(me.data, 'order:read') || can(me.data, 'order:create');
  const canKitchen = can(me.data, 'kitchen:read') || can(me.data, 'kitchen:update');
  const canHistory = can(me.data, 'order:read') || can(me.data, 'report:read');

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textFaint,
        tabBarLabelStyle: { fontFamily: theme.fonts.bodyMedium, fontSize: 11 },
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
          paddingTop: 6,
        },
      }}
    >
      <Tabs.Screen
        name="floor"
        options={{ title: 'Floor', href: canFloor ? '/(app)/floor' : null, tabBarIcon: icon('grid', 'grid-outline') }}
      />
      <Tabs.Screen
        name="kitchen"
        options={{ title: 'Kitchen', href: canKitchen ? '/(app)/kitchen' : null, tabBarIcon: icon('flame', 'flame-outline') }}
      />
      <Tabs.Screen
        name="history"
        options={{ title: 'History', href: canHistory ? '/(app)/history' : null, tabBarIcon: icon('receipt', 'receipt-outline') }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: 'More', tabBarIcon: icon('apps', 'apps-outline') }}
      />
    </Tabs>
  );
}
