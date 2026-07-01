/**
 * Authenticated app shell. Phone: bottom tabs (Floor / Kitchen / History / More),
 * each shown only if the user's permissions allow it (More is always present).
 * Tablet split-view lands in M2 alongside the real floor/detail panes.
 */
import { Redirect, Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';

function TabIcon({ emoji, color }: { emoji: string; color: ColorValue }) {
  return <Text style={{ fontSize: 20, color }}>{emoji}</Text>;
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
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
      }}
    >
      <Tabs.Screen
        name="floor"
        options={{
          title: 'Floor',
          href: canFloor ? '/(app)/floor' : null,
          tabBarIcon: ({ color }) => <TabIcon emoji="🍽️" color={color} />,
        }}
      />
      <Tabs.Screen
        name="kitchen"
        options={{
          title: 'Kitchen',
          href: canKitchen ? '/(app)/kitchen' : null,
          tabBarIcon: ({ color }) => <TabIcon emoji="👨‍🍳" color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          href: canHistory ? '/(app)/history' : null,
          tabBarIcon: ({ color }) => <TabIcon emoji="🧾" color={color} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color }) => <TabIcon emoji="⋯" color={color} />,
        }}
      />
    </Tabs>
  );
}
