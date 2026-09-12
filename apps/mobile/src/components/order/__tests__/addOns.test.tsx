/**
 * Add-ons on the mobile POS (migration 0062).
 *
 * The property that matters: a chosen add-on rides INSIDE its parent line — one
 * line, one folded price — and the add-on set is part of the line's identity, so
 * two differently-topped dishes never collapse together.
 */
import type { ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resolveAddOnRows, type MenuItem, type ModifierGroup } from '@cafe-mgmt/api-types';
import { useTenantStore } from '@/stores/tenant';
import { useConnectivity } from '@/stores/connectivity';
import { useDraftCart, startDraft } from '@/stores/draftCart';
import { useOrderController } from '../useOrderController';

let uuidN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `l-${(uuidN += 1)}` }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ orderId: 'new' }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const SLUG = 'sahan';
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const CHEESE = {
  id: 'mod-cheese',
  group_id: 'g1',
  name: 'Extra cheese',
  price_cents: 50,
  cost_cents: 12,
  sort: 0,
  is_active: true,
};
const BACON = {
  id: 'mod-bacon',
  group_id: 'g1',
  name: 'Bacon',
  price_cents: 80,
  cost_cents: null,
  sort: 1,
  is_active: true,
};

const GROUP: ModifierGroup = {
  id: 'g1',
  name: 'Sandwich extras',
  min_select: 0,
  max_select: null,
  sort: 0,
  is_active: true,
  modifiers: [CHEESE, BACON],
  item_count: 1,
  category_count: 0,
};

function mockRoutes(groups: ModifierGroup[] = [GROUP]) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    let json: unknown = {};
    if (url.includes('/v1/menu/modifier-groups')) json = { groups };
    else if (url.includes('/v1/menu/categories')) json = { categories: [{ id: 'c1', name: 'Food', sort: 0, icon: '', is_active: true, kitchen_behavior: 'inherit', item_count: 1, modifier_group_ids: [] }] };
    else if (url.includes('/v1/menu/popular')) json = { items: [] };
    else if (url.includes('/v1/menu/items')) json = { items: [] };
    else if (url.includes('/v1/outlets')) json = { outlets: [] };
    else if (url.includes('/v1/tables')) json = { tables: [] };
    else if (url.includes('/v1/orders')) json = { orders: [] };
    else if (url.includes('/v1/tenant')) json = { preferences: {} };
    else if (url.includes('/v1/me')) {
      json = {
        user_id: 'u',
        email: 'a@b.c',
        name: 'A',
        active_permissions: ['order:create', 'order:add_items', 'order:send_kitchen'],
        memberships: [],
      };
    }
    return { status: 200, ok: true, statusText: '', json: async () => json } as unknown as Response;
  });
}

/** Priced add-on rows, the way the picker hands them to addMenuItem. Going
 *  through resolveAddOnRows means these tests exercise the same resolution the
 *  sheet uses, rather than hand-writing prices that could drift from the
 *  catalog above. */
const pick = (...picks: { modifier_id: string; qty?: number }[]) =>
  resolveAddOnRows([GROUP], picks);

const sandwich = (over: Partial<MenuItem> = {}): MenuItem =>
  ({
    id: 'm1',
    category_id: 'c1',
    name: 'Sandwich',
    description: '',
    price_cents: 200,
    icon: '',
    is_active: true,
    is_featured: false,
    kitchen_behavior: 'inherit',
    allow_half: false,
    sort: 0,
    modifiers: null,
    preset_notes: [],
    modifier_group_ids: ['g1'],
    ...over,
  }) as MenuItem;

/** A 200 with this body, in the shape the client's fetch wrapper expects. */
const ok = (json: unknown) =>
  ({ status: 200, ok: true, statusText: '', json: async () => json }) as unknown as Response;

/** The GET side of the world, shared by the send tests. */
function menuJson(url: string): unknown {
  if (url.includes('/v1/menu/modifier-groups')) return { groups: [GROUP] };
  if (url.includes('/v1/menu/categories')) {
    return {
      categories: [
        { id: 'c1', name: 'Food', sort: 0, icon: '', is_active: true, kitchen_behavior: 'inherit', item_count: 1, modifier_group_ids: [] },
      ],
    };
  }
  if (url.includes('/v1/menu/popular')) return { items: [] };
  if (url.includes('/v1/menu/items')) return { items: [] };
  if (url.includes('/v1/outlets')) return { outlets: [] };
  if (url.includes('/v1/tables')) return { tables: [] };
  if (url.includes('/v1/tenant')) return { preferences: {} };
  if (url.includes('/v1/me')) {
    return {
      user_id: 'u',
      email: 'a@b.c',
      name: 'A',
      active_permissions: ['order:create', 'order:add_items', 'order:send_kitchen'],
      memberships: [],
    };
  }
  if (url.includes('/v1/orders')) return { orders: [] };
  return {};
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  useTenantStore.setState({ active: { slug: SLUG, id: 't1', name: 'Sahan' } });
  useConnectivity.setState({ mode: 'online' });
  useDraftCart.setState({ tableId: null, tableName: null, label: '', items: [] });
});
afterEach(() => {
  client.clear();
  jest.restoreAllMocks();
});

