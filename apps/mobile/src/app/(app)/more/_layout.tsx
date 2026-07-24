import { Stack } from 'expo-router';

/**
 * Anchor the More stack at its menu. Managers land straight on
 * /more/dashboard (see `landingHref`), and expo-router only anchors a stack at
 * a child matching the group name — never at `index` by default. Without this,
 * that landing deep-link built a stack whose ONLY entry was the dashboard, so
 * back exited the whole tab (to Floor) and the More menu was unreachable.
 * With the anchor, more/index always sits underneath a pushed screen.
 */
export const unstable_settings = { anchor: 'index' };

export default function MoreStack() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
