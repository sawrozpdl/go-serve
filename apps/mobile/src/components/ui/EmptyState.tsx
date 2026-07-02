/**
 * EmptyState — an empty screen is an invitation to act: icon medallion,
 * a display headline (Fraunces brand moment), guidance copy, optional action.
 * Generalizes kitchen's EmptyBoard for every list/board in the app.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { AppText, Heading } from './Text';
import { Button } from './Button';

export type EmptyStateProps = {
  /** A Lucide icon element (sized ~28 by the caller). */
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: { label: string; onPress: () => void };
};

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        alignItems: 'center',
        paddingVertical: theme.spacing[8],
        paddingHorizontal: theme.spacing[6],
        gap: theme.spacing[3],
      }}
    >
      {icon ? (
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.surfaces[1],
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          {icon}
        </View>
      ) : null}
      <Heading style={{ fontSize: theme.text['3xl'], textAlign: 'center' }}>{title}</Heading>
      {hint ? (
        <AppText variant="muted" style={{ textAlign: 'center', maxWidth: 280 }}>
          {hint}
        </AppText>
      ) : null}
      {action ? (
        <View style={{ marginTop: theme.spacing[2], alignSelf: 'stretch' }}>
          <Button title={action.label} variant="secondary" onPress={action.onPress} />
        </View>
      ) : null}
    </View>
  );
}
