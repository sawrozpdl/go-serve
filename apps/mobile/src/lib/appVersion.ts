/**
 * What build this is, in one string a triage screen can act on.
 *
 * Bug reports were being filed with the literal string 'go-serve-mobile' as
 * their version, which is the app's name and tells triage nothing: not which
 * release, and — because Go Serve ships OTA updates — not even which JS
 * bundle is actually running on top of that release. Two phones reporting the
 * same crash on "go-serve-mobile" could be a version apart.
 *
 * So: the release, plus the OTA update's short id when the running bundle is
 * NOT the one baked into the build. "1.1.3 (a3f9c1e2)" versus plain "1.1.3".
 */
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

/** Pure core, so the formatting is testable without the native modules. */
export function formatAppVersion(
  version: string | undefined,
  embedded: boolean,
  updateId: string | null | undefined,
): string {
  const base = version?.trim() || 'unknown';
  if (embedded || !updateId) return base;
  return `${base} (${updateId.slice(0, 8)})`;
}

export function appVersion(): string {
  return formatAppVersion(
    Constants.expoConfig?.version,
    Updates.isEmbeddedLaunch,
    Updates.updateId,
  );
}
