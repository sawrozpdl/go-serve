/**
 * Tables and Stations: the fields the phone could not reach, and the gates it
 * was not applying.
 */
import { fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  Redirect: () => null,
}));

/* eslint-disable import/first -- import screens after jest.mock() */
import TablesManager from '../tables';
import OutletsManager from '../outlets';
/* eslint-enable import/first */

const TABLE = {
  id: 't1',
  name: 'Table 4',
  capacity: 4,
  area: 'Terrace',
  status: 'free' as const,
  icon: 'Armchair',
  sort: 1,
};

function mockTables(tables: unknown[], perms: string[]) {
  return mockFetchByPath({
    '/v1/tables': () => ({ json: { tables } }),
    '/v1/me': () => ({
      json: { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: perms, memberships: [] },
    }),
  });
}

function mockOutlets(outlets: unknown[], perms: string[], features: string[]) {
  return mockFetchByPath({
    '/v1/outlets': () => ({ json: { outlets } }),
    '/v1/me': () => ({
      json: {
        user_id: 'u',
        email: 'a@b.c',
        name: 'A',
        active_permissions: perms,
        memberships: [],
        billing: { plan_key: 'pro', phase: 'active', write_locked: false, member_limit: null, seats_used: 1, features },
      },
    }),
  });
}

