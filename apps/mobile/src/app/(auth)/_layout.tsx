import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '@/stores/auth';

export default function AuthLayout() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const hasSession = useAuthStore((s) => s.hasSession);
  // Already signed in → let the resolver route onward.
  if (hydrated && hasSession) return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />;
}
