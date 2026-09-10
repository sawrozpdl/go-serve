/**
 * Workspace settings — the POS behaviour toggles on tenant.preferences, the
 * discount default, the tax basis every bill is computed against, and the
 * account's own privacy controls.
 *
 * Toggles save immediately: `useUpdateTenantPreferences` deep-merges over the
 * current object, so a flip can never clobber a sibling. Text fields keep an
 * explicit Save, because a half-typed phone number is not a preference.
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
import { useLayout, readableContent } from '@/lib/layout';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantSettings, useUpdateTenantPreferences, useUpdateTenantProfile } from '@/api/tenant';
import { DISCOUNT_REASONS } from '@/components/order/discountReasons';
import { PrivacySection } from '@/components/settings/PrivacySection';
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
  {
    key: 'autoRecordPayment',
    label: 'Auto-record payments',
    hint: 'Typing an amount records it after a pause — no "Add payment" tap',
    defaultOn: true,
  },
  {
    key: 'dailyBriefEmail',
    label: 'Morning brief email',
    // Deliberately precise: this stops the MAIL, not the checking. The
    // findings are computed either way and still shown in the app.
    hint: 'Email what the nightly check found. Off just stops the email.',
    defaultOn: true,
  },
];

export default function Settings() {
  const theme = useTheme();
  const layout = useLayout();
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
          ...readableContent(layout),
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

        <Section title="Discount default">
          <Card>
            <View style={{ gap: theme.spacing[3] }}>
              <SegmentedField
                label="Opens as"
                value={prefs?.defaultDiscount?.mode ?? 'flat'}
                options={[
                  { value: 'flat', label: 'Rupees off' },
                  { value: 'percent', label: 'Percent off' },
                ]}
                onChange={(mode) =>
                  update.mutate({ defaultDiscount: { ...(prefs?.defaultDiscount ?? {}), mode } })
                }
              />
              <SegmentedField
                label="Reason preselected"
                value={prefs?.defaultDiscount?.reason ?? 'regular'}
                options={DISCOUNT_REASONS.map((r) => ({ value: r.value, label: r.label }))}
                onChange={(reason) =>
                  update.mutate({ defaultDiscount: { ...(prefs?.defaultDiscount ?? {}), reason } })
                }
              />
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                What the discount sheet opens on. The cashier can still change both — this only
                saves them re-picking the same thing every time.
              </AppText>
            </View>
          </Card>
        </Section>

        <Section title="Tax & charges">
          <Card>
            <View style={{ gap: theme.spacing[2] }}>
              {/* Read-only on purpose. Changing the VAT basis or the timezone
                  re-bases every bill and every daily close after it, which is
                  not a thing to do one-handed on a phone mid-service. */}
              <ReadRow label="VAT" value={vatSummary(settings.data?.vat_mode, settings.data?.vat_pct)} />
              <ReadRow
                label="Service charge"
                value={
                  Number(settings.data?.service_charge_pct ?? 0) > 0
                    ? `${settings.data?.service_charge_pct}%`
                    : 'None'
                }
              />
              <ReadRow label="Day boundary" value={settings.data?.timezone || '—'} />
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                Shown so you can check what the bills are being computed against. Changing them
                re-bases every close after it, so that stays on the dashboard.
              </AppText>
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

        <PrivacySection />

        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          Branding and opening hours are managed on the web dashboard.
        </AppText>
      </ScrollView>
    </View>
  );
}

/** One read-only fact about how bills are computed. */
function ReadRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <AppText>{label}</AppText>
      <AppText style={{ fontFamily: theme.fonts.bodySemi, color: theme.colors.textFaint }}>
        {value}
      </AppText>
    </View>
  );
}

/** VAT in one phrase. "13%" alone doesn't say whether it is already in the
 *  menu price — which is the difference between two very different bills. */
function vatSummary(mode: string | undefined, pct: string | undefined): string {
  if (!mode || mode === 'none') return 'Not charged';
  return mode === 'inclusive' ? `${pct}% — already in menu prices` : `${pct}% — added at close`;
}