describe('add-ons on a draft cart', () => {
  it('folds the add-on price into ONE line rather than adding a second line', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });

    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 1 }));
    });

    const items = useDraftCart.getState().items;
    expect(items).toHaveLength(1); // NOT two — the add-on is not its own line
    expect(items[0]?.unit_price_cents).toBe(250); // 200 + 50
    expect(items[0]?.base_price_cents).toBe(200); // the dish alone
    expect(items[0]?.line_cents).toBe(250);
    expect(items[0]?.add_ons?.map((a) => a.name)).toEqual(['Extra cheese']);
  });

  it('does not stack two lines topped differently', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });

    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 1 }));
    });
    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: BACON.id, qty: 1 }));
    });

    const items = useDraftCart.getState().items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.unit_price_cents).sort((a, b) => a - b)).toEqual([250, 280]);
  });

  it('stacks two lines topped IDENTICALLY', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });

    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 1 }));
    });
    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 1 }));
    });

    const items = useDraftCart.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.qty).toBe(2);
    expect(items[0]?.line_cents).toBe(500); // 2 × 250
  });

  it('a plain add (no add-ons) never stacks onto a topped line', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });

    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 1 }));
    });
    await act(async () => {
      await result.current.addMenuItem(sandwich());
    });

    const items = useDraftCart.getState().items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.unit_price_cents).sort((a, b) => a - b)).toEqual([200, 250]);
  });

  it('an add-on qty above one multiplies into the folded price', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });

    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 2 }));
    });

    const items = useDraftCart.getState().items;
    expect(items[0]?.unit_price_cents).toBe(300); // 200 + 2×50
    expect(items[0]?.add_ons?.[0]?.qty).toBe(2);
  });
});

describe('the draft cart\u2019s add-ons survive the first send', () => {
  it('sends add_ons with the batch that opens the tab', async () => {
    // Regression, and the expensive kind: doSend mapped id/menu_item_id/qty/
    // notes/modifiers and silently dropped `add_ons`. The ticket showed the
    // extras and their folded price the whole time the tab was on-device, then
    // the first Send charged the base price \u2014 or 400'd outright for an item
    // with a required group.
    const posts: { url: string; body: unknown }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        if (url.includes('/items')) return ok({ items: [] });
        if (url.includes('/send')) return ok({ sent: 1, to_kitchen: 1, marked_ready: 0, auto_served: 0 });
        return ok({ id: 'o-1', status: 'open', items: [] });
      }
      return ok(menuJson(url));
    });

    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 2 }));
    });
    await act(async () => {
      await result.current.doSend();
    });

    const addItems = posts.find((p) => p.url.includes('/items'));
    const sent = (addItems?.body as { items: { add_ons?: unknown[] }[] }).items[0];
    expect(sent?.add_ons).toEqual([{ id: expect.any(String), modifier_id: CHEESE.id, qty: 2 }]);
  });

  it('omits add_ons entirely for a line with none', async () => {
    // An empty array is not the same as silence to a whole-set endpoint; keep
    // the plain path byte-identical to what it always sent.
    const posts: { url: string; body: unknown }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        if (url.includes('/items')) return ok({ items: [] });
        if (url.includes('/send')) return ok({ sent: 1, to_kitchen: 1, marked_ready: 0, auto_served: 0 });
        return ok({ id: 'o-1', status: 'open', items: [] });
      }
      return ok(menuJson(url));
    });

    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await result.current.addMenuItem(sandwich({ id: 'plain', modifier_group_ids: [] }));
    });
    await act(async () => {
      await result.current.doSend();
    });

    const addItems = posts.find((p) => p.url.includes('/items'));
    const sent = (addItems?.body as { items: Record<string, unknown>[] }).items[0];
    expect(sent).not.toHaveProperty('add_ons');
  });
});

