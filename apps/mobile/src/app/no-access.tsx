/**
 * "Access needed" — the calm page a visitor lands on when they can't get into a
 * workspace. Deliberately at the ROOT of the route tree, outside every group:
 * (auth)/_layout redirects to "/" whenever a session exists, so a signed-in user
 * with no membership placed inside (auth) would loop "/" → picker → back, while
 * the (workspace) and (app) layouts bounce the signed-out case. The root layout
 * has no auth guard, so this renders identically either way.
 *
 * Two things get you here, and they want different first moves — hence the
 * ACTIONS table. Native Google sign-in failing (typically because the Play App
 * Signing SHA-1 isn't registered against the Android OAuth client) is worth
 * another try, so signing in leads. Signing in SUCCESSFULLY with no membership
 * is not: Go Serve is invite-only, the server creates the user and grants
 * nothing, and no amount of retrying conjures an invite — reaching an owner
 * does, so support leads there instead.
 *
 * The copy must never imply sign-in was withdrawn. It wasn't; it couldn't
 * complete HERE. All three actions are on the page in every case, and every one
 * of them is local — a store write, a navigation, or a mailto. No network, no
 * config request gating anything.
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

type ActionKey = 'signin' | 'demo' | 'contact';

const COPY: Record<
  NoAccessReason,
  { headline: string; body: string; signInLabel: string; actions: [ActionKey, ActionKey, ActionKey] }
> = {
  'google-unavailable': {
    headline: "We couldn't finish signing you in here",
    body: "Google couldn't verify this copy of the app, so sign-in can't complete on it yet. Give it another try — or write to us and we'll get your café set up. You're welcome to look around Go Serve with sample data meanwhile.",
    signInLabel: 'Try signing in again',
    actions: ['signin', 'demo', 'contact'],
  },
  'no-workspace': {
    headline: 'No café is linked to your account yet',
    body: "You're signed in — you just haven't been added to a café. An owner has to invite you, so signing in again won't change it. Tell us who you are and we'll sort it out, or take a look around the demo café in the meantime.",
    signInLabel: 'Sign in as someone else',
    actions: ['contact', 'demo', 'signin'],
  },
  'membership-pending': {
    headline: 'Your invite is waiting to be confirmed',
    body: "An owner has invited you, but the membership isn't active yet. Ask them to confirm it, or get in touch and we'll chase it — and explore the demo while you wait.",
    signInLabel: 'Sign in as someone else',
    actions: ['contact', 'demo', 'signin'],
  },
  unknown: {
    headline: "We couldn't confirm your access",
    body: "Your account is fine — we just couldn't work out which café to open. Try signing in again, or explore the demo.",
    signInLabel: 'Try signing in again',
    actions: ['signin', 'demo', 'contact'],
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
  const { headline, body, signInLabel, actions } = COPY[reason];

  function onDemo() {
    enterDemo();
    router.replace('/');
  }

  // Clear the half-session FIRST. Google sign-in succeeds server-side even for an
  // account with no membership, so real tokens are sitting in secure storage; go
  // to login without wiping them and (auth)/_layout bounces straight back to "/",
  // through the picker, and right back here. Uses the store's signOut rather than
  // useLogout() so it's instant and can't hang on a dead network.
  async function onSignIn() {
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
          {actions.map((key, i) => {
            // First is the primary; the rest step down. Which one leads depends
            // on the reason, because "try again" and "get an invite" are not
            // interchangeable advice.
            const variant = ((['primary', 'secondary', 'ghost'] as const)[i] ?? 'ghost');
            if (key === 'signin') {
              return (
                <Button
                  key={key}
                  title={signInLabel}
                  variant={variant}
                  accessibilityLabel="back-to-sign-in"
                  onPress={onSignIn}
                />
              );
            }
            if (key === 'demo') {
              return (
                <Button
                  key={key}
                  title="Explore the demo"
                  variant={variant}
                  accessibilityLabel="enter-demo"
                  onPress={onDemo}
                />
              );
            }
            return (
              <Button
                key={key}
                title="Contact support"
                variant={variant}
                accessibilityLabel="contact-support"
                onPress={onContact}
              />
            );
          })}
          {/* A visible fallback value, so support still conveys something on a
              device with no mail app configured. */}
          <MonoText size="2xs" muted style={{ textAlign: 'center' }}>
            {CONTACT_EMAIL}
          </MonoText>
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
