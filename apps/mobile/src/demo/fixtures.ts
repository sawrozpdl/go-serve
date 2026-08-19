/**
 * The demo café's static catalog. Everything here is typed against the real DTOs,
 * so `tsc` catches shape drift the moment a field is added to the API contract —
 * which is the whole reason these live in code rather than a JSON blob.
 *
 * Menu content is lifted from apps/landing/src/data/demo-menu.ts so the marketing
 * playground and the in-app demo show the same café. Prices there are whole NPR;
 * here they are paisa.
 */
import type {
  HouseTab,
  InventoryItem,
  Me,
  MenuCategory,
  MenuItem,
  ModifierGroup,
  Outlet,
  ServiceTable,
  TenantSettings,
} from '@cafe-mgmt/api-types';
import { DEMO_CAFE_NAME, DEMO_SLUG, DEMO_TENANT_ID, DEMO_USER_ID } from './constants';

/** Stable ids so seeded orders can reference the catalog by hand. */
export const ID = {
  outletKitchen: 'd0000000-0000-4000-8000-000000000001',
  outletBar: 'd0000000-0000-4000-8000-000000000002',
  catEspresso: 'd0000000-0000-4000-8000-000000000011',
  catBakery: 'd0000000-0000-4000-8000-000000000012',
  catMains: 'd0000000-0000-4000-8000-000000000013',
  groupMilk: 'd0000000-0000-4000-8000-000000000021',
  modShot: 'd0000000-0000-4000-8000-000000000022',
  modOat: 'd0000000-0000-4000-8000-000000000023',
  modNoSugar: 'd0000000-0000-4000-8000-000000000024',
  tabStaff: 'd0000000-0000-4000-8000-000000000031',
  tabHotel: 'd0000000-0000-4000-8000-000000000032',
} as const;

/**
 * The grant set is the demo's SCOPE SWITCH: (app)/_layout and more/index gate
 * every tab and row through can(me, …), so what we grant here is exactly what a
 * guest can reach — no screen needs a demo branch.
 *
 * Read the omissions as carefully as the grants. `menu:read` and `table:read` are
 * deliberately absent: they would make the Catalog rows appear, but more/menu.tsx
 * and more/tables.tsx gate on *write* perms and <Redirect href="/more" />, so a
 * guest would tap "Menu" and be thrown silently back — the exact
 * broken-functionality signal that got the app rejected. The POS menu picker is
 * unaffected (MenuGrid and useOrderController call the menu hooks
 * unconditionally), so the full menu still shows where it matters.
 *
 * Likewise absent: outlet:read / inventory:read / shift:read / expense:read /
 * house_tab:read / member:read (same write-gate bounce), and tenant:update (which
 * would surface Settings AND Printing — and Printing's scan/test buttons open real
 * LAN sockets that bypass the request layer entirely).
 */
export const DEMO_PERMISSIONS: string[] = [
  'order:read',
  'order:create',
  'order:add_items',
  'order:update_item',
  'order:void_item',
  'order:send_kitchen',
  'order:settle',
  'payment:read',
  'payment:record',
  'adjustment:read',
  'adjustment:apply',
  'kitchen:read',
  'kitchen:update',
  'report:read',
];

export const demoMe = (): Me => ({
  user_id: DEMO_USER_ID,
  email: 'guest@demo.goserve.app',
  name: 'Guest',
  active_tenant_slug: DEMO_SLUG,
  active_role_keys: ['manager'],
  active_roles: ['manager'],
  active_permissions: [...DEMO_PERMISSIONS],
  memberships: [
    {
      tenant_id: DEMO_TENANT_ID,
      tenant_slug: DEMO_SLUG,
      tenant_name: DEMO_CAFE_NAME,
      roles: ['manager'],
      status: 'active',
    },
  ],
  // Keeps the Platform / Super console section out of the More hub.
  is_platform_admin: false,
});

export const demoTenant = (): TenantSettings => ({
  id: DEMO_TENANT_ID,
  slug: DEMO_SLUG,
  name: DEMO_CAFE_NAME,
  branding: { cafeName: DEMO_CAFE_NAME, mood: 'amber-dawn', tagline: 'Roasted in Thamel' },
  preferences: {
    stackItems: true,
    autoReadyOnSend: false,
    // Explicitly false. api-types treats `undefined` as true, which would collapse
    // ready → served on send and leave the KDS "Ready" column permanently empty —
    // gutting the part of the demo the kitchen board exists to show.
    autoServeOnReady: false,
    // Leaves a table `dirty` after settling, so the sweep gesture is discoverable.
    autoCleanTables: false,
    combinedSettle: true,
    autoRecordPayment: true,
    requireTxnRef: false,
    // No printer on a reviewer's device; this hides every print affordance
    // without touching a component.
    printingEnabled: false,
  },
  plan: 'growth',
  status: 'active',
  timezone: 'Asia/Kathmandu',
  vat_pct: '13.00',
  vat_mode: 'exclusive',
  service_charge_pct: '10.00',
  contact_phone: '',
  created_at: '2026-02-01T04:00:00.000Z',
});