describe('changing the add-ons on a line already on the ticket', () => {
  it('replaces the whole set and re-folds onto the line\u2019s own base', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 1 }));
    });

    const line = useDraftCart.getState().items[0]!;
    await act(async () => {
      result.current.setLineAddOns(line, pick({ modifier_id: BACON.id, qty: 1 }));
    });

    const after = useDraftCart.getState().items[0]!;
    // 200 + 80 \u2014 NOT 250 + 80. Folding onto the already-folded price is the
    // mistake this guards: it would compound every time the waiter edited.
    expect(after.unit_price_cents).toBe(280);
    expect(after.add_ons?.map((a) => a.name)).toEqual(['Bacon']);
  });

  it('clears the extras when the picker comes back empty', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await result.current.addMenuItem(sandwich(), pick({ modifier_id: CHEESE.id, qty: 1 }));
    });

    const line = useDraftCart.getState().items[0]!;
    await act(async () => {
      result.current.setLineAddOns(line, []);
    });

    const after = useDraftCart.getState().items[0]!;
    expect(after.unit_price_cents).toBe(200);
    expect(after.add_ons).toEqual([]);
  });
});

describe('tapMenuItem routing', () => {
  it('opens the picker for an item WITH add-on groups instead of adding it', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    // Wait for the group catalog to land, or the tap has nothing to resolve.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      result.current.tapMenuItem(sandwich());
    });

    expect(result.current.addOnFor?.id).toBe('m1');
    // Nothing added yet — the picker has to be confirmed first.
    expect(useDraftCart.getState().items).toHaveLength(0);
  });

  it('adds immediately for an item with NO add-on groups — one tap, as before', async () => {
    mockRoutes();
    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      result.current.tapMenuItem(sandwich({ id: 'plain', modifier_group_ids: [] }));
    });

    expect(result.current.addOnFor).toBeNull();
    expect(useDraftCart.getState().items).toHaveLength(1);
  });

  it('still opens the picker when the group CATALOG has not loaded yet', async () => {
    // Regression: the branch used to ask resolveModifierGroups, which needs the
    // catalog. Tapping before it landed skipped the picker and sent a line with
    // no add-ons — which the server rejects outright for a required group. The
    // decision now comes from the item + category, which arrive with the menu.
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      // The catalog never resolves.
      if (url.includes('/v1/menu/modifier-groups')) return new Promise(() => {}) as never;
      let json: unknown = {};
      if (url.includes('/v1/menu/categories')) {
        json = { categories: [{ id: 'c1', name: 'Food', sort: 0, icon: '', is_active: true, kitchen_behavior: 'inherit', item_count: 1, modifier_group_ids: [] }] };
      } else if (url.includes('/v1/menu/popular')) json = { items: [] };
      else if (url.includes('/v1/menu/items')) json = { items: [] };
      else if (url.includes('/v1/outlets')) json = { outlets: [] };
      else if (url.includes('/v1/tables')) json = { tables: [] };
      else if (url.includes('/v1/orders')) json = { orders: [] };
      else if (url.includes('/v1/tenant')) json = { preferences: {} };
      else if (url.includes('/v1/me')) {
        json = { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: ['order:create'], memberships: [] };
      }
      return { status: 200, ok: true, statusText: '', json: async () => json } as unknown as Response;
    });

    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      result.current.tapMenuItem(sandwich());
    });

    expect(result.current.addOnFor?.id).toBe('m1');
    // And crucially nothing was added behind the picker's back.
    expect(useDraftCart.getState().items).toHaveLength(0);
  });

  it('offers a group attached to the item’s CATEGORY, not just the item', async () => {
    // The category carries the group; the item itself has none. resolveModifierGroups
    // unions both levels, so the picker must still open.
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      let json: unknown = {};
      if (url.includes('/v1/menu/modifier-groups')) json = { groups: [GROUP] };
      else if (url.includes('/v1/menu/categories')) {
        json = {
          categories: [
            { id: 'c1', name: 'Food', sort: 0, icon: '', is_active: true, kitchen_behavior: 'inherit', item_count: 1, modifier_group_ids: ['g1'] },
          ],
        };
      } else if (url.includes('/v1/menu/popular')) json = { items: [] };
      else if (url.includes('/v1/menu/items')) json = { items: [] };
      else if (url.includes('/v1/outlets')) json = { outlets: [] };
      else if (url.includes('/v1/tables')) json = { tables: [] };
      else if (url.includes('/v1/orders')) json = { orders: [] };
      else if (url.includes('/v1/tenant')) json = { preferences: {} };
      else if (url.includes('/v1/me')) {
        json = { user_id: 'u', email: 'a@b.c', name: 'A', active_permissions: ['order:create'], memberships: [] };
      }
      return { status: 200, ok: true, statusText: '', json: async () => json } as unknown as Response;
    });

    startDraft('tbl1', 'T1');
    const { result } = await renderHook(() => useOrderController(), { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      result.current.tapMenuItem(sandwich({ modifier_group_ids: [] }));
    });

    expect(result.current.addOnFor?.id).toBe('m1');
  });
});
