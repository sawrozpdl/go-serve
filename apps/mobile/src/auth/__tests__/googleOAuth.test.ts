/**
 * The cancel path, which a real device proved was broken.
 *
 * This SDK version RETURNS `{ type: 'cancelled' }` from signIn() rather than
 * throwing statusCodes.SIGN_IN_CANCELLED, so the catch block for the thrown form
 * never fires. Without an explicit branch, backing out of the account picker fell
 * through to "Google did not return an ID token" — which the login screen then
 * reported as a broken build and navigated away from. Backing out must be a no-op.
 */
import type { ApiError } from '@cafe-mgmt/api-types';

// The jest.mock factory is hoisted above any const in this file, so the doubles
// have to be created INSIDE it and fetched back afterwards.
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn().mockResolvedValue(true),
    signIn: jest.fn(),
  },
  isSuccessResponse: (r: { type?: string }) => r?.type === 'success',
  isCancelledResponse: (r: { type?: string }) => r?.type === 'cancelled',
  isErrorWithCode: (e: unknown) => typeof (e as { code?: unknown })?.code === 'string',
  statusCodes: { SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED' },
}));

// eslint-disable-next-line import/first -- import after jest.mock()
import { GoogleSignin } from '@react-native-google-signin/google-signin';
// eslint-disable-next-line import/first
import { startGoogleLogin } from '../googleOAuth';
// eslint-disable-next-line import/first
import { classifyGoogleFailure } from '../googleFailure';

const signIn = GoogleSignin.signIn as jest.Mock;

const attempt = () => startGoogleLogin().catch((e: ApiError) => e) as Promise<ApiError>;

it('reports a returned cancel as a cancel, so the caller stays put', async () => {
  signIn.mockResolvedValue({ type: 'cancelled' });

  const err = await attempt();

  expect(err.code).toBe('cancelled');
  // And the classifier turns that into "go nowhere", not a no-access redirect.
  expect(classifyGoogleFailure(err)).toBe('cancelled');
});

it('still reports a genuinely missing ID token as unavailable', async () => {
  signIn.mockResolvedValue({ type: 'success', data: { idToken: null } });

  const err = await attempt();

  expect(err.message).toMatch(/did not return an ID token/i);
  expect(classifyGoogleFailure(err)).toEqual({ reason: 'google-unavailable' });
});

it('maps the thrown-cancel form too, for older SDK behaviour', async () => {
  signIn.mockRejectedValue({ code: 'SIGN_IN_CANCELLED' });

  const err = await attempt();

  expect(err.code).toBe('cancelled');
});
