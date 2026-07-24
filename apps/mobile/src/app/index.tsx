/**
 * Entry resolver. Waits for token hydration, then routes to login (no session),
 * the workspace picker (no active tenant), or the app.
 */
import { Redirect, type Href } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { useMe } from '@/api/auth';
import { landingHref } from '@/auth/permissions';
import { useTheme } from '@/theme';

export default function Index() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const hasSession = useAuthStore((s) => s.hasSession);
  const active = useTenantStore((s) => s.active);
  const me = useMe();
  const theme = useTheme();

  const spinner = (
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

  if (!hydrated) return spinner;
  if (!hasSession) return <Redirect href="/(auth)/login" />;
  if (!active) return <Redirect href="/(workspace)/picker" />;
  // Resolve the landing route from capabilities (owners → dashboard, staff →
  // their tab). Wait for /me; if it errors, fall back to the floor.
  // `withAnchor` loads each navigator's anchor beneath the target, so a manager
  // landing on /more/dashboard still has the More menu under it to go back to.
  if (me.isPending) return spinner;
  return <Redirect withAnchor href={(me.data ? landingHref(me.data) : '/(app)/floor') as Href} />;
}
