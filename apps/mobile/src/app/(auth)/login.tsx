/**
 * Login. The guest demo is the baseline path: it needs no server, no Play
 * Services, and no correctly-registered signing certificate, so it is what keeps
 * the screen usable when everything else fails. Google is advertised by the
 * server via /auth/config but defaults to ON, so a config fetch that never lands
 * can't strip the screen of a control either — between the two, there is always
 * something here that works offline.
 *
 * Email OTP is work-in-progress and hidden; see SHOW_EMAIL_OTP.
 *
 * A Google failure routes to /no-access (a designed page with three working
 * actions) rather than reddening a banner here — except a user CANCEL, which
 * leaves them exactly where they were. Sign-in succeeding for an account with no
 * membership needs no code here at all: startGoogleLogin() flips hasSession, so
 * (auth)/_layout redirects to "/", the picker finds no memberships and redirects
 * to /no-access itself. Don't add a second path for it.
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
import { classifyGoogleFailure } from '@/auth/googleFailure';
import { noAccessHref } from '@/lib/routes';
import { enterDemo } from '@/demo/session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email OTP is work-in-progress and hidden from the login screen. The
 * (auth)/otp route stays in the tree and stays tested — flip this to true to
 * restore the email field + "Send login code" and nothing else changes.
 *
 * Annotated `: boolean` deliberately: a bare `= false` narrows to the literal
 * type, which makes `email` / `emailValid` / `requestOtp` / `onSendCode`
 * provably unreachable and trips `eslint --max-warnings 0`.
 */
const SHOW_EMAIL_OTP: boolean = false;

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

  // Google defaults ON: a config request still in flight — or that failed
  // outright — must not strip the screen of every way in. (The guest button below
  // isn't gated on config at all, so that holds even with zero network.) The
  // server's veto is still honoured when the config DOES land.
  const otpEnabled = SHOW_EMAIL_OTP && config.data?.email_otp_enabled !== false;
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
      const failure = classifyGoogleFailure(e);
      // A cancel is not a failure: say nothing, go nowhere.
      if (failure === 'cancelled') return;
      router.push(noAccessHref(failure.reason, failure.detail));
    } finally {
      setBusy(null);
    }
  }

  function onGuest() {
    enterDemo();
    router.replace('/');
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

            {/* The one control that cannot fail: no config gate, no `busy` gate,
                no network, no async. If everything else on this screen is
                unavailable, this still works — which is why the divider above it
                is conditional and the button below it never is. */}
            {otpEnabled || googleEnabled ? <Divider label="or" /> : null}
            <Button
              title="Explore as a guest"
              variant="secondary"
              accessibilityLabel="explore-as-guest"
              onPress={onGuest}
            />
            <AppText
              variant="faint"
              style={{ textAlign: 'center', fontSize: theme.text.xs }}
            >
              Browse a sample café — no account, and nothing leaves this device.
            </AppText>

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
