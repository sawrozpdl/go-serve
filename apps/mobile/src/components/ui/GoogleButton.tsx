/**
 * "Continue with Google" — standard white treatment with the real 4-color
 * Google "G" mark (drawn with SVG, no bundled asset). Text is pinned dark so
 * it's always legible on the white surface.
 */
import { Pressable, Text, ActivityIndicator } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../theme';

function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <Path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Svg>
  );
}

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
        opacity: loading ? 0.6 : pressed ? 0.92 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color="#4285F4" />
      ) : (
        <>
          <GoogleG />
          <Text
            style={{
              fontFamily: theme.fonts.bodySemi,
              fontSize: 16,
              color: '#1f1f1f',
              includeFontPadding: false,
            }}
          >
            Continue with Google
          </Text>
        </>
      )}
    </Pressable>
  );
}
