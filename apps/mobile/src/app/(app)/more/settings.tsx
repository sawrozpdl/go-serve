/**
 * Workspace settings (M9) — the POS behaviour toggles that live on
 * tenant.preferences. Branding, VAT, and opening hours stay on web for now.
 */
import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TenantPreferences } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { ToggleRow, SegmentedField } from '@/components/ui/Field';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantSettings, useUpdateTenantPreferences, useUpdateTenantProfile } from '@/api/tenant';
import { useDisplayPrefs, POS_SCALES } from '@/stores/displayPrefs';
import { toast } from '@/lib/toast';

type PrefKey = keyof TenantPreferences;
const TOGGLES: { key: PrefKey; label: string; hint: string; defaultOn?: boolean }[] = [
  { key: 'stackItems', label: 'Stack repeat items', hint: 'Re-tapping an item bumps its qty instead of a new line', defaultOn: true },
  { key: 'autoReadyOnSend', label: 'Skip the cook step', hint: 'Items land "ready" on send rather than in progress' },
  { key: 'autoServeOnReady', label: 'Auto-serve when ready', hint: 'Marking ready also marks served', defaultOn: true },
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
  const updateProfile = useUpdateTenantProfile();
  const prefs = settings.data?.preferences;
  const posScale = useDisplayPrefs((s) => s.posScale);
  const setPosScale = useDisplayPrefs((s) => s.setPosScale);

  // Contact phone lives on the tenant record (not preferences). Track only the
  // user's edit (null = untouched) and fall back to the saved value for display,
  // so we never need an effect to seed state. Reset to null after a save.
  const savedPhone = settings.data?.contact_phone ?? '';
  const [phoneEdit, setPhoneEdit] = useState<string | null>(null);
  const phone = phoneEdit ?? savedPhone;
  const phoneDirty = phoneEdit !== null && phoneEdit.trim() !== savedPhone;
  const savePhone = () =>
    updateProfile.mutate(
      { contact_phone: phone.trim() },
      {
        onSuccess: () => {
          setPhoneEdit(null);
          toast.success('Contact phone saved');
        },
        onError: (e) => toast.error('Could not save', (e as Error).message),
      },
    );

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
          paddingTop: theme.spacing[4],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[6],
        }}
      >
        <Section title="Workspace">
          <Card>
            <View style={{ gap: theme.spacing[3] }}>
              <TextField
                label="Contact phone"
                value={phone}
                onChangeText={setPhoneEdit}
                placeholder="+977 …"
                keyboardType="phone-pad"
              />
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                The number your customers and the GoServe team reach you on.
              </AppText>
              <Button
                title="Save phone"
                onPress={savePhone}
                loading={updateProfile.isPending}
                disabled={!phoneDirty}
              />
            </View>
          </Card>
        </Section>

        <Section title="Order flow">
          <Card>
            <View style={{ gap: theme.spacing[4] }}>
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
          </Card>
        </Section>

        <Section title="Display (this device)">
          <Card>
            <SegmentedField
              label="Floor-menu size"
              value={posScale}
              options={POS_SCALES}
              onChange={setPosScale}
            />
            <AppText variant="faint" style={{ fontSize: theme.text.sm, marginTop: theme.spacing[2] }}>
              How big the categories and items look on this device — saved here, not shared.
            </AppText>
          </Card>
        </Section>

        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          Branding, VAT, and opening hours are managed on the web dashboard.
        </AppText>
      </ScrollView>
    </View>
  );
}
