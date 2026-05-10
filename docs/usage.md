# cafe-mgmt — usage guide

Day-to-day walkthrough for running a cafe on this system. Pairs with [`README.md`](../README.md) (setup) and [`runbook.md`](runbook.md) (ops).

---

## 0. Start the stack locally (no Docker)

If you set up the project per the README, your `.env` already points at a local Postgres. To run:

```bash
# terminal 1 — API
set -a && . ./.env && set +a && cd apps/api && go run ./cmd/server

# terminal 2 — web
WEB_PORT=5891 pnpm --filter @cafe-mgmt/web dev
```

Open **http://localhost:5891**.

> The API binds `:8081`, the web dev server binds `:5891`, and the Vite proxy forwards `/v1/*` and `/ws` from the web host to the API. Don't open the API directly — go through the web URL.

---

## 1. Sign in

You'll land on a dev-login form. Type one of the seeded emails and any name:

| Email | Role | What you can do |
|---|---|---|
| `owner@sahan.test` | owner | everything (settings, branding, PINs, reports) |
| `manager@sahan.test` | manager | approve voids/discounts, all POS + reports |
| `waiter@sahan.test` | waiter | take orders, settle tabs (no voids without manager) |
| `kitchen@sahan.test` | kitchen | the KDS view only |
| `owner@brews.test` | owner of a 2nd cafe | proves multi-tenant isolation |

If you have memberships in multiple tenants, the **Workspace pick** screen appears next; otherwise you go straight to the dashboard.

> Real prod uses Google OIDC. Dev-login is enabled because `APP_ENV=dev` in your `.env`.

---

## 2. The admin shell

After login you see the dashboard. The left sidebar groups everything:

```
WORKSPACE     dashboard · floor · kitchen
CATALOG       menu · tables · inventory
OPERATIONS    shift · expenses · reports
SETTINGS      tenant settings (owner only)
```

The header chip in the top-left shows the current tenant + your role. The footer has **Approval PIN** (managers/owners only — sets your 4–8 digit PIN that waiters use to authorize voids and discounts).

---

## 3. First-time setup checklist (do these once per cafe)

1. **Settings → Tenant** *(owner)* — set timezone, VAT %, service-charge %.
2. **Settings → Branding** — upload a logo and pick brand colors. The whole UI recolors live (no reload).
3. **Menu → Categories** — create your menu sections (Coffee, Momo, Cold drinks, …). Sort matters; lowest sort first.
4. **Menu → Items** — add items under each category. Price is in NPR (the UI accepts decimals; storage is paisa).
5. **Tables** — define your floor. Each table has a name, capacity, and area (e.g., "Patio", "Inside").
6. **Inventory** *(if you'll track stock)*:
   - Create inventory items (kind = `retail` for things you sell as-is, like cigarettes; `ingredient` for things consumed by menu items).
   - For sticks-from-cartons style purchases, add a **Pack rule** (e.g., 1 carton = 200 sticks).
   - **Link** menu items to inventory: from a menu item, pick "consumes inventory item" → set qty per sale. Selling that item now decrements stock.
7. **Expenses → Categories** — create operating buckets (Rent, Utilities, Wages, Ingredients, …).
8. **Approval PIN** *(footer, owner/manager)* — set a PIN. Waiters will need it for voids/discounts.

---

## 4. The daily flow

### 4a. Open shift (cashier — first thing in the morning)

**Operations → Shift → Open shift.** Enter the cash drawer's **opening float** (the cash you start with, typically Rs 500–2 000 to make change).

While the shift is open:
- Cash payments are tagged with this shift's id.
- The header pill shows shift OPEN.
- Trying to take a cash payment with **no** open shift returns **409 shift_required** — the UI surfaces it as an inline error and points you to open one.

### 4b. Take an order

1. **Floor** — tap a free table tile → the system creates an open tab and flips the table to occupied.
2. The tab page opens with menu chips (categories) on the left and the running tab on the right.
3. Tap menu cards to add items. Use ± on a line to change qty while the items are still **pending** (= not yet sent to kitchen).
4. Press **Send to kitchen** — pending items become `in_progress` and broadcast to the KDS in real time. Once sent, items are locked: you can't change qty, only **void** them (which needs manager approval if you're a waiter).

### 4c. Kitchen (KDS view)

Open in another tab/device with `kitchen@sahan.test`. **Kitchen** in sidebar → two columns:

- **In progress** — newly sent items, oldest first. Tap a card to mark **Ready**.
- **Ready** — picks up from "in progress". Tap to mark **Served**.

Cards have an elapsed-time badge (helpful when the kitchen is in the weeds). Updates are pushed via WebSocket — no refresh needed.

### 4d. Voiding an item

Reasons happen: dropped, wrong order, customer changed mind. From the tab page, click ✕ on a line:

- If you're **owner/manager**: enter a reason → confirm. Done.
- If you're **waiter**: enter a reason **plus** the manager's email + PIN. The system bcrypt-checks against `tenant_members.pin_hash` and writes either `order.item.voided` (success) or `void.denied` (failure) to the audit trail.

### 4e. Discounts

Tab page footer → **Discount**. Pick % or flat amount, enter a reason, manager-approval if you're a waiter. Discounts are subtracted from the taxable subtotal *before* VAT — so the breakdown stays correct.

### 4f. Settle the tab

When all items are **served** and the customer wants to pay:

