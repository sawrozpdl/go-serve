/**
 * Settings → Tax & charges. Read-only: changing the VAT basis or the timezone
 * re-bases every bill and every daily close after it, which is not a decision
 * to make one-handed mid-service. Shown so the figures on screen can be
 * checked against what they are computed from.
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
import { useTenantSettings } from '@/api/tenant';

export default function Screen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const me = useMe();
  const settings = useTenantSettings();

  if (me.data && !can(me.data, 'tenant:update')) return <Redirect href="/more" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Tax & charges" />
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