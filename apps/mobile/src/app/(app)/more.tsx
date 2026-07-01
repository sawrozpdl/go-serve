/**
 * More — account + workspace utilities. Grows into the full admin menu in later
 * milestones (menu, inventory, staff, settings, …); for now it carries identity,
 * theme control, and sign-out.
 */
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/ui/Screen';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { useTheme, useThemeContext, type ThemePreference } from '@/theme';
import { useMe, useLogout } from '@/api/auth';
import { useTenantStore } from '@/stores/tenant';

const PREFS: ThemePreference[] = ['system', 'light', 'dark'];

export default function More() {
  const theme = useTheme();
  const router = useRouter();
  const me = useMe();
  const logout = useLogout();
  const active = useTenantStore((s) => s.active);
  const { preference, setPreference } = useThemeContext();

  async function onSignOut() {
    await logout.mutateAsync();
    router.replace('/(auth)/login');
  }

  return (
    <Screen scroll>
      <View style={{ gap: theme.spacing[7], paddingTop: theme.spacing[4] }}>
        <View style={{ gap: theme.spacing[1] }}>
          <Heading>{active?.name ?? 'Workspace'}</Heading>
          {me.data ? (
            <AppText variant="muted">
              {me.data.name} · {me.data.email}
            </AppText>
          ) : null}
        </View>

        <View style={{ gap: theme.spacing[3] }}>
          <AppText variant="label">Appearance</AppText>
          <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
            {PREFS.map((p) => {
              const selected = preference === p;
              return (
                <Pressable
                  key={p}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`theme-${p}`}
                  onPress={() => setPreference(p)}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    paddingVertical: theme.spacing[3],
                    borderRadius: theme.radii.md,
                    borderWidth: 1,
                    borderColor: selected ? theme.colors.primary : theme.colors.border,
                    backgroundColor: selected ? theme.colors.card : 'transparent',
                  }}
                >
                  <AppText style={{ textTransform: 'capitalize' }}>{p}</AppText>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Button
          title="Sign out"
          variant="secondary"
          onPress={onSignOut}
          loading={logout.isPending}
        />
      </View>
    </Screen>
  );
}
