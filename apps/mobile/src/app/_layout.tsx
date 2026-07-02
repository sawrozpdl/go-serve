/**
 * Root layout. Providers (gesture + safe-area + React Query + theme), one-time
 * auth hydration from secure storage, and the logout handler that the fetch
 * layer calls when a session is revoked.
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Stack, useRouter } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/theme';
import { Toasts } from '@/components/ui/Toasts';
import { fontAssets } from '@/theme/fontAssets';
import { queryClient } from '@/api/queryClient';
import { setAuthHandlers } from '@/api/client';
import { startSessionKeepAlive } from '@/auth/sessionKeepAlive';
import { useAuthStore } from '@/stores/auth';

// Hold the native splash until fonts are ready so the first paint is already
// in the editorial type — no flash of a system-font fallback.
void SplashScreen.preventAutoHideAsync();

function Boot({ children }: { children: ReactNode }) {
  const hydrate = useAuthStore((s) => s.hydrate);
  const signOut = useAuthStore((s) => s.signOut);
  const router = useRouter();

  useEffect(() => {
    setAuthHandlers({
      onUnauthenticated: () => {
        void signOut();
        router.replace('/(auth)/login');
      },
    });
    let stopKeepAlive = () => {};
    void hydrate().then(() => {
      // Arm the proactive refresh timer once tokens are loaded.
      stopKeepAlive = startSessionKeepAlive();
    });
    return () => stopKeepAlive();
  }, [hydrate, signOut, router]);

  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);

  useEffect(() => {
    if (fontsLoaded || fontError) void SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  // Keep the (dark) native splash up until fonts resolve; don't block forever
  // if a font fails to load.
  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <BottomSheetModalProvider>
              <StatusBar style="auto" />
              <Boot>
                <Stack screenOptions={{ headerShown: false }} />
              </Boot>
              <Toasts />
            </BottomSheetModalProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
