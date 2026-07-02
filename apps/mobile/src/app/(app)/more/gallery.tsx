/**
 * DEV-ONLY component gallery — the Phase-1 proving ground for the redesign
 * primitives on real devices (gorhom sheet + Reanimated 4 + Android elevation
 * artifacts + touch targets). Not linked from the More hub; navigate to
 * /more/gallery in the dev client. Deleted before release (Phase 5).
 */
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Redirect } from 'expo-router';
import { Coffee, ChefHat } from 'lucide-react-native';
import { useTheme } from '@/theme';
import { useLayout } from '@/lib/layout';
import { StackHeader } from '@/components/ui/StackHeader';
import { AppText, Heading, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { Chip } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Section } from '@/components/ui/Section';
import { Stat } from '@/components/ui/Stat';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Stepper } from '@/components/ui/Stepper';
import { AmountInput } from '@/components/ui/AmountInput';
import { AppSheet } from '@/components/ui/AppSheet';
import { Grid } from '@/components/ui/Grid';
import { DottedLeader } from '@/components/ui/DottedLeader';
import { Perforation } from '@/components/ui/Perforation';

export default function GalleryScreen() {
  const theme = useTheme();
  const layout = useLayout();
  const [qty, setQty] = useState(2);
  const [chip, setChip] = useState('Espresso');
  const [amount, setAmount] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [fullSheetOpen, setFullSheetOpen] = useState(false);

  if (!__DEV__) return <Redirect href="/(app)/more" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Gallery" />
      <ScrollView contentContainerStyle={{ padding: theme.spacing[5], gap: theme.spacing[6] }}>
        <AppText variant="muted">
          {`bp=${layout.bp} · split=${String(layout.splitView)} · ${layout.width}dp`}
        </AppText>

        <Section title="Stamps" count={6}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
            <Stamp label="Open" />
            <Stamp label="Sent" tone="brand" />
            <Stamp label="Ready" tone="success" />
            <Stamp label="Paid" tone="success" size="sm" />
            <Stamp label="Overdue" tone="danger" />
            <Stamp label="Live" tone="success" dot />
          </View>
        </Section>

        <Section title="Type voices">
          <Heading size="3xl">Run your floor.</Heading>
          <AppText>Inter carries the working UI copy.</AppText>
          <MonoText size="display" weight="bold">
            ₨ 1,240.00
          </MonoText>
        </Section>

        <Section title="Docket card">
          <Card style={{ overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
              <MonoText weight="bold" style={{ color: theme.colors.stamp.brand.fg }}>
                2×
              </MonoText>
              <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>Cappuccino</AppText>
              <DottedLeader />
              <MonoText>480</MonoText>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
              <MonoText weight="bold" style={{ color: theme.colors.stamp.brand.fg }}>
                1×
              </MonoText>
              <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>Croissant</AppText>
              <DottedLeader />
              <MonoText>220</MonoText>
            </View>
            <Perforation />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <MonoText size="2xs" weight="bold" muted style={{ letterSpacing: 1.6 }}>
                TOTAL
              </MonoText>
              <MonoText size="display" weight="bold">
                ₨ 700
              </MonoText>
            </View>
          </Card>
        </Section>

        <Section title="Cards + grid" count={layout.columns(170, 2, 6)}>
          <Grid columns={layout.columns(170, 2, 6)}>
            <Card selected accessibilityLabel="selected-card">
              <MonoText size="sm" weight="bold">
                T1 · WINDOW
              </MonoText>
              <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
                Selected (opaque tint — check Android shadow)
              </AppText>
            </Card>
            <Card onPress={() => {}}>
              <MonoText size="sm" weight="bold">
                T2
              </MonoText>
              <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
                Pressable spring
              </AppText>
            </Card>
            <Card elevated={false}>
              <MonoText size="sm" weight="bold">
                T3
              </MonoText>
              <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
                Flat
              </AppText>
            </Card>
          </Grid>
        </Section>

        <Section title="Chips">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
            {['Espresso', 'Bakery', 'Momo'].map((c) => (
              <Chip key={c} label={c} count={3} selected={chip === c} onPress={() => setChip(c)} />
            ))}
          </View>
        </Section>

        <Section title="Stats">
          <Stat label="Sales today" value="₨ 12,480" size="lg" />
          <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
            <Stat label="Net" value="+₨ 3,210" tone="success" style={{ flex: 1 }} />
            <Stat label="Loading" value="" loading style={{ flex: 1 }} />
          </View>
        </Section>

        <Section title="Stepper + amount">
          <Stepper value={qty} onIncrement={() => setQty((q) => q + 1)} onDecrement={() => setQty((q) => q - 1)} label="Cappuccino" />
          <AmountInput
            label="Amount"
            valueCents={amount}
            onChangeCents={setAmount}
            placeholderCents={70000}
            quickAmounts={[50000, 70000, 100000]}
          />
        </Section>

        <Section title="Rows">
          <Card padded={false}>
            <ListRow title="Inventory" subtitle="12 items low" left={<Coffee size={20} color={theme.colors.textMuted} />} chevron onPress={() => {}} />
            <ListRow title="Cash drawer" value="₨ 8,240" chevron onPress={() => {}} />
            <ListRow title="Remove member" destructive onPress={() => {}} />
          </Card>
        </Section>

        <Section title="Sheets (keyboard test inside)">
          <Button title="Open sheet" variant="secondary" onPress={() => setSheetOpen(true)} />
          <Button title="Open full sheet" variant="secondary" onPress={() => setFullSheetOpen(true)} />
        </Section>

        <Section title="States">
          <Skeleton.Card lines={2} />
          <EmptyState
            icon={<ChefHat size={28} color={theme.colors.textMuted} />}
            title="Nothing cooking"
            hint="Tickets appear here the moment the floor fires them."
          />
          <ErrorState detail="Network request failed" onRetry={() => {}} />
        </Section>
      </ScrollView>

      <AppSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Record payment">
        <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4] }}>
          <AmountInput
            insideSheet
            label="Amount"
            valueCents={amount}
            onChangeCents={setAmount}
            placeholderCents={70000}
            autoFocus
          />
          <Button title="Record" onPress={() => setSheetOpen(false)} />
        </View>
      </AppSheet>

      <AppSheet open={fullSheetOpen} onClose={() => setFullSheetOpen(false)} title="Menu" full>
        <AppSheet.ScrollView contentContainerStyle={{ padding: theme.spacing[5], gap: theme.spacing[3] }}>
          {Array.from({ length: 24 }, (_, i) => (
            <Card key={i}>
              <AppText>Item {i + 1}</AppText>
            </Card>
          ))}
        </AppSheet.ScrollView>
      </AppSheet>
    </View>
  );
}
