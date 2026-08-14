import * as SecureStore from 'expo-secure-store';
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { getRefreshToken, clearTokens } from '@/auth/tokenStore';

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
  it('requests an OTP and moves to the code screen', async () => {
    const fetchMock = mockFetchByPath({
      '/auth/config': () => ({ json: { google_enabled: false, dev_login_enabled: false, email_otp_enabled: true } }),
      '/auth/request-otp': () => ({ json: { sent: true, expires_in_seconds: 600, resend_in_seconds: 60 } }),
    });
    const user = setup();
    await renderWithProviders(<Login />);

    await user.type(screen.getByLabelText('email'), 'cashier@cafe.com');
    await user.press(screen.getByText('Send login code'));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/(auth)/otp',
        params: { email: 'cashier@cafe.com' },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/request-otp'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // Regression: the screen used to render only a permanently-disabled "Coming
  // soon" button, and gated Google behind a /auth/config call that could never
  // land — leaving nothing tappable at all. Play flagged exactly that as a
  // Broken Functionality violation, so a failed config must still leave a
  // working way in.
  it('still offers a working login path when /auth/config fails', async () => {
    mockFetchByPath({
      '/auth/config': () => ({ status: 500, json: { message: 'nope' } }),
      '/auth/request-otp': () => ({ json: { sent: true, expires_in_seconds: 600, resend_in_seconds: 60 } }),
    });
    const user = setup();
    await renderWithProviders(<Login />);

    expect(screen.getByLabelText('Continue with Google')).toBeOnTheScreen();

    await user.type(screen.getByLabelText('email'), 'cashier@cafe.com');
    await user.press(screen.getByText('Send login code'));

    await waitFor(() => expect(mockPush).toHaveBeenCalled());
  });

  it('surfaces a Google sign-in failure instead of swallowing it', async () => {
    mockFetchByPath({
      '/auth/config': () => ({ json: { google_enabled: true, dev_login_enabled: false, email_otp_enabled: true } }),
    });
    (startGoogleLogin as jest.Mock).mockRejectedValueOnce(new Error('DEVELOPER_ERROR'));
    const user = setup();
    await renderWithProviders(<Login />);

    await user.press(screen.getByLabelText('Continue with Google'));

    await waitFor(() => expect(screen.getByLabelText('login-error')).toBeOnTheScreen());
    expect(screen.getByText(/not available on this build/i)).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
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
