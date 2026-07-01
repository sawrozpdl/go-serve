import * as SecureStore from 'expo-secure-store';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { startGoogleLogin } from '../googleOAuth';
import { getRefreshToken, clearTokens } from '../tokenStore';
import { useAuthStore } from '../../stores/auth';

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn().mockResolvedValue(true),
    signIn: jest.fn(),
  },
  isSuccessResponse: (r: { type?: string }) => r?.type === 'success',
  isErrorWithCode: (e: unknown) => !!e && typeof (e as { code?: unknown }).code !== 'undefined',
  statusCodes: { SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED' },
}));

const reset = (SecureStore as unknown as { __reset: () => void }).__reset;
const signIn = GoogleSignin.signIn as jest.Mock;

beforeEach(async () => {
  reset();
  await clearTokens();
  useAuthStore.setState({ hasSession: false });
  jest.clearAllMocks();
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({
      access_token: 'g-acc',
      refresh_token: 'g-ref',
      access_expires_in: 900,
      user_id: 'u',
      session_id: 's',
    }),
  } as unknown as Response);
});

afterEach(() => {
  (globalThis.fetch as jest.Mock).mockRestore();
});

describe('startGoogleLogin (native)', () => {
  it('posts the ID token to /auth/google/native and stores tokens', async () => {
    signIn.mockResolvedValue({ type: 'success', data: { idToken: 'google-id-token', user: {} } });
    await startGoogleLogin();
    expect(GoogleSignin.hasPlayServices).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/google/native'),
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(((globalThis.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ id_token: 'google-id-token' });
    expect(getRefreshToken()).toBe('g-ref');
    expect(useAuthStore.getState().hasSession).toBe(true);
  });

  it('throws a friendly error when the user cancels', async () => {
    signIn.mockRejectedValue({ code: 'SIGN_IN_CANCELLED' });
    await expect(startGoogleLogin()).rejects.toMatchObject({ message: expect.stringMatching(/cancel/i) });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws when no ID token is returned', async () => {
    signIn.mockResolvedValue({ type: 'success', data: { idToken: null } });
    await expect(startGoogleLogin()).rejects.toMatchObject({ message: expect.stringMatching(/ID token/i) });
  });

  it('rethrows unexpected sign-in errors', async () => {
    signIn.mockRejectedValue(new Error('play services boom'));
    await expect(startGoogleLogin()).rejects.toThrow('play services boom');
  });
});
