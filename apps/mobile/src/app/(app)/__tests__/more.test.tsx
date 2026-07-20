import * as SecureStore from 'expo-secure-store';
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { setTokens } from '@/auth/tokenStore';
import { storage } from '@/lib/kv';

const mockReplace = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: mockPush }) }));

// eslint-disable-next-line import/first -- import screen after jest.mock()
import More from '../more';

const reset = (SecureStore as unknown as { __reset: () => void }).__reset;

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  reset();
  storage.clearAll();
  await setTokens('a', 'r');
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
  mockFetchByPath({
    '/v1/me': () => ({ json: { user_id: 'u', email: 'me@cafe.com', name: 'Boss', active_permissions: [], memberships: [] } }),
    '/auth/logout': () => ({ json: {} }),
  });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
  jest.useRealTimers();
});

describe('More', () => {
  it('shows the active workspace and user', async () => {
    await renderWithProviders(<More />);
    expect(screen.getByText('Sahan Cafe')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByText(/me@cafe.com/)).toBeOnTheScreen());
  });

  it('changes the theme preference', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<More />);
    await user.press(screen.getByLabelText('theme-light'));
    expect(storage.getString('theme.override')).toBe('light');
  });

  it('navigates to the contact screen', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<More />);
    await user.press(screen.getByText('Contact us'));
    expect(mockPush).toHaveBeenCalledWith('/more/contact');
  });

  it('signs out and returns to login', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderWithProviders(<More />);
    await user.press(screen.getByText('Sign out'));
    await waitFor(() => expect(useAuthStore.getState().hasSession).toBe(false));
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
  });
});
