/**
 * Workspace picker. Lists the user's active memberships; selecting one sets the
 * active tenant and enters the app. Single-membership users are auto-selected.
 */
import { useEffect } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/ui/Screen';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/theme';
import { useMe, useLogout } from '@/api/auth';
import { activeMemberships } from '@/auth/permissions';
import { useTenantStore, type ActiveTenant } from '@/stores/tenant';

export default function Picker() {
  const theme = useTheme();
  const router = useRouter();
  const me = useMe();
  const logout = useLogout();
  const setActive = useTenantStore((s) => s.setActive);

  const memberships = activeMemberships(me.data);

  function choose(t: ActiveTenant) {
    setActive(t);
    router.replace('/(app)/floor');
  }

  // Auto-select when there's exactly one workspace.
  useEffect(() => {
    if (me.isSuccess && memberships.length === 1) {
      const m = memberships[0];
      setActive({ slug: m.tenant_slug, id: m.tenant_id, name: m.tenant_name });
      router.replace('/(app)/floor');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.isSuccess, memberships.length]);

  if (me.isLoading) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View style={{ gap: theme.spacing[6], paddingTop: theme.spacing[8] }}>
        <Heading>Choose a workspace</Heading>

        {me.isError ? (
          <AppText style={{ color: theme.colors.dangerFg }}>
            Could not load your workspaces. Pull to retry or sign out.
          </AppText>
        ) : null}

        {me.isSuccess && memberships.length === 0 ? (
          <AppText variant="muted">
            You don&apos;t have access to any workspace yet. Ask an owner to invite you.
          </AppText>
        ) : null}

        <View style={{ gap: theme.spacing[3] }}>
          {memberships.map((m) => (
            <Pressable
              key={m.tenant_id}
              accessibilityRole="button"
              accessibilityLabel={`workspace-${m.tenant_slug}`}
              onPress={() =>
                choose({ slug: m.tenant_slug, id: m.tenant_id, name: m.tenant_name })
              }
              style={{
                backgroundColor: theme.colors.card,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: theme.radii.lg,
                padding: theme.spacing[5],
                gap: theme.spacing[1],
              }}
            >
              <AppText style={{ fontWeight: '700' }}>{m.tenant_name}</AppText>
              <AppText variant="faint">
                {m.roles.length ? m.roles.join(', ') : m.tenant_slug}
              </AppText>
            </Pressable>
          ))}
        </View>

        <Button title="Sign out" variant="ghost" onPress={() => void logout.mutateAsync()} />
      </View>
    </Screen>
  );
}