1. **Settle tab** button on the tab page (only enabled when there are no items pending in the kitchen).
2. The settle modal shows the live quote: subtotal − discount + service charge + VAT = total.
3. Pick a method: **Cash · eSewa · Khalti · Card · Other**.
4. eSewa/Khalti require a reference number (the QR transaction ID). Cash does not.
5. Auto-fill the outstanding balance with the chip → **Record payment**.
6. Repeat if split-paying. **Close** is only enabled when balance == 0.
7. On close: tab is finalized (irreversible), inventory decrements per `menu_item_inventory_link`, the table flips to **dirty** (waiter wipes & resets it from the floor view).

### 4g. Close shift (end of day)

**Operations → Shift → Count out.**

1. Count the physical cash in the drawer.
2. Enter that number. The page shows live `expected = opening_float + Σ cash payments` and computes **variance** (signed: negative = short).
3. Add notes if there's a discrepancy (e.g., "Rs 200 paid out for ice").
4. **Close shift**. The shift row becomes immutable. Variance is colored green (matched) / amber (over) / red (short) in the history list.

---

## 5. Managing the cafe (non-POS work)

### Expenses

**Operations → Expenses.**

- **Plain expense** (rent, wages): vendor + category + amount + date + payment method. Optionally tag for **profit reporting** by allocating shares across menu categories (e.g., "5 000 NPR flour, 100% to Momo"). The allocation rolls up into the M9 profitability report.
- **Inventory-linked expense** (restocks): pick the inventory item + units bought → in one transaction the system writes the expense **and** a `stock_movements` purchase row that bumps `qty_on_hand_units` and updates `last_purchase_unit_cost_cents`. No double-entry.

### Inventory adjustments

**Inventory → Adjust** on any item — manual stock movements with a required reason (`waste`, `adjust`, `transfer`). The recent-ledger panel shows the last 10 movements with their ref types.

### Reports

- **Dashboard** — KPIs (sales, orders, avg ticket, net), 14-day daily-sales bar chart, top sellers, recent expenses, low-stock alerts. Range chip: today / yesterday / 7d / 30d / mtd.
- **Reports → Sales** — by day / by item / by category, custom date range.
- **Reports → Profitability** — the "how much profit on momo this month" view. Per-category twin bars (revenue lime / COGS amber). Click a category to drill into the underlying expenses + items. `Unallocated COGS` = expenses not tagged to a menu category (informational, won't double-count).

---

## 6. Multi-tenant: onboarding a 2nd cafe

The seed already creates **brews** as a 2nd tenant for testing. To add a real one in production, see [`runbook.md`](runbook.md) → "Manual tenant onboarding".

While developing locally, you can simulate cross-tenant by signing in as `owner@brews.test` — you'll see only Brews' data, even though it's the same database. RLS does that for you.

> **Why subdomains in prod, X-Tenant-ID in dev?** Browsers refuse to share session cookies across `localhost` subdomains in a way that's interoperable with curl/PSL. Dev sends `X-Tenant-ID` explicitly via the API client; prod hits `sahan.app.com` and the resolver picks the tenant from the host. Both code paths are wired and tested.

---

## 7. Common things that look broken but aren't

| Symptom | Cause | Fix |
|---|---|---|
| Cash payment returns `409 shift_required` | No open shift for tenant | Operations → Shift → Open |
| **Send to kitchen** is greyed out | All items already sent | Add new items first |
| **Settle tab** is greyed out | Items still in `pending` (not sent to kitchen) | Send them, or void them |
| Stock didn't decrement after sale | Menu item has no `inventory link` | Menu → item → "consumes inventory" |
| Profitability shows `unallocated_cogs` | Expense has no allocation rows | Edit the expense → tag for profit reporting |
| Branding color picker change doesn't apply | You hit Save but didn't refresh the tenant settings query | Soft reload (⌘R) — should be live, file a bug if not |
| Two browser tabs go out of sync | One tab's WebSocket reconnect is paused | The hook auto-reconnects with 1 s → 30 s exponential backoff; refocus the tab |

---

## 8. Authentication shortcuts (curl-friendly)

Sometimes you want to hit the API directly to debug:

```bash
# 1. dev-login → get session cookie
curl -c cookies.txt -X POST http://localhost:8081/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@sahan.test","name":"Owner"}'

# 2. who am I, which tenants
curl -b cookies.txt http://localhost:8081/v1/me

# 3. select a tenant (server stamps the cookie)
curl -b cookies.txt -X POST http://localhost:8081/v1/sessions/select-tenant \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"<uuid-from-step-2>"}'

# 4. now hit tenant-scoped endpoints with the X-Tenant-ID header
curl -b cookies.txt -H 'X-Tenant-ID: sahan' http://localhost:8081/v1/menu/items
```

For full endpoint listing, grep `apps/api/internal/api/router.go`.

---

## 9. Where things live (quick map)

| Thing | Path |
|---|---|
| API entry | `apps/api/cmd/server/main.go` |
| Migrations | `apps/api/migrations/*.sql` |
| Realtime hub | `apps/api/internal/realtime/` |
| RLS helpers | `apps/api/internal/db/tx.go` |
| Web entry | `apps/web/src/main.tsx` |
| Routes | `apps/web/src/App.tsx` |
| API client | `apps/web/src/lib/api.ts` |
| Realtime hook | `apps/web/src/lib/useRealtime.ts` |
| Pages | `apps/web/src/pages/admin/*.tsx` |
| Styles | `apps/web/src/styles/{global,admin}.css` |
| Brand tokens | `packages/design-tokens/src/tokens.css` |

---

See also: [`schema.md`](schema.md) for the database, [`runbook.md`](runbook.md) for ops procedures.
