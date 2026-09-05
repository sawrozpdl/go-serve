import { Stack } from 'expo-router';

// The Dashboard tab is a stack: the report, then a pushed drill-down
// (top sellers). Keeping the drill-down in THIS tab is the point — pushing it
// into the More stack, as it was before, meant "back" from top sellers landed
// on the More menu instead of the report you came from.
export default function DashboardStack() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
