/**
 * Login. Email OTP is the primary path; Google and dev-login appear only when
 * the server advertises them via /auth/config. The screen leads with the
 * editorial wordmark over the warm ambient glow (the house signature).
 */
import { useState } from 'react';
import { View, Text, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
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
      setError((e as ApiError).message ?? 'Google sign-in failed.');
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
              error={error ?? undefined}
            />
            <Button
              title="Send login code"
              onPress={onSendCode}
              loading={requestOtp.isPending}
              disabled={!emailValid}
            />

            {config.data?.google_enabled ? (
              <>
                <Divider label="or" />
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

            <AppText
              variant="faint"
              style={{ textAlign: 'center', fontSize: theme.text.xs, marginTop: theme.spacing[2] }}
            >
              We&apos;ll email you a 6-digit code — no password needed.
            </AppText>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
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
