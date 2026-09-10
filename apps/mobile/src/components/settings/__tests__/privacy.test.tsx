/**
 * Account deletion. Apple 5.1.1(v) and Google Play both require an app that
 * lets people create an account to let them delete it in-app, and Go Serve
 * shipped without one on mobile.
 */
import { Alert } from 'react-native';
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { PrivacySection } from '../PrivacySection';

/** Tap through the OS confirm by firing its destructive button. */
function confirmAlert() {
  const spy = jest.spyOn(Alert, 'alert');
  return () => {
    const buttons = spy.mock.calls.at(-1)?.[2] ?? [];
    const destructive = buttons.find((b) => b.style === 'destructive');
    destructive?.onPress?.();
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
  jest.restoreAllMocks();
});

describe('deleting an account', () => {
  it('asks first, then deletes and signs out', async () => {
    const fetchSpy = mockFetchByPath({ '/v1/me': () => ({ json: {} }) });
    const press = confirmAlert();
    await renderWithProviders(<PrivacySection />);

    await userEvent.press(screen.getByText('Delete my account'));
    // Nothing has gone yet: the confirm is the gate.
    expect(fetchSpy.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'DELETE')).toHaveLength(0);

    press();
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'DELETE'),
      ).toBeDefined(),
    );
    // Signed out: the account no longer exists, so the session must not linger.
    await waitFor(() => expect(useAuthStore.getState().hasSession).toBe(false));
  });

  it('names the workspaces blocking it, rather than showing a bare error', async () => {
    // "Transfer ownership first" is only actionable if you know where.
    mockFetchByPath({
      '/v1/me': () => ({
        status: 409,
        json: {
          code: 'sole_owner',
          message: 'you are the only active owner',
          workspaces: ['sahan', 'lakeside'],
        },
      }),
    });
    const press = confirmAlert();
    await renderWithProviders(<PrivacySection />);

    await userEvent.press(screen.getByText('Delete my account'));
    press();

    await waitFor(() => expect(screen.getByText(/only owner of 2 workspaces/)).toBeOnTheScreen());
    expect(screen.getByText('sahan, lakeside')).toBeOnTheScreen();
    expect(screen.getByText(/Leaving a cafe with no owner/)).toBeOnTheScreen();
    // Still signed in — nothing was deleted.
    expect(useAuthStore.getState().hasSession).toBe(true);
  });

  it('names a single blocking workspace by name', async () => {
    mockFetchByPath({
      '/v1/me': () => ({
        status: 409,
        json: { code: 'sole_owner', message: '', workspaces: ['sahan'] },
      }),
    });
    const press = confirmAlert();
    await renderWithProviders(<PrivacySection />);

    await userEvent.press(screen.getByText('Delete my account'));
    press();

    await waitFor(() => expect(screen.getByText(/only owner of sahan/)).toBeOnTheScreen());
  });
});

describe('exporting', () => {
  it('reads the export before trying to share it', async () => {
    const fetchSpy = mockFetchByPath({ '/v1/me/export': () => ({ json: { user: { id: 'u1' } } }) });
    await renderWithProviders(<PrivacySection />);

    await userEvent.press(screen.getByText('Export my data'));
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/v1/me/export'))).toBe(true),
    );
  });
});