export const demoOutlets = (): Outlet[] => [
  {
    id: ID.outletKitchen,
    name: 'Kitchen',
    sort: 0,
    is_active: true,
    is_default: true,
    printer_ip: null,
    printer_port: 9100,
    printer_width: '80',
  },
  {
    id: ID.outletBar,
    name: 'Bar',
    sort: 1,
    is_active: true,
    is_default: false,
    printer_ip: null,
    printer_port: 9100,
    printer_width: '80',
  },
];

const category = (
  id: string,
  name: string,
  sort: number,
  icon: string,
  outletId: string,
  itemCount: number,
  groups: string[] = [],
): MenuCategory => ({
  id,
  name,
  sort,
  icon,
  color: null,
  image_url: null,
  is_active: true,
  kitchen_behavior: 'inherit',
  outlet_id: outletId,
  item_count: itemCount,
  modifier_group_ids: groups,
});

export const demoCategories = (): MenuCategory[] => [
  // The add-on group hangs off the CATEGORY, so every coffee offers extras and
  // nothing else does — one tap for food, a picker for drinks.
  category(ID.catEspresso, 'Espresso Bar', 0, 'Coffee', ID.outletBar, 4, [ID.groupMilk]),
  category(ID.catBakery, 'Bakery', 1, 'Croissant', ID.outletKitchen, 3),
  category(ID.catMains, 'Mains', 2, 'Soup', ID.outletKitchen, 3),
];

type ItemSeed = {
  key: string;
  name: string;
  cat: string;
  npr: number;
  icon: string;
  featured?: boolean;
  allowHalf?: boolean;
};

/** Mirrors DEMO_MENU in apps/landing/src/data/demo-menu.ts. */
const ITEM_SEEDS: ItemSeed[] = [
  { key: '41', name: 'Espresso', cat: ID.catEspresso, npr: 180, icon: 'Coffee' },
  { key: '42', name: 'Cappuccino', cat: ID.catEspresso, npr: 220, icon: 'Coffee', featured: true },
  { key: '43', name: 'Cafe Latte', cat: ID.catEspresso, npr: 250, icon: 'Coffee' },
  { key: '44', name: 'Mocha', cat: ID.catEspresso, npr: 280, icon: 'Coffee' },
  { key: '45', name: 'Butter Croissant', cat: ID.catBakery, npr: 190, icon: 'Croissant', featured: true },
  { key: '46', name: 'Walnut Brownie', cat: ID.catBakery, npr: 210, icon: 'Cookie' },
  { key: '47', name: 'Banana Bread', cat: ID.catBakery, npr: 170, icon: 'Cake' },
  { key: '48', name: 'Chicken Momo', cat: ID.catMains, npr: 320, icon: 'Soup', featured: true, allowHalf: true },
  { key: '49', name: 'Veg Thukpa', cat: ID.catMains, npr: 280, icon: 'Soup' },
  { key: '50', name: 'Cheese Fried Rice', cat: ID.catMains, npr: 300, icon: 'Utensils' },
];

export const ITEM_ID = Object.fromEntries(
  ITEM_SEEDS.map((s) => [s.name, `d0000000-0000-4000-8000-0000000000${s.key}`]),
) as Record<string, string>;

export const demoItems = (): MenuItem[] =>
  ITEM_SEEDS.map((s, i) => ({
    id: ITEM_ID[s.name],
    category_id: s.cat,
    name: s.name,
    description: '',
    price_cents: s.npr * 100,
    cost_cents: Math.round(s.npr * 100 * 0.38),
    sku: null,
    image_url: null,
    icon: s.icon,
    is_active: true,
    is_featured: !!s.featured,
    kitchen_behavior: 'inherit',
    outlet_id: null,
    allow_half: !!s.allowHalf,
    sort: i,
    modifier_group_ids: [],
    modifiers: null,
    preset_notes: s.cat === ID.catEspresso ? ['extra hot', 'less sugar'] : [],
  }));