const bodyOf = (method: string, path: string) => {
  const call = (globalThis.fetch as jest.Mock).mock.calls.find(
    (c) => String(c[0]).includes(path) && (c[1]?.method ?? 'GET').toUpperCase() === method,
  );
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) : undefined;
};

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('Tables', () => {
  it('frees a table stuck on reserved — the floor tab can only sweep dirty ones', async () => {
    // A booking that never arrived used to hold the table until someone
    // opened a laptop.
    mockTables([{ ...TABLE, status: 'reserved' }], ['table:read', 'table:update']);
    await renderWithProviders(<TablesManager />);
    await waitFor(() => expect(screen.getByText('Reserved')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Table 4'));
    await waitFor(() => expect(screen.getByLabelText('Free')).toBeOnTheScreen());
    await userEvent.press(screen.getByLabelText('Free'));
    await userEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(bodyOf('PATCH', '/v1/tables/t1')).toMatchObject({ status: 'free' }));
  });

  it('warns that freeing an occupied table does not close its tab', async () => {
    mockTables([{ ...TABLE, status: 'occupied' }], ['table:read', 'table:update']);
    await renderWithProviders(<TablesManager />);
    await waitFor(() => expect(screen.getByText('Occupied')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Table 4'));
    await waitFor(() => expect(screen.getByLabelText('Free')).toBeOnTheScreen());
    await userEvent.press(screen.getByLabelText('Free'));

    expect(screen.getByText(/open tab stays open/)).toBeOnTheScreen();
  });

  it('never sends a status when creating — a new table is always free', async () => {
    mockTables([TABLE], ['table:read', 'table:create']);
    await renderWithProviders(<TablesManager />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('add-table'));
    await waitFor(() => expect(screen.getByText('New table')).toBeOnTheScreen());
    expect(screen.queryByLabelText('Needs clearing')).toBeNull();

    await userEvent.type(screen.getByLabelText('Name'), 'Table 9');
    await userEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(bodyOf('POST', '/v1/tables')).toBeDefined());
    expect(Object.keys(bodyOf('POST', '/v1/tables')!)).not.toContain('status');
  });

  it('refuses to save a zero-seat table — it can never be seated', async () => {
    mockTables([TABLE], ['table:read', 'table:create']);
    await renderWithProviders(<TablesManager />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('add-table'));
    await userEvent.type(screen.getByLabelText('Name'), 'Bar stool');
    await userEvent.clear(screen.getByLabelText('Seats'));
    await userEvent.type(screen.getByLabelText('Seats'), '0');
    await userEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(bodyOf('POST', '/v1/tables')).toBeDefined());
    expect(bodyOf('POST', '/v1/tables')!.capacity).toBe(1);
  });

  it('hides create and delete from a member who may only edit', async () => {
    mockTables([TABLE], ['table:read', 'table:update']);
    await renderWithProviders(<TablesManager />);
    await waitFor(() => expect(screen.getByText('Table 4')).toBeOnTheScreen());

    expect(screen.queryByLabelText('add-table')).toBeNull();
    await userEvent.press(screen.getByText('Table 4'));
    await waitFor(() => expect(screen.getByText('Edit table')).toBeOnTheScreen());
    expect(screen.queryByText('Delete')).toBeNull();
  });
});

const OUTLET = {
  id: 'o1',
  name: 'Bar',
  sort: 1,
  is_active: true,
  is_default: false,
  printer_ip: '192.168.1.50',
  printer_port: 9100,
  printer_width: '80' as const,
};

describe('Stations', () => {
  it('hides every printer setting when the plan has no thermal printing', async () => {
    // Offering a field whose endpoint the plan cannot use is worse than not
    // having it.
    mockOutlets([OUTLET], ['outlet:read', 'outlet:update'], []);
    await renderWithProviders(<OutletsManager />);
    await waitFor(() => expect(screen.getByText('Bar')).toBeOnTheScreen());

    expect(screen.queryByText('192.168.1.50:9100')).toBeNull();
    await userEvent.press(screen.getByText('Bar'));
    await waitFor(() => expect(screen.getByText('Edit outlet')).toBeOnTheScreen());
    expect(screen.queryByLabelText('Printer IP (optional)')).toBeNull();
    expect(screen.getByText(/not part of this plan/)).toBeOnTheScreen();
  });

  it('shows printer settings once the plan includes them', async () => {
    mockOutlets([OUTLET], ['outlet:read', 'outlet:update'], ['thermal_printing']);
    await renderWithProviders(<OutletsManager />);
    await waitFor(() => expect(screen.getByText('192.168.1.50:9100')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Bar'));
    await waitFor(() => expect(screen.getByLabelText('Printer IP (optional)')).toBeOnTheScreen());
  });

  it('turns a station off, and says what that actually does', async () => {
    mockOutlets([OUTLET], ['outlet:read', 'outlet:update'], ['thermal_printing']);
    await renderWithProviders(<OutletsManager />);
    await waitFor(() => expect(screen.getByText('Bar')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Bar'));
    await waitFor(() => expect(screen.getByText('Station is on')).toBeOnTheScreen());
    // A RN Switch answers to valueChange, not press: pressing it is a no-op
    // in the test renderer, and pressing its sibling label always was.
    fireEvent(screen.getByLabelText('Station is on'), 'valueChange', false);

    await waitFor(() => expect(screen.getByText(/fall back to the default/)).toBeOnTheScreen());
    await userEvent.press(screen.getByText('Save'));
    await waitFor(() => expect(bodyOf('PATCH', '/v1/outlets/o1')).toMatchObject({ is_active: false }));
  });

  it('marks an off station on the list — absent from pickers is not the same as gone', async () => {
    mockOutlets([{ ...OUTLET, is_active: false }], ['outlet:read', 'outlet:update'], []);
    await renderWithProviders(<OutletsManager />);
    await waitFor(() => expect(screen.getByText('Off')).toBeOnTheScreen());
  });

  it('never offers the on/off switch for the default station', async () => {
    // It is the routing fallback; turning it off would leave items nowhere.
    mockOutlets([{ ...OUTLET, is_default: true }], ['outlet:read', 'outlet:update'], []);
    await renderWithProviders(<OutletsManager />);
    await waitFor(() => expect(screen.getByText('Bar')).toBeOnTheScreen());

    await userEvent.press(screen.getByText('Bar'));
    await waitFor(() => expect(screen.getByText('Edit outlet')).toBeOnTheScreen());
    expect(screen.queryByText('Station is on')).toBeNull();
  });
});
