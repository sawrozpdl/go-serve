/**
 * Turns whatever native Google sign-in threw into a routing decision.
 *
 * Native sign-in fails with opaque SDK codes. The one we hit in production is
 * DEVELOPER_ERROR: Play App Signing re-signs the AAB with Google's own key, so a
 * Play-installed build doesn't carry the upload keystore's SHA-1 and the native
 * SDK's package+certificate match fails. Whatever the cause, the user gets a
 * designed page rather than a dead tap — except for a cancel, which must leave
 * them exactly where they were.
 *
 * Pure, so it can be exhaustively unit-tested.
 */
import type { NoAccessReason } from '../lib/routes';

export type GoogleFailure = 'cancelled' | { reason: NoAccessReason; detail?: string };

const UNAVAILABLE = /DEVELOPER_ERROR|did not return an ID token|PLAY_SERVICES/i;

export function classifyGoogleFailure(e: unknown): GoogleFailure {
  const code = (e as { code?: unknown } | undefined)?.code;
  const raw = (e as { message?: unknown } | undefined)?.message;
  const message = typeof raw === 'string' ? raw : '';

  if (code === 'cancelled' || /cancell?ed/i.test(message)) return 'cancelled';
  if (UNAVAILABLE.test(message)) return { reason: 'google-unavailable' };

  const detail = message.trim().slice(0, 120);
  return { reason: 'google-failed', ...(detail ? { detail } : {}) };
}