export const demoModifierGroups = (): ModifierGroup[] => [
  {
    id: ID.groupMilk,
    name: 'Milk & extras',
    // Optional, so a coffee is still addable with one tap through the sheet.
    min_select: 0,
    max_select: 3,
    sort: 0,
    is_active: true,
    item_count: 0,
    category_count: 1,
    modifiers: [
      { id: ID.modShot, group_id: ID.groupMilk, name: 'Extra shot', price_cents: 6000, cost_cents: 2000, sort: 0, is_active: true },
      { id: ID.modOat, group_id: ID.groupMilk, name: 'Oat milk', price_cents: 8000, cost_cents: 3000, sort: 1, is_active: true },
      { id: ID.modNoSugar, group_id: ID.groupMilk, name: 'No sugar', price_cents: 0, cost_cents: null, sort: 2, is_active: true },
    ],
  },
];

type TableSeed = [name: string, cap: number, area: string, icon: string];
const TABLE_SEEDS: TableSeed[] = [
  ['G1', 4, 'Garden', 'Sofa'],
  ['G2', 4, 'Garden', 'Sofa'],
  ['G3', 2, 'Garden', 'Armchair'],
  ['G4', 6, 'Garden', 'Sofa'],
  ['T1', 2, 'Indoor', 'Armchair'],
  ['T2', 2, 'Indoor', 'Armchair'],
  ['T3', 4, 'Indoor', 'Armchair'],
  ['T4', 4, 'Indoor', 'Armchair'],
  ['T5', 6, 'Indoor', 'Sofa'],
  ['T6', 2, 'Indoor', 'Armchair'],
  ['P1', 4, 'Terrace', 'Sofa'],
  ['P2', 4, 'Terrace', 'Sofa'],
];

export const TABLE_ID = Object.fromEntries(
  TABLE_SEEDS.map(([name], i) => [name, `d0000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`]),
) as Record<string, string>;

/** All free; seed.ts flips the ones its orders occupy. */
export const demoTables = (): ServiceTable[] =>
  TABLE_SEEDS.map(([name, capacity, area, icon], sort) => ({
    id: TABLE_ID[name],
    name,
    capacity,
    area,
    status: 'free',
    icon,
    sort,
  }));

/** Two accounts so the settle sheet's Credit tender has real, labelled targets. */
export const demoHouseTabs = (): HouseTab[] => [
  {
    id: ID.tabStaff,
    name: 'Staff tab',
    notes: 'Team meals, settled monthly',
    contact_phone: '',
    is_active: true,
    charged_cents: 0,
    settled_cents: 0,
    balance_cents: 0,
    open_charge_count: 0,
    created_at: '2026-02-01T04:00:00.000Z',
    archived_at: null,
  },
  {
    id: ID.tabHotel,
    name: 'Sunrise Hotel',
    notes: 'Breakfast covers, invoiced fortnightly',
    contact_phone: '9800000000',
    is_active: true,
    charged_cents: 450000,
    settled_cents: 0,
    balance_cents: 450000,
    open_charge_count: 3,
    created_at: '2026-02-01T04:00:00.000Z',
    archived_at: null,
  },
];

export const demoInventory = (): InventoryItem[] => [
  { id: 'd0000000-0000-4000-8000-000000000201', name: 'Espresso beans', sku: 'BEAN-1', kind: 'ingredient', sale_unit: 'kg', qty_on_hand_units: '8.400', par_low_units: '3.000', last_purchase_unit_cost_cents: 145000, notes: '', is_low_stock: false },
  { id: 'd0000000-0000-4000-8000-000000000202', name: 'Whole milk', sku: 'MILK-1', kind: 'ingredient', sale_unit: 'ltr', qty_on_hand_units: '2.000', par_low_units: '6.000', last_purchase_unit_cost_cents: 11000, notes: 'Order before the weekend', is_low_stock: true },
  { id: 'd0000000-0000-4000-8000-000000000203', name: 'Oat milk', sku: 'MILK-2', kind: 'ingredient', sale_unit: 'ltr', qty_on_hand_units: '9.000', par_low_units: '4.000', last_purchase_unit_cost_cents: 26000, notes: '', is_low_stock: false },
  { id: 'd0000000-0000-4000-8000-000000000204', name: 'Butter', sku: 'BUT-1', kind: 'ingredient', sale_unit: 'kg', qty_on_hand_units: '5.500', par_low_units: '2.000', last_purchase_unit_cost_cents: 98000, notes: '', is_low_stock: false },
  { id: 'd0000000-0000-4000-8000-000000000205', name: 'Momo wrappers', sku: 'MOM-1', kind: 'ingredient', sale_unit: 'pkt', qty_on_hand_units: '18.000', par_low_units: '10.000', last_purchase_unit_cost_cents: 9000, notes: '', is_low_stock: false },
  { id: 'd0000000-0000-4000-8000-000000000206', name: 'Bottled water', sku: 'WAT-1', kind: 'retail', sale_unit: 'btl', qty_on_hand_units: '46.000', par_low_units: '24.000', last_purchase_unit_cost_cents: 2500, notes: '', is_low_stock: false },
];
