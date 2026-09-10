/**
 * Settings — a hub, not a wall.
 *
 * The dashboard has nine tabs of settings. Stacked into one phone scroll that
 * is a screen you hunt through rather than navigate, and the thing you came
 * for is always past the thing you didn't. Each group is its own route; this
 * page is the map, and each row says what is inside so you can choose without
 * opening it.
 *
 * "Display" stays here: it is one control, it is device-local rather than
 * workspace state, and a route for a single segmented field is a route you
 * resent opening.
 */
import { View, ScrollView } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { SegmentedField } from '@/components/ui/Field';
import { useLayout, readableContent } from '@/lib/layout';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantSettings } from '@/api/tenant';
import { useDisplayPrefs, POS_SCALES } from '@/stores/displayPrefs';
import { changedToggleCount } from '@/settings/toggles';
import { PrivacySection } from '@/components/settings/PrivacySection';

export default function SettingsHub() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const router = useRouter();
  const me = useMe();
  const settings = useTenantSettings();
  const posScale = useDisplayPrefs((s) => s.posScale);
  const setPosScale = useDisplayPrefs((s) => s.setPosScale);

  if (me.data && !can(me.data, 'tenant:update')) return <Redirect href="/more" />;

  const prefs = settings.data?.preferences;
  const changed = changedToggleCount(prefs);
  const vat = settings.data?.vat_mode;

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
          <Card padded={false}>
            <ListRow
              title="Identity"
              subtitle="Contact number and logo"
              chevron
              onPress={() => router.push('/more/settings/workspace')}
            />
            <ListRow
              title="Order flow"
              // The count is the point of the row: it says whether this
              // workspace has tuned anything without opening it to find out.
              subtitle={
                changed === 0
                  ? 'All at their defaults'
                  : `${changed} change${changed === 1 ? '' : 's'} from the defaults`
              }
              chevron
              onPress={() => router.push('/more/settings/order-flow')}
            />
            <ListRow
              title="Tax & charges"
              subtitle={vat && vat !== 'none' ? `VAT ${settings.data?.vat_pct}%` : 'No VAT charged'}
              chevron
              onPress={() => router.push('/more/settings/tax')}
            />
            <ListRow
              title="Printing"
              subtitle={prefs?.printingEnabled ? 'On' : 'Off'}
              chevron
              onPress={() => router.push('/more/printing')}
            />
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
          Branding colours and opening hours are managed on the web dashboard.
        </AppText>
      </ScrollView>
    </View>
  );
}
