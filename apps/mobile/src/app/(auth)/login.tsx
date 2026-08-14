/**
 * Login. Email OTP is the baseline path — it works on every build regardless of
 * how the APK/AAB was signed, so it is what keeps the screen usable when native
 * Google sign-in can't complete. Google and dev-login are advertised by the
 * server via /auth/config.
 *
 * The method flags default to ON while /auth/config is loading or after it has
 * failed: a config fetch that never lands must never leave the screen with no
 * working control on it. Errors surface in a banner above the form rather than
 * on whichever field happened to be nearby.
 *
 * The screen leads with the editorial wordmark over the warm ambient glow
 * (the house signature).
 */
import { useState } from 'react';
import { View, Text, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { TriangleAlert } from 'lucide-react-native';
import type { ApiError } from '@cafe-mgmt/api-types';
import { AmbientGlow } from '@/components/ui/AmbientGlow';
import { AppText, Heading, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { GoogleButton } from '@/components/ui/GoogleButton';
import { useTheme } from '@/theme';
import { enterUpDelayed } from '@/theme/motion';
import { useAuthConfig, useRequestOTP, useDevLogin } from '@/api/auth';
import { startGoogleLogin } from '@/auth/googleOAuth';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const config = useAuthConfig();
  const requestOtp = useRequestOTP();
  const devLogin = useDevLogin();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'google'>(null);

  const emailValid = EMAIL_RE.test(email.trim());

  // Default ON: a config request that is still in flight — or that failed
  // outright — must not strip the screen of every way in.
  const otpEnabled = config.data?.email_otp_enabled !== false;
  const googleEnabled = config.data?.google_enabled !== false;

  async function onSendCode() {
    setError(null);
    try {
      await requestOtp.mutateAsync(email.trim());
      router.push({ pathname: '/(auth)/otp', params: { email: email.trim() } });
    } catch (e) {
      setError((e as ApiError).message ?? 'Could not send the code.');
    }
  }

  async function onDevLogin() {
    setError(null);
    try {
      await devLogin.mutateAsync({ email: email.trim() || 'dev@goserve.app', name: 'Dev' });
      router.replace('/');
    } catch (e) {
      setError((e as ApiError).message ?? 'Dev login failed.');
    }
  }

  async function onGoogle() {
    setError(null);
    setBusy('google');
    try {
      await startGoogleLogin();
      router.replace('/');
    } catch (e) {
      setError(describeGoogleError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <AmbientGlow />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          gap: theme.spacing[9],
          paddingHorizontal: theme.spacing[6],
          paddingTop: insets.top + theme.spacing[8],
          paddingBottom: insets.bottom + theme.spacing[6],
          justifyContent: 'center',
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
          {/* Brand */}
          <Animated.View entering={enterUpDelayed(0)} style={{ gap: theme.spacing[5] }}>
            <Card
              level={2}
              padded={false}
              style={{ width: 60, height: 60, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontSize: theme.text.display }}>☕</Text>
            </Card>
            <View style={{ gap: theme.spacing[2] }}>
              <MonoText size="2xs" style={{ letterSpacing: 1.6, color: theme.colors.stamp.brand.fg }}>
                GOSERVE · POINT OF SALE
              </MonoText>
              <Heading size="displayLg">Go Serve</Heading>
              <Animated.View entering={enterUpDelayed(1)}>
                <AppText variant="muted" style={{ fontSize: theme.text.lg }}>
                  Run your floor, fire the kitchen, and close the till — from your pocket.
                </AppText>
              </Animated.View>
            </View>
          </Animated.View>

          {/* Form */}
          <Animated.View entering={enterUpDelayed(2)} style={{ gap: theme.spacing[4] }}>
            {error ? <ErrorBanner message={error} /> : null}

            {otpEnabled ? (
              <>
                <TextField
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@cafe.com"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  inputMode="email"
                  accessibilityLabel="email"
                  editable={!requestOtp.isPending}
                  returnKeyType="go"
                  onSubmitEditing={() => emailValid && void onSendCode()}
                />
                <Button
                  title="Send login code"
                  onPress={onSendCode}
                  loading={requestOtp.isPending}
                  disabled={!emailValid}
                />
              </>
            ) : null}

            {googleEnabled ? (
              <>
                {otpEnabled ? <Divider label="or" /> : null}
                <GoogleButton onPress={onGoogle} loading={busy === 'google'} />
              </>
            ) : null}

            {config.data?.dev_login_enabled ? (
              <Button
                title="Dev login"
                variant="ghost"
                onPress={onDevLogin}
                loading={devLogin.isPending}
              />
            ) : null}

            {otpEnabled ? (
              <AppText
                variant="faint"
                style={{ textAlign: 'center', fontSize: theme.text.xs, marginTop: theme.spacing[2] }}
              >
                We&apos;ll email you a 6-digit code — no password needed.
              </AppText>
            ) : null}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * Native Google sign-in fails with opaque SDK codes (`DEVELOPER_ERROR` when the
 * running build's signing certificate isn't registered against the Android
 * OAuth client — which is what happens if the Play App Signing SHA-1 was never
 * added). Whatever the cause, the user gets a sentence rather than a dead tap.
 */
function describeGoogleError(e: unknown): string {
  const raw = (e as ApiError | Error | undefined)?.message;
  if (raw && /DEVELOPER_ERROR|did not return an ID token/i.test(raw)) {
    return 'Google sign-in is not available on this build. Use your email address to get a login code instead.';
  }
  return raw && raw.trim() ? raw : 'Google sign-in failed. Please try again.';
}

function ErrorBanner({ message }: { message: string }) {
  const theme = useTheme();
  const c = theme.colors.stamp.danger;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel="login-error"
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing[3],
        padding: theme.spacing[4],
        borderRadius: theme.radii.md,
        backgroundColor: c.bg,
        borderWidth: 1,
        borderColor: c.border,
      }}
    >
      <TriangleAlert size={18} color={c.fg} style={{ marginTop: 1 }} />
      <AppText style={{ flex: 1, color: theme.colors.text, fontSize: theme.text.sm }}>
        {message}
      </AppText>
    </View>
  );
}

function Divider({ label }: { label: string }) {
  const theme = useTheme();
  const line = { flex: 1, height: 1, backgroundColor: theme.colors.border };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3], marginVertical: theme.spacing[1] }}>
      <View style={line} />
      <AppText variant="faint" style={{ fontSize: theme.text.xs, textTransform: 'uppercase', letterSpacing: 1 }}>
        {label}
      </AppText>
      <View style={line} />
    </View>
  );
}
