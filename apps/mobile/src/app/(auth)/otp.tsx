/**
 * OTP entry. Auto-submits when 6 digits are entered; supports resend after a
 * cooldown; surfaces attempts-remaining from the server.
 */
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { ApiError } from '@cafe-mgmt/api-types';
import { Screen } from '@/components/ui/Screen';
import { Heading, AppText } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/theme';
import { useRequestOTP, useVerifyOTP } from '@/api/auth';

const CODE_LEN = 6;

export default function Otp() {
  const theme = useTheme();
  const router = useRouter();
  const { email } = useLocalSearchParams<{ email: string }>();
  const verify = useVerifyOTP();
  const resend = useRequestOTP();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(60);
  const submitted = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function submit(value: string) {
    if (submitted.current) return;
    submitted.current = true;
    setError(null);
    try {
      await verify.mutateAsync({ email: String(email), code: value });
      router.replace('/');
    } catch (e) {
      const err = e as ApiError;
      const remaining =
        typeof err.attempts_remaining === 'number' ? ` (${err.attempts_remaining} left)` : '';
      setError((err.message ?? 'That code is not right.') + remaining);
      setCode('');
      submitted.current = false;
    }
  }

  function onChange(next: string) {
    const digits = next.replace(/\D/g, '').slice(0, CODE_LEN);
    setCode(digits);
    if (digits.length === CODE_LEN) void submit(digits);
  }

  async function onResend() {
    setError(null);
    try {
      const r = await resend.mutateAsync(String(email));
      setCooldown(r.resend_in_seconds || 60);
    } catch (e) {
      setError((e as ApiError).message ?? 'Could not resend the code.');
    }
  }

  return (
    <Screen scroll>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.spacing[6] }}>
        <View style={{ gap: theme.spacing[2] }}>
          <Heading>Enter code</Heading>
          <AppText variant="muted">We sent a 6-digit code to {String(email)}.</AppText>
        </View>

        <TextField
          label="Code"
          value={code}
          onChangeText={onChange}
          placeholder="123456"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          maxLength={CODE_LEN}
          autoFocus
          accessibilityLabel="otp-code"
          error={error ?? undefined}
          style={{ fontSize: 28, letterSpacing: 8, textAlign: 'center' }}
        />

        <Button
          title="Verify"
          onPress={() => void submit(code)}
          loading={verify.isPending}
          disabled={code.length !== CODE_LEN}
        />

        <Button
          title={cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          variant="ghost"
          onPress={onResend}
          disabled={cooldown > 0 || resend.isPending}
        />
      </View>
    </Screen>
  );
}
