/**
 * Route helpers that need a cast.
 *
 * expo-router's typedRoutes generates `.expo/types/router.d.ts` from the file
 * tree, so a freshly added route isn't in the Href union until the dev server
 * regenerates it. Keeping the cast in one place mirrors what src/app/index.tsx
 * already does for the capability-resolved landing href.
 */
import type { Href } from 'expo-router';

/**
 * Why a visitor can't get into a workspace. Drives the copy on /no-access — an
 * unrecognised value falls back to 'unknown' rather than rendering a raw error.
 */
export type NoAccessReason =
  /** Native Google sign-in can't complete on this build (DEVELOPER_ERROR — the
   *  Play App Signing SHA-1 isn't registered — or no ID token, or no Play Services). */
  | 'google-unavailable'
  /** Any other sign-in failure. */
  | 'google-failed'
  /** Signed in, but the account has no memberships at all. */
  | 'no-workspace'
  /** Has membership(s), none of them active yet. */
  | 'membership-pending'
  | 'unknown';

export function noAccessHref(reason: NoAccessReason, detail?: string): Href {
  return {
    pathname: '/no-access',
    params: { reason, ...(detail ? { detail } : {}) },
  } as unknown as Href;
}
