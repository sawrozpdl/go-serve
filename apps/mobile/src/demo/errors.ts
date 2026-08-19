/**
 * Errors the demo backend throws. Two distinct kinds, and the difference matters:
 *
 *  - `unsupported()` — this endpoint isn't part of the guest demo at all. Worded
 *    as an end state rather than a failure, because the ErrorState retry button
 *    will only re-fail. Reads land in the screen's existing ErrorState, mutations
 *    in its existing toast, so nothing ever looks *broken*.
 *  - `conflict()` — the demo behaving CORRECTLY, reproducing a real business rule
 *    (overpayment, outstanding balance, invalid kitchen transition). Uses the same
 *    codes + statuses the Go handlers emit so the screens' own copy still fits.
 *
 * ApiError is a plain object, not an Error subclass (see src/lib/errorText.ts).
 */
import type { ApiError } from '@cafe-mgmt/api-types';

export const DEMO_UNSUPPORTED = 'demo_unsupported';

export function unsupported(method: string, path: string): ApiError {
  if (__DEV__) {
    // A route the in-scope screens can reach and we forgot is a silent-empty
    // render on the three surfaces that have no isError branch
    // (useOrderController, SettleSheet, floor's order list). Be loud in dev;
    // src/demo/__tests__/transport.test.ts is the real guard.
    console.error(`[demo] unhandled route: ${method} ${path}`);
  }
  return {
    status: 501,
    code: DEMO_UNSUPPORTED,
    message: "This part isn't in the guest demo. Sign in with your own workspace to use it.",
  };
}

/** A real business-rule rejection, mirroring the API's own code + status. */
export function conflict(code: string, message: string, status = 409): ApiError {
  return { status, code, message };
}

export function notFound(): ApiError {
  return { status: 404, code: 'not_found', message: 'That record no longer exists.' };
}

export function badRequest(message: string): ApiError {
  return { status: 400, code: 'bad_request', message };
}
