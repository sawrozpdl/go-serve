/**
 * More — account + workspace utilities, and the entry point to admin screens
 * as they land. For now: identity, a Printing settings link, theme, sign-out.
 */
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/ui/Screen';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { useTheme, useThemeContext, type ThemePreference } from '@/theme';
import { useMe, useLogout } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantStore } from '@/stores/tenant';
import { useOfflineQueue } from '@/offline/queue';

const PREFS: ThemePreference[] = ['system', 'light', 'dark'];

export default function More() {
  const theme = useTheme();
  const router = useRouter();
  const me = useMe();
  const logout = useLogout();
  const active = useTenantStore((s) => s.active);
  const { preference, setPreference } = useThemeContext();

  const canManageSettings = can(me.data, 'tenant:update');

  const ops = useOfflineQueue((s) => s.ops);
  const reviewCount = ops.filter((o) => o.status === 'needs_review').length;
  const pendingCount = ops.length - reviewCount;

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

        {canManageSettings ? (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Setup</AppText>
            <Row label="Printing" hint="Kitchen tickets, printer, this device" onPress={() => router.push('/more/printing')} />
          </View>
        ) : null}

        {reviewCount > 0 || pendingCount > 0 ? (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Sync</AppText>
            <Row
              label="Sync review"
              hint={
                reviewCount > 0
                  ? `${reviewCount} change${reviewCount === 1 ? '' : 's'} need review`
                  : `${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting to sync`
              }
              onPress={() => router.push('/more/sync-review')}
              badge={{ count: reviewCount || pendingCount, tone: reviewCount > 0 ? theme.colors.dangerFg : theme.colors.textMuted }}
            />
          </View>
        ) : null}

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

        <Button title="Sign out" variant="secondary" onPress={onSignOut} loading={logout.isPending} />
      </View>
    </Screen>
  );
}

function Row({
  label,
  hint,
  onPress,
  badge,
}: {
  label: string;
  hint: string;
  onPress: () => void;
  badge?: { count: number; tone: string };
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radii.md,
        padding: theme.spacing[4],
      }}
    >
      <View style={{ gap: 2, flex: 1 }}>
        <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{label}</AppText>
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {hint}
        </AppText>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
        {badge ? (
          <View
            style={{
              minWidth: 22,
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: theme.radii.pill,
              backgroundColor: badge.tone,
            }}
          >
            <AppText style={{ color: theme.colors.onBrand, fontSize: theme.text.xs, textAlign: 'center', fontFamily: theme.fonts.bodyBold }}>
              {badge.count}
            </AppText>
          </View>
        ) : null}
        <AppText style={{ color: theme.colors.textFaint, fontSize: 20 }}>›</AppText>
      </View>
    </Pressable>
  );
}
