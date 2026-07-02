/**
 * ErrorState — the failure surface that was missing: failed fetches rendered
 * as empty boards before. Distinct from EmptyState (danger tone, retry
 * action). Errors explain what happened and how to recover, without apology.
 */
import { View } from 'react-native';
import { CloudOff } from 'lucide-react-native';
import { useTheme } from '../../theme';
import { AppText, Heading } from './Text';
import { Button } from './Button';

export type ErrorStateProps = {
  title?: string;
  /** Short cause line (error message, status). */
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
};

export function ErrorState({
  title = "Couldn't load this",
  detail,
  onRetry,
  retryLabel = 'Try again',
}: ErrorStateProps) {
  const theme = useTheme();
  return (
    <View
      accessibilityLabel="error-state"
      style={{
        alignItems: 'center',
        paddingVertical: theme.spacing[8],
        paddingHorizontal: theme.spacing[6],
        gap: theme.spacing[3],
      }}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.stamp.danger.bg,
          borderWidth: 1,
          borderColor: theme.colors.stamp.danger.border,
        }}
      >
        <CloudOff size={28} color={theme.colors.stamp.danger.fg} />
      </View>
      <Heading style={{ fontSize: theme.text['3xl'], textAlign: 'center' }}>{title}</Heading>
      {detail ? (
        <AppText variant="muted" style={{ textAlign: 'center', maxWidth: 280 }} numberOfLines={3}>
          {detail}
        </AppText>
      ) : null}
      {onRetry ? (
        <View style={{ marginTop: theme.spacing[2], alignSelf: 'stretch' }}>
          <Button title={retryLabel} variant="secondary" onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}
