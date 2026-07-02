/**
 * Workspace settings (M9) — the POS behaviour toggles that live on
 * tenant.preferences. Branding, VAT, and opening hours stay on web for now.
 */
import { View, ScrollView } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TenantPreferences } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { ToggleRow } from '@/components/ui/Field';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantSettings, useUpdateTenantPreferences } from '@/api/tenant';

type PrefKey = keyof TenantPreferences;
const TOGGLES: { key: PrefKey; label: string; hint: string; defaultOn?: boolean }[] = [
  { key: 'stackItems', label: 'Stack repeat items', hint: 'Re-tapping an item bumps its qty instead of a new line', defaultOn: true },
  { key: 'autoReadyOnSend', label: 'Skip the cook step', hint: 'Items land "ready" on send rather than in progress' },
  { key: 'autoServeOnReady', label: 'Auto-serve when ready', hint: 'Marking ready also marks served' },
  { key: 'autoCleanTables', label: 'Auto-clean tables', hint: 'Closing a tab frees the table (no dirty sweep)' },
  { key: 'combinedSettle', label: 'Discounts in settle', hint: 'Show discount controls inside the settle sheet' },
  { key: 'requireTxnRef', label: 'Require online reference', hint: 'Ask for a txn reference on online payments' },
];

export default function Settings() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const settings = useTenantSettings();
  const update = useUpdateTenantPreferences();
  const prefs = settings.data?.preferences;

  if (me.data && !can(me.data, 'tenant:update')) return <Redirect href="/more" />;

  const valueOf = (t: (typeof TOGGLES)[number]) => {
    const v = prefs?.[t.key];
    return typeof v === 'boolean' ? v : !!t.defaultOn;
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Settings" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
      >
        <View style={{ gap: theme.spacing[4] }}>
          <AppText variant="label">Order flow</AppText>
          {settings.isLoading ? (
            <AppText variant="faint">Loading…</AppText>
          ) : (
            TOGGLES.map((t) => (
              <ToggleRow
                key={t.key}
                label={t.label}
                hint={t.hint}
                value={valueOf(t)}
                onValueChange={(v) => update.mutate({ [t.key]: v })}
              />
            ))
          )}
        </View>

        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          Branding, VAT, and opening hours are managed on the web dashboard.
        </AppText>
      </ScrollView>
    </View>
  );
}
