/**
 * Entry resolver. Waits for token hydration, then routes to login (no session),
 * the workspace picker (no active tenant), or the app.
 */
import { Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { useTheme } from '@/theme';

export default function Index() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const hasSession = useAuthStore((s) => s.hasSession);
  const active = useTenantStore((s) => s.active);
  const theme = useTheme();

  if (!hydrated) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  if (!hasSession) return <Redirect href="/(auth)/login" />;
  if (!active) return <Redirect href="/(workspace)/picker" />;
  return <Redirect href="/(app)/floor" />;
}
