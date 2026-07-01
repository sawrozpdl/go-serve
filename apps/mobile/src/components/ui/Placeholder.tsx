import { View, Text } from 'react-native';
import { Screen } from './Screen';
import { Heading, AppText } from './Text';
import { useTheme } from '../../theme';

/** Friendly empty-state for screens not yet built — icon chip, title, guidance,
 * and a soft "Coming soon" tag so it reads as intentional, not broken. */
export function Placeholder({ title, note, icon = '✦' }: { title: string; note: string; icon?: string }) {
  const theme = useTheme();
  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing[4] }}>
        <View
          style={{
            width: 76,
            height: 76,
            borderRadius: theme.radii.xl,
            backgroundColor: theme.colors.card,
            borderWidth: 1,
            borderColor: theme.colors.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 34 }}>{icon}</Text>
        </View>
        <Heading style={{ fontSize: 30, textAlign: 'center' }}>{title}</Heading>
        <AppText variant="muted" style={{ textAlign: 'center', maxWidth: 300 }}>
          {note}
        </AppText>
        <View
          style={{
            marginTop: theme.spacing[2],
            paddingHorizontal: theme.spacing[3],
            paddingVertical: theme.spacing[1],
            borderRadius: theme.radii.pill,
            backgroundColor: theme.colors.warnBg,
            borderWidth: 1,
            borderColor: theme.colors.warnBorder,
          }}
        >
          <AppText variant="label" style={{ color: theme.colors.warnFgTile }}>
            Coming soon
          </AppText>
        </View>
      </View>
    </Screen>
  );
}
