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
  // Email OTP login is intentionally disabled (OTP_COMING_SOON in login.tsx) —
  // the send button reads "Coming soon" and never fires a request or navigates.
  it('shows email login as "Coming soon" and does not request an OTP', async () => {
    const fetchMock = mockFetchByPath({
      '/auth/config': () => ({ json: { google_enabled: false, dev_login_enabled: false, email_otp_enabled: true } }),
      '/auth/request-otp': () => ({ json: { sent: true, expires_in_seconds: 600, resend_in_seconds: 60 } }),
    });
    const user = setup();
    await renderWithProviders(<Login />);

    await user.type(screen.getByLabelText('email'), 'cashier@cafe.com');
    // The disabled "Coming soon" button is a no-op: no request, no navigation.
    await user.press(screen.getByText('Coming soon'));

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/auth/request-otp'),
      expect.anything(),
    );
    expect(mockPush).not.toHaveBeenCalled();
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
