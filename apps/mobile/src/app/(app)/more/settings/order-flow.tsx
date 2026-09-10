/**
 * Settings → Order flow: how the POS behaves, and what the discount sheet
 * opens on.
 *
 * Every control here saves immediately. `useUpdateTenantPreferences`
 * deep-merges over the current object, so a flip can never clobber a sibling.
 */
import { View, ScrollView } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Card } from '@/components/ui/Card';
import { useLayout, readableContent } from '@/lib/layout';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { ToggleRow, SegmentedField } from '@/components/ui/Field';
import { useTenantSettings, useUpdateTenantPreferences } from '@/api/tenant';
import { DISCOUNT_REASONS } from '@/components/order/discountReasons';
import { TOGGLES, toggleValue } from '@/settings/toggles';

export default function Screen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const me = useMe();
  const settings = useTenantSettings();
  const update = useUpdateTenantPreferences();
  const prefs = settings.data?.preferences;

  if (me.data && !can(me.data, 'tenant:update')) return <Redirect href="/more" />;

  const valueOf = (t: (typeof TOGGLES)[number]) => toggleValue(prefs, t);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Order flow" />
      <ScrollView
        contentContainerStyle={{
          ...readableContent(layout),
          paddingTop: theme.spacing[4],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
      >
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
      </ScrollView>
    </View>
  );
}
