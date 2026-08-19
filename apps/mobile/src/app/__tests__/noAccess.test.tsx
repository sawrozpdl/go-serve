/**
 * The page a reviewer lands on when sign-in can't get them into a workspace.
 *
 * The load-bearing case is "Back to sign in". Google sign-in succeeds server-side
 * even for an account with no membership, so real tokens are sitting in secure
 * storage when this screen renders; navigating to login without clearing them lets
 * (auth)/_layout bounce straight back to "/", through the picker, and right back
 * here — a visible loop, and a dead end of exactly the kind we're fixing.
 */
import { Linking } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { clearTokens, getRefreshToken, setTokens } from '@/auth/tokenStore';
import { CONTACT_EMAIL } from '@/lib/support';

const mockReplace = jest.fn();
const mockPush = jest.fn();
let mockSearchParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useLocalSearchParams: () => mockSearchParams,
}));

// eslint-disable-next-line import/first -- must import the screen AFTER jest.mock()
import NoAccess from '../no-access';

const reset = (SecureStore as unknown as { __reset: () => void }).__reset;

beforeEach(async () => {
  jest.clearAllMocks();
  reset();
  await clearTokens();
  useTenantStore.getState().clear();
  useAuthStore.setState({ hydrated: true, hasSession: false, demo: false });
  mockSearchParams = {};
});

const setup = () => userEvent.setup();

describe('copy per reason', () => {
  it.each([
    ['google-unavailable', /Sign-in isn't ready on this copy/i],
    ['google-failed', /didn't go through/i],
    ['no-workspace', /No café is linked/i],
    ['membership-pending', /invite is waiting/i],
  ])('%s explains the situation', async (reason, headline) => {
    mockSearchParams = { reason };
    await renderWithProviders(<NoAccess />);
    expect(screen.getByText(headline)).toBeOnTheScreen();
  });

  it('falls back to a calm generic line for an unrecognised reason', async () => {
    // Never render a raw error string as the headline.
    mockSearchParams = { reason: 'TypeError: undefined is not a function' };
    await renderWithProviders(<NoAccess />);
    expect(screen.getByText(/couldn't confirm your access/i)).toBeOnTheScreen();
    expect(screen.queryByText(/TypeError/)).toBeNull();
  });

  it('always says the demo is local, so nobody fears touching a real café', async () => {
    await renderWithProviders(<NoAccess />);
    expect(screen.getByText(/entirely on this device/i)).toBeOnTheScreen();
  });
});

describe('the three actions', () => {
  it('offers all three with zero network', async () => {
    // No fetch mock installed at all: nothing here may depend on a request.
    await renderWithProviders(<NoAccess />);
    expect(screen.getByLabelText('enter-demo')).toBeOnTheScreen();
    expect(screen.getByLabelText('back-to-sign-in')).toBeOnTheScreen();
    expect(screen.getByLabelText('contact-support')).toBeOnTheScreen();
  });

  it('enters the demo and lands in the app', async () => {
    const user = setup();
    await renderWithProviders(<NoAccess />);

    await user.press(screen.getByLabelText('enter-demo'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(useAuthStore.getState().demo).toBe(true);
    expect(useAuthStore.getState().hasSession).toBe(true);
    expect(useTenantStore.getState().active?.slug).toBe('demo');
  });

  it('clears a half-session before returning to sign in', async () => {
    // The regression that would otherwise loop: tokens exist, no membership does.
    await setTokens('access-token', 'refresh-token');
    useAuthStore.setState({ hydrated: true, hasSession: true, demo: false });
    const user = setup();
    await renderWithProviders(<NoAccess />);

    await user.press(screen.getByLabelText('back-to-sign-in'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)/login'));
    expect(getRefreshToken()).toBeNull();
    expect(useAuthStore.getState().hasSession).toBe(false);
  });

  it('opens a mail draft to support, and shows the address as a fallback', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const user = setup();
    await renderWithProviders(<NoAccess />);

    await user.press(screen.getByLabelText('contact-support'));

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(String(open.mock.calls[0][0])).toContain(`mailto:${CONTACT_EMAIL}`);
    // Visible even on a device with no mail app.
    expect(screen.getByText(CONTACT_EMAIL)).toBeOnTheScreen();
    open.mockRestore();
  });
});

it('acknowledges an existing session so the actions read sensibly', async () => {
  useAuthStore.setState({ hydrated: true, hasSession: true, demo: false });
  await renderWithProviders(<NoAccess />);
  expect(screen.getByLabelText('Signed in')).toBeOnTheScreen();
});
