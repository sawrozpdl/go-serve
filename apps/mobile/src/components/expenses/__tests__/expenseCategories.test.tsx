/**
 * The expense-category manager — the half of categories mobile never had.
 * Reading them was already possible; a cafe that started on a phone had no way
 * to create the first bucket.
 */
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import { renderWithProviders, mockFetchByPath } from '@/test-utils';
import { useAuthStore } from '@/stores/auth';
import { useTenantStore } from '@/stores/tenant';
import { ExpenseCategoriesSheet } from '../ExpenseCategoriesSheet';

const CATS = [{ id: 'c1', name: 'Supplies', icon: '', is_active: true }];

function mockRoutes() {
  return mockFetchByPath({
    '/v1/expense-categories': () => ({ json: { categories: CATS, id: 'c2' } }),
    '/v1/me': () => ({
      json: { user_id: 'u1', email: 'o@c.com', name: 'O', active_permissions: ['expense:create'], memberships: [] },
    }),
  });
}

const writes = (method: string) =>
  (globalThis.fetch as jest.Mock).mock.calls.filter(
    (c) => (c[1]?.method ?? 'GET').toUpperCase() === method,
  );

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ hydrated: true, hasSession: true });
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
});

afterEach(() => {
  (globalThis.fetch as jest.Mock)?.mockRestore?.();
});

describe('ExpenseCategoriesSheet', () => {
  it('creates a category', async () => {
    mockRoutes();
    await renderWithProviders(
      <ExpenseCategoriesSheet open onClose={jest.fn()} canEdit canDelete />,
    );
    await waitFor(() => expect(screen.getByLabelText('new-category-name')).toBeOnTheScreen());

    await userEvent.type(screen.getByLabelText('new-category-name'), 'Gas');
    await userEvent.press(screen.getByText('Add category'));

    await waitFor(() => expect(writes('POST')).toHaveLength(1));
    expect(JSON.parse(String(writes('POST')[0][1].body))).toEqual({ name: 'Gas' });
  });

  it('catches a duplicate name here rather than letting the request fail', async () => {
    // Names are unique per tenant, case-insensitively, in the DB.
    mockRoutes();
    await renderWithProviders(
      <ExpenseCategoriesSheet open onClose={jest.fn()} canEdit canDelete />,
    );
    await waitFor(() => expect(screen.getByLabelText('new-category-name')).toBeOnTheScreen());

    await userEvent.type(screen.getByLabelText('new-category-name'), 'supplies');
    await userEvent.press(screen.getByText('Add category'));

    expect(writes('POST')).toHaveLength(0);
  });

  it('renames in place', async () => {
    mockRoutes();
    await renderWithProviders(
      <ExpenseCategoriesSheet open onClose={jest.fn()} canEdit canDelete />,
    );
    await waitFor(() => expect(screen.getByLabelText('edit-category-Supplies')).toBeOnTheScreen());

    await userEvent.press(screen.getByLabelText('edit-category-Supplies'));
    await waitFor(() => expect(screen.getByLabelText('category-name')).toBeOnTheScreen());
    await userEvent.clear(screen.getByLabelText('category-name'));
    await userEvent.type(screen.getByLabelText('category-name'), 'Dry goods');
    await userEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(writes('PATCH')).toHaveLength(1));
    expect(String(writes('PATCH')[0][0])).toContain('/v1/expense-categories/c1');
    expect(JSON.parse(String(writes('PATCH')[0][1].body)).name).toBe('Dry goods');
  });

  it('offers neither edit nor delete to a member who may only read', async () => {
    mockRoutes();
    await renderWithProviders(
      <ExpenseCategoriesSheet open onClose={jest.fn()} canEdit={false} canDelete={false} />,
    );
    await waitFor(() => expect(screen.getByText('Supplies')).toBeOnTheScreen());

    expect(screen.queryByLabelText('edit-category-Supplies')).toBeNull();
    expect(screen.queryByLabelText('delete-category-Supplies')).toBeNull();
    expect(screen.queryByLabelText('new-category-name')).toBeNull();
  });
});
