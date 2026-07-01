/**
 * "Continue with Google" — the standard white treatment so it reads as Google
 * on the dark background. Uses a simple multi-stroke "G" mark (no bundled logo
 * asset needed).
 */
import { Pressable, Text, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../theme';

export function GoogleButton({ onPress, loading = false }: { onPress: () => void; loading?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Continue with Google"
      disabled={loading}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing[3],
        backgroundColor: '#ffffff',
        borderRadius: theme.radii.md,
        minHeight: 52,
        paddingHorizontal: theme.spacing[5],
        opacity: loading ? 0.6 : pressed ? 0.9 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color="#4285F4" />
      ) : (
        <>
          <Text style={{ fontFamily: theme.fonts.bodyBold, fontSize: 18, color: '#4285F4' }}>G</Text>
          <Text style={{ fontFamily: theme.fonts.bodySemi, fontSize: theme.text.lg, color: '#1f1f1f' }}>
            Continue with Google
          </Text>
        </>
      )}
    </Pressable>
  );
}
