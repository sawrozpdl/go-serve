/**
 * Turns whatever native Google sign-in threw into a routing decision.
 *
 * Three outcomes, and the split between the last two is the point of this module:
 *
 *   cancelled  the user backed out. Say nothing, go nowhere.
 *   retry      something transient — no network, a 5xx from /auth/google/native.
 *              Stay on login and show the banner; the Google button is right
 *              there, so trying again costs one tap. Navigating away from a
 *              working sign-in screen over a flaky connection makes it look as
 *              though sign-in was withdrawn, which is exactly what it isn't.
 *   no-access  terminal on THIS install, and needs explaining rather than
 *              retrying: the native SDK couldn't match the app's signing
 *              certificate (DEVELOPER_ERROR — Play App Signing re-signs the AAB,
 *              so a Play-installed build doesn't carry the upload keystore's
 *              SHA-1), Play Services is missing, or no ID token came back.
 *
 * Pure, so it can be exhaustively unit-tested.
 */
import type { NoAccessReason } from '../lib/routes';

export type GoogleFailure =
  | 'cancelled'
  | { kind: 'retry'; message: string }
  | { kind: 'no-access'; reason: NoAccessReason };

const UNAVAILABLE = /DEVELOPER_ERROR|did not return an ID token|PLAY_SERVICES/i;

const GENERIC = "Couldn't finish signing in with Google. Please try again.";

export function classifyGoogleFailure(e: unknown): GoogleFailure {
  const code = (e as { code?: unknown } | undefined)?.code;
  const raw = (e as { message?: unknown } | undefined)?.message;
  const message = typeof raw === 'string' ? raw.trim() : '';

  if (code === 'cancelled' || /cancell?ed/i.test(message)) return 'cancelled';
  if (UNAVAILABLE.test(message)) return { kind: 'no-access', reason: 'google-unavailable' };

  // Show the error's own words when it has any — a server message ("Your account
  // is disabled") is far more use than our generic line — but cap it so a stack
  // trace can't take over the screen.
  return { kind: 'retry', message: message ? message.slice(0, 160) : GENERIC };
}
