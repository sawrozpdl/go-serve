import * as SecureStore from 'expo-secure-store';
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { getRefreshToken, clearTokens } from '@/auth/tokenStore';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockSearchParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useLocalSearchParams: () => mockSearchParams,
}));
// Google helper pulls in expo-web-browser/linking; not needed for these paths.
jest.mock('@/auth/googleOAuth', () => ({ startGoogleLogin: jest.fn() }));

// eslint-disable-next-line import/first -- must import screens AFTER jest.mock()
import { startGoogleLogin } from '@/auth/googleOAuth';
// eslint-disable-next-line import/first -- must import screens AFTER jest.mock()
import Login from '../login';
// eslint-disable-next-line import/first -- must import screens AFTER jest.mock()
import Otp from '../otp';

const reset = (SecureStore as unknown as { __reset: () => void }).__reset;

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  reset();
  await clearTokens();
  useTenantStore.getState().clear();
  useAuthStore.setState({ hydrated: true, hasSession: false, demo: false });
  mockSearchParams = { email: 'cashier@cafe.com' };
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
  jest.useRealTimers();
});

// userEvent drives the fake clock so RNTL's waitFor and the OTP resend
// countdown advance deterministically (and don't leak real timer handles).
const setup = () => userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

describe('Login', () => {
  // Email OTP is work-in-progress and hidden behind SHOW_EMAIL_OTP. Pinned so
  // nobody re-exposes an unfinished path by flipping a flag they meant to leave.
  it('hides the work-in-progress email OTP path', async () => {
    mockFetchByPath({
      '/auth/config': () => ({ json: { google_enabled: true, dev_login_enabled: false, email_otp_enabled: true } }),
    });
    await renderWithProviders(<Login />);

    // Even though the server advertises OTP as available.
    expect(screen.queryByLabelText('email')).toBeNull();
    expect(screen.queryByText('Send login code')).toBeNull();
    expect(screen.queryByText(/6-digit code/i)).toBeNull();
  });

  // Regression, and the reason this file exists. Play pulled versionCode 20 for
  // Broken Functionality: the screen's only controls were a permanently-disabled
  // "coming soon" button and a Google button gated behind a /auth/config call that
  // could never land. So a failed config must still leave a control that WORKS —
  // not merely one that renders.
  it('still offers a working way in when /auth/config fails', async () => {
    mockFetchByPath({ '/auth/config': () => ({ status: 500, json: { message: 'nope' } }) });
    const user = setup();
    await renderWithProviders(<Login />);

    expect(screen.getByLabelText('Continue with Google')).toBeOnTheScreen();
    expect(screen.getByLabelText('explore-as-guest')).toBeOnTheScreen();

    // And the guest path completes with no server at all.
    await user.press(screen.getByLabelText('explore-as-guest'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(useAuthStore.getState().demo).toBe(true);
    expect(useTenantStore.getState().active?.slug).toBe('demo');
  });

  it('offers the guest path even with no network whatsoever', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network request failed'));
    const user = setup();
    await renderWithProviders(<Login />);

    await user.press(screen.getByLabelText('explore-as-guest'));

    await waitFor(() => expect(useAuthStore.getState().hasSession).toBe(true));
    expect(getRefreshToken()).toBeNull();
  });

  it('routes a Google failure to the access page instead of reddening a banner', async () => {
    mockFetchByPath({
      '/auth/config': () => ({ json: { google_enabled: true, dev_login_enabled: false, email_otp_enabled: false } }),
    });
    // Verbatim message Play's reviewer hit on a Play-signed build, where the App
    // Signing SHA-1 has no matching Android OAuth client.
    (startGoogleLogin as jest.Mock).mockRejectedValueOnce(
      new Error(
        'DEVELOPER_ERROR: Follow troubleshooting instructions at https://react-native-google-signin.github.io/docs/troubleshooting',
      ),
    );
    const user = setup();
    await renderWithProviders(<Login />);

    await user.press(screen.getByLabelText('Continue with Google'));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: '/no-access',
          params: expect.objectContaining({ reason: 'google-unavailable' }),
        }),
      ),
    );
    expect(screen.queryByLabelText('login-error')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('says nothing and goes nowhere when the user cancels Google', async () => {
    mockFetchByPath({
      '/auth/config': () => ({ json: { google_enabled: true, dev_login_enabled: false, email_otp_enabled: false } }),
    });
    (startGoogleLogin as jest.Mock).mockRejectedValueOnce({
      status: 0,
      code: 'cancelled',
      message: 'Sign-in was cancelled.',
    });
    const user = setup();
    await renderWithProviders(<Login />);

    await user.press(screen.getByLabelText('Continue with Google'));

    await waitFor(() => expect(startGoogleLogin).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('login-error')).toBeNull();
  });
});

describe('Otp', () => {
  it('verifies the 6-digit code, stores tokens, and enters the app', async () => {
    const fetchMock = mockFetchByPath({
      '/auth/verify-otp': () => ({
        json: {
          access_token: 'acc',
          refresh_token: 'ref',
          access_expires_in: 900,
          user_id: 'u1',
          session_id: 's1',
        },
      }),
    });
    const user = setup();
    await renderWithProviders(<Otp />);

    await user.type(screen.getByLabelText('otp-code'), '123456');

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/verify-otp'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(getRefreshToken()).toBe('ref');
  });

  it('shows an error and clears the field on a wrong code', async () => {
    mockFetchByPath({
      '/auth/verify-otp': () => ({
        status: 401,
        json: { code: 'otp_invalid', message: 'That code is not right.', attempts_remaining: 2 },
      }),
    });
    const user = setup();
    await renderWithProviders(<Otp />);

    await user.type(screen.getByLabelText('otp-code'), '000000');

    await waitFor(() => expect(screen.getByText(/2 left/)).toBeOnTheScreen());
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

/**
 * The floor of the whole design: even if the server disables every sign-in method
 * it knows about, the screen is not empty. A "no way in at all" login is precisely
 * what Play pulled versionCode 20 for.
 */
it('still has a working control when the server disables every sign-in method', async () => {
  mockFetchByPath({
    '/auth/config': () => ({
      json: { google_enabled: false, dev_login_enabled: false, email_otp_enabled: false },
    }),
  });
  const user = setup();
  await renderWithProviders(<Login />);

  await waitFor(() => expect(screen.queryByLabelText('Continue with Google')).toBeNull());
  expect(screen.getByLabelText('explore-as-guest')).toBeOnTheScreen();
  // No orphaned "or" rule with nothing above it.
  expect(screen.queryByText('or')).toBeNull();

  await user.press(screen.getByLabelText('explore-as-guest'));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
});
