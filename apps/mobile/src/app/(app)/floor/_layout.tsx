import { Stack } from 'expo-router';

// The Floor tab is a stack: the table grid, then a pushed order/tab detail.
export default function FloorStack() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
