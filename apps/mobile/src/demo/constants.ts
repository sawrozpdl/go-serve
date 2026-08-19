/**
 * Leaf constants for guest ("demo") mode. Imports nothing but a type — the auth
 * store needs DEMO_SLUG to heal a stale persisted tenant, and importing the rest
 * of src/demo/ from a store would make an import cycle.
 */
import type { ActiveTenant } from '../stores/tenant';

/** Slug the demo tenant claims. Deliberately not a real workspace slug: the auth
 *  store treats an active tenant with this slug but no demo flag as stale state
 *  left behind by a force-quit, and clears it. */
export const DEMO_SLUG = 'demo';

export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000ca1';
export const DEMO_USER_ID = '00000000-0000-4000-8000-000000000e51';

/** Café the demo world models. Surfaces in the More header + floor wordmark. */
export const DEMO_CAFE_NAME = 'Himal Beans · Demo';

export const DEMO_TENANT: ActiveTenant = {
  slug: DEMO_SLUG,
  id: DEMO_TENANT_ID,
  name: DEMO_CAFE_NAME,
};
