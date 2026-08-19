/**
 * Workspace picker. Lists the user's active memberships; selecting one sets the
 * active tenant and enters the app. Single-membership users are auto-selected.
 *
 * A visitor with NO active membership is redirected to /no-access rather than
 * shown a message here. Go Serve is invite-only but Google sign-in still creates
 * the user, so this is the normal landing spot for anyone who signs in without an
 * invite — and it used to be a dead end with nothing on it but Sign out, which is
 * how a Play reviewer got stuck.
 */
import { useEffect } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { Screen } from '@/components/ui/Screen';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { useTheme } from '@/theme';
import { useMe, useLogout } from '@/api/auth';
import { activeMemberships } from '@/auth/permissions';
import { errorText } from '@/lib/errorText';
import { noAccessHref } from '@/lib/routes';
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

  // Nothing to choose between: hand them to the designed access page, which can
  // offer the demo and a way to contact us. Declarative rather than an effect so
  // there's no flash of an empty list and no back-stack entry pointing at it.
  if (me.isSuccess && memberships.length === 0) {
    const anyMembership = (me.data?.memberships ?? []).length > 0;
    return <Redirect href={noAccessHref(anyMembership ? 'membership-pending' : 'no-workspace')} />;
  }

  return (
    <Screen scroll>
      <View style={{ gap: theme.spacing[6], paddingTop: theme.spacing[8] }}>
        <Heading>Choose a workspace</Heading>

        {/* A real retry, not the old "pull to retry" line — this Screen has no
            RefreshControl, so that instruction did nothing. */}
        {me.isError ? (
          <ErrorState
            detail={errorText(me.error)}
            onRetry={() => void me.refetch()}
          />
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
