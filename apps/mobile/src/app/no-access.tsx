/**
 * "Access needed" — the calm page a visitor lands on when they can't get into a
 * workspace. Deliberately at the ROOT of the route tree, outside every group:
 * (auth)/_layout redirects to "/" whenever a session exists, so a signed-in user
 * with no membership placed inside (auth) would loop "/" → picker → back, while
 * the (workspace) and (app) layouts bounce the signed-out case. The root layout
 * has no auth guard, so this renders identically either way.
 *
 * Two things get you here: native Google sign-in failing (typically because the
 * Play App Signing SHA-1 isn't registered against the Android OAuth client), and
 * sign-in succeeding for an account with no active membership — Go Serve is
 * invite-only, so the server creates the user but grants nothing.
 *
 * Every action is local: a store write, a navigation, or a mailto. Three working
 * controls with no network and no config request gating them, which is the whole
 * point — this page is a reviewer's fallback, not a dead end.
 */
import { View, ScrollView, Linking } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { KeyRound } from 'lucide-react-native';
import { AmbientGlow } from '@/components/ui/AmbientGlow';
import { AppText, Heading, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Stamp } from '@/components/ui/Stamp';
import { useTheme } from '@/theme';
import { enterUpDelayed } from '@/theme/motion';
import { useAuthStore } from '@/stores/auth';
import { enterDemo } from '@/demo/session';
import { CONTACT_EMAIL, contactMailto } from '@/lib/support';
import { toast } from '@/lib/toast';
import type { NoAccessReason } from '@/lib/routes';

const COPY: Record<NoAccessReason, { headline: string; body: string }> = {
  'google-unavailable': {
    headline: "Sign-in isn't ready on this copy",
    body: "Google sign-in can't complete on this build yet. You can look around Go Serve with sample data right now, or write to us and we'll get your café set up.",
  },
  'google-failed': {
    headline: "That sign-in didn't go through",
    body: "We couldn't finish signing you in. Try again in a moment, explore the demo meanwhile, or get in touch.",
  },
  'no-workspace': {
    headline: 'No café is linked to your account yet',
    body: "You're signed in, but you haven't been added to a café. An owner needs to invite you. In the meantime, take a look around the demo café.",
  },
  'membership-pending': {
    headline: 'Your invite is waiting to be confirmed',
    body: "An owner has invited you, but the membership isn't active yet. Ask them to confirm it — or explore the demo while you wait.",
  },
  unknown: {
    headline: "We couldn't confirm your access",
    body: "Your account is fine — we just couldn't work out which café to open. Try signing in again, or explore the demo.",
  },
};

function resolveReason(raw: unknown): NoAccessReason {
  return typeof raw === 'string' && raw in COPY ? (raw as NoAccessReason) : 'unknown';
}

export default function NoAccess() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const signOut = useAuthStore((s) => s.signOut);
  const hasSession = useAuthStore((s) => s.hasSession);

  const reason = resolveReason(params.reason);
  const { headline, body } = COPY[reason];
  const detail = typeof params.detail === 'string' ? params.detail : undefined;

  function onDemo() {
    enterDemo();
    router.replace('/');
  }

  // Clear the half-session FIRST. Google sign-in succeeds server-side even for an
  // account with no membership, so real tokens are sitting in secure storage; go
  // to login without wiping them and (auth)/_layout bounces straight back to "/",
  // through the picker, and right back here. Uses the store's signOut rather than
  // useLogout() so it's instant and can't hang on a dead network.
  async function onBackToSignIn() {
    await signOut();
    router.replace('/(auth)/login');
  }

  function onContact() {
    void Linking.openURL(contactMailto(CONTACT_EMAIL, 'Go Serve — access request')).catch(
      () => toast.error("Couldn't open mail", `Write to us at ${CONTACT_EMAIL}`),
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <AmbientGlow />
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
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={enterUpDelayed(0)} style={{ gap: theme.spacing[5] }}>
          <Card
            level={2}
            padded={false}
            style={{ width: 60, height: 60, alignItems: 'center', justifyContent: 'center' }}
          >
            <KeyRound size={26} color={theme.colors.stamp.brand.fg} strokeWidth={2} />
          </Card>
          <View style={{ gap: theme.spacing[2] }}>
            <MonoText size="2xs" style={{ letterSpacing: 1.6, color: theme.colors.stamp.brand.fg }}>
              GOSERVE · ACCESS
            </MonoText>
            <Heading size="displayLg">{headline}</Heading>
            <Animated.View entering={enterUpDelayed(1)}>
              <AppText variant="muted" style={{ fontSize: theme.text.lg }}>
                {body}
              </AppText>
            </Animated.View>
            {hasSession ? (
              <View style={{ flexDirection: 'row', marginTop: theme.spacing[1] }}>
                <Stamp tone="success" label="Signed in" size="sm" />
              </View>
            ) : null}
          </View>
        </Animated.View>

        <Animated.View entering={enterUpDelayed(2)} style={{ gap: theme.spacing[3] }}>
          <Button
            title="Explore the demo"
            accessibilityLabel="enter-demo"
            onPress={onDemo}
          />
          <Button
            title="Back to sign in"
            variant="secondary"
            accessibilityLabel="back-to-sign-in"
            onPress={onBackToSignIn}
          />
          <Button
            title="Contact support"
            variant="ghost"
            accessibilityLabel="contact-support"
            onPress={onContact}
          />
          {/* A visible fallback value, so the control still conveys something on a
              device with no mail app configured. */}
          <MonoText size="2xs" muted style={{ textAlign: 'center' }}>
            {CONTACT_EMAIL}
          </MonoText>
          {detail ? (
            <MonoText size="2xs" muted numberOfLines={2} style={{ textAlign: 'center' }}>
              {detail}
            </MonoText>
          ) : null}
          <AppText
            variant="faint"
            style={{ textAlign: 'center', fontSize: theme.text.xs, marginTop: theme.spacing[2] }}
          >
            The demo runs entirely on this device. Nothing in it touches a real café.
          </AppText>
        </Animated.View>
      </ScrollView>
    </View>
  );
}
