# Schema overview

PostgreSQL 16. All money is **integer paisa** (`bigint`). All timestamps `timestamptz` (UTC at rest, render in tenant timezone).

## RLS pattern

Every tenant-scoped table:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;            -- applies to the table owner too
CREATE POLICY <t>_isolation ON <t>
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON <t> TO app;  -- runtime role
```

`current_tenant_id()` and `current_user_id()` read GUCs that the API sets via `SELECT set_config('app.tenant_id', $1, true)` at the start of every request transaction. Without those settings, RLS-scoped tables return zero rows — the safety net for "developer forgot a `WHERE tenant_id`".

## Roles

- **`cafe`** — DB owner, superuser; used by migrations + seed (`DATABASE_URL`)
- **`app`** — group role (NOBYPASSRLS) granted CRUD on app tables
- **`app_user`** — runtime login role, member of `app`; used by the API (`APP_DATABASE_URL`)

## Tables

### Tenancy + identity (M1)

| Table | RLS | Notes |
|---|---|---|
| `tenants` | no | Lookup by slug pre-context. Holds `branding jsonb`, `vat_pct`, `service_charge_pct`, `timezone`. |
| `users` | no | Global users. `email` + `google_sub` unique. |
| `tenant_members` | **yes** | M:N(tenant,user) with `role` enum (`owner|manager|waiter|kitchen`), `status`, `pin_hash` (bcrypt, M11). Policy permits user-scoped reads when no tenant context set, so workspace-pick works post-login. |
| `sessions` | no | Server-side cookie store. `token_hash` (sha256). Sliding 30d expiry. |
| `audit_events` | **yes** | Append-only. Voids / discounts / PIN changes / tenant updates land here. |

### Catalog (M2)

| Table | RLS | Notes |
|---|---|---|
| `menu_categories` | yes | Doubles as the **revenue cost-center** for M9 profitability. |
| `menu_items` | yes | `price_cents`, optional `image_url`, free-form `modifiers jsonb`. |
| `service_tables` | yes | `status` enum: free / occupied / reserved / dirty. Auto-flipped by order events. |

### Orders + kitchen (M3 + M4)

| Table | RLS | Notes |
|---|---|---|
| `orders` | yes | One open tab per `service_table_id` (partial unique index). Money columns populated at close-time only. |
| `order_items` | yes | `kitchen_status` enum: pending / in_progress / ready / served. Captures `unit_price_cents` at add-time. Voiding stamps `voided_at`, `voided_by_user_id`, `void_approved_by_user_id`, `void_reason`. |
| `order_adjustments` | yes | M11. Discounts + service-charge overrides + tax overrides. `applied_by_user_id` + `approved_by_user_id`. |

### Money (M5)

| Table | RLS | Notes |
|---|---|---|
| `payments` | yes | Append-only. `method` enum (cash|esewa|khalti|card|other). FK `shift_id` (M10). Cash payments require an open shift; non-cash also tagged with shift_id when one exists. |

### Inventory (M6)

| Table | RLS | Notes |
|---|---|---|
| `inventory_items` | yes | `kind` retail|ingredient. Denormalized `qty_on_hand_units` kept in sync by trigger. |
| `pack_rules` | yes | "1 carton = 200 sticks" translations. Multiple per item. |
| `stock_movements` | yes | Append-only ledger (`delta_units` signed, `reason` enum, `ref_type+ref_id` link to order_item / expense / manual). **Trigger `apply_stock_movement`** auto-applies the delta to `inventory_items.qty_on_hand_units` and (on purchase) updates `last_purchase_unit_cost_cents`. |
| `menu_item_inventory_link` | yes | One row per menu item (PK on `menu_item_id`). `qty_consumed_per_sale` lets close-time decrement inventory. |

### Expenses + cost-center (M7)

| Table | RLS | Notes |
|---|---|---|
| `expense_categories` | yes | Operating buckets (Rent / Utilities / Supplies / …). **Separate from `menu_categories`**. |
| `expenses` | yes | Optional `linked_inventory_item_id` — when set, `POST /v1/expenses` atomically writes a `stock_movements` purchase row in the same tx (single source of truth for cost basis). |
| `expense_allocations` | yes | Splits an expense across `menu_categories` with `share_pct` + denormalized `amount_cents` for fast M9 roll-up. Unique on (`expense_id`, `menu_category_id`). |

### Cash drawer (M10)

| Table | RLS | Notes |
|---|---|---|
| `shifts` | yes | One open shift per tenant (partial unique index `WHERE closed_at IS NULL`). `variance_cents` signed: negative = short. |

## Triggers

- `set_updated_at()` — generic `BEFORE UPDATE` trigger applied to every table with `updated_at`.
- `apply_stock_movement()` — `AFTER INSERT ON stock_movements`; updates `inventory_items.qty_on_hand_units` and `last_purchase_unit_cost_cents` on purchase. Handlers never touch the denormalized counter directly.

## Indexes worth knowing

- `orders_one_open_per_table` — partial unique index forcing one open tab per service table.
- `shifts_one_open_per_tenant` — partial unique index on `(tenant_id) WHERE closed_at IS NULL`.
- `inventory_items_tenant_sku_uniq` — partial unique on (tenant, lower(sku)) where deleted_at IS NULL.
- `audit_events_tenant_at_idx` — supports the read-back of recent events on a tenant.

## Money math

All percentages stored as `numeric(5,2)` (e.g., `13.00`). Tax math runs in integer paisa using **hundredths-of-percent** to avoid float:

```
amount_cents × (pct × 100) / 10000   (rounded half-up)
```

Closing an order computes:

```
service_charge_cents = pct_of(subtotal, tenants.service_charge_pct)
tax_base             = subtotal − discount + service_charge
tax_cents            = pct_of(tax_base, tenants.vat_pct)
total                = subtotal − discount + service_charge + tax
```

## Diagram

```
                        tenants
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   tenant_members      users          orders ──── service_tables
        │                                │
        │                                ├── order_items ── menu_items ── menu_categories
        │                                ├── order_adjustments              │
        │                                └── payments                       │
        ▼                                                                   │
   sessions                              expenses ── expense_allocations ───┘
                                            │
                                            └── stock_movements ── inventory_items
                                                       │              │
                                                       │              └── pack_rules
                                                       │              └── menu_item_inventory_link → menu_items
                                                       └── shifts (via payments.shift_id)
```
