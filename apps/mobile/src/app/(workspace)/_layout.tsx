import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '@/stores/auth';

export default function WorkspaceLayout() {
  const hydrated = useAuthStore((s) => s.hydrated);
  const hasSession = useAuthStore((s) => s.hasSession);
  if (hydrated && !hasSession) return <Redirect href="/(auth)/login" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
