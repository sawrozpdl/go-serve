# Inventory link & COGS — how the pieces fit

This doc maps the relationship between the **inventory** subsystem (which tracks
physical stock) and the **profitability** subsystem (which reports on margins).
They share data but are deliberately decoupled.

## The two subsystems

```
┌──────────────────────────┐       ┌────────────────────────────┐
│ inventory_items          │       │ menu_categories            │
│   ├─ qty_on_hand_units   │       │   └─ menu_items            │
│   ├─ par_low_units       │       │        └─ price_cents      │
│   └─ last_purchase_unit_ │       └────────────────────────────┘
│      cost_cents          │                       │
└──────────────────────────┘                       │
   ▲                                               │ revenue =
   │                                               │ Σ(qty × unit_price)
   │ stock_movements                               ▼
   │ (delta_units, reason)                ┌────────────────────┐
   │                                      │ profitability      │
   │  reasons:                            │ report             │
   │   purchase  (+)                      │  rev − cogs        │
   │   sale      (−) auto on close        │  =  margin %       │
   │   waste     (−)                      └────────────────────┘
   │   adjust    (±)                               ▲
   │   transfer                                    │ cogs =
   │                                               │ Σ allocations
   │                                               │
┌──┴────────────────────┐    ┌───────────────────┐ │
│ menu_item_inventory_  │    │ expenses          │ │
│ link                  │    │   └─ allocations  │─┘
│   qty_consumed_per_   │    │        share_pct  │
│   sale                │    │        amount     │
└───────────────────────┘    └───────────────────┘
```

## What the inventory link does

`menu_item_inventory_link` stores `(menu_item, inventory_item, qty_consumed_per_sale)`.

When an order closes, `DecrementInventoryForOrder` walks every non-voided line and,
for any line whose menu item is linked, inserts a `sale` row into `stock_movements`
with `delta = -(qty × qty_consumed_per_sale)`.

The DB trigger `apply_stock_movement` keeps `inventory_items.qty_on_hand_units` in
sync, so the inventory page always reflects current stock.

**Examples**

| menu item   | linked inventory      | qty per sale | one sale of qty=3 → ledger row     |
| ----------- | --------------------- | ------------ | ---------------------------------- |
| Cigarette   | Marlboro Red (sticks) | 1            | `−3 stick`                         |
| Vegetable Momo | All-purpose flour (g) | 50         | `−150 g`                           |
| Espresso    | Espresso beans (g)    | 18           | `−54 g`                            |

## What the inventory link does NOT do

It does **not** automatically populate COGS in the profitability report.
Profitability COGS is calculated only from `expense_allocations` rows.

This decoupling is intentional:

- **Stock tracking** answers "how many do I have?" — it needs every sale to flow through.
- **Cost accounting** answers "how much did this cost me?" — that depends on what you
  actually paid suppliers, not the raw quantity moved. Last-purchase price drifts;
  invoices get re-categorised; some expenses cover multiple SKUs.

So COGS is recorded explicitly via the **Expenses** page.

## How to make profitability report real numbers

Two paths, depending on the kind of cost:

### Path A — direct purchase (e.g. flour, momo wrappers)

1. Go to **Expenses → New expense**.
2. Fill in vendor, amount, paid_at, notes.
3. (Optional) **Inventory link** section: pick the item + units bought. This atomically
   creates a `purchase` movement so stock and cost are recorded together. The unit
   cost is computed as `amount / units` and stored on the inventory item as
   `last_purchase_unit_cost_cents`.
4. **Tag for profit reporting**: pick the menu category this cost belongs to and the
   share %. For flour that goes 100% into momos: pick **Momo**, share 100%. For a
   shared utility bill: split across categories (e.g. 60% Coffee, 40% Food).
5. The expense now reduces gross profit for those categories in the profitability
   report for the period containing `paid_at`.

### Path B — overhead (e.g. rent, salaries)

These don't map cleanly to a single menu category. Two options:

- **Allocate proportionally** across all menu categories that the workforce / space
  serves (e.g. rent split equally, or by revenue share).
- **Leave unallocated** — these show up as `unallocated_cogs_cents` in the
  profitability report and don't reduce per-category margin. The dashboard's *Net*
  KPI still nets them off topline revenue.

## Symptoms and what they mean

| You see…                                                | Likely cause                                     | Fix                                                     |
| ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Margin **100%** on a category that has revenue          | No expense allocations to that category          | Log an expense, allocate to the category                |
| Margin shows `—`                                        | No sales in this period                          | Nothing to fix                                          |
| `unallocated_cogs_cents > 0`                            | Expenses logged but no allocations               | Open the expense and add allocations                    |
| Negative gross profit                                   | Allocated cost > revenue (e.g. one-off bulk buy) | Smooth allocations across the period the cost serves    |
| Stock not decrementing                                  | Menu item has no inventory link                  | Edit the menu item → Inventory link section            |
| `last_purchase_unit_cost_cents` is stale                | No recent purchase recorded with units            | Log purchase via Expenses → Inventory link             |

## SKU vs. inventory link

These are unrelated:

- **SKU** is a free-text identifier for human reference (e.g. `CIG-MAR-RED`,
  `MOMO-VEG`). Useful on receipts, in supplier orders, when scanning a barcode at
  a future date. Currently optional with no uniqueness constraint.
- **Inventory link** is the actual `menu_item → inventory_item` relationship that
  drives stock decrements at sale.

A menu item can have one (e.g. a code for the kitchen), the other (auto-deduct
ingredient on sale), both, or neither.

## Future work (intentionally not in v1)

- **Auto-COGS from inventory** — multiply `qty_consumed_per_sale` ×
  `last_purchase_unit_cost_cents` × `qty` per closed order to derive an "implied
  COGS" alongside the allocation-based one. Would catch missed allocations
  automatically. Trade-off: drifts as supplier prices change between purchase and
  sale.
- **FIFO / weighted-average costing** — instead of "last purchase price", track
  stock layers and consume them in order. Required for businesses where inventory
  cost varies materially within a reporting period.
- **Recipes (multi-ingredient items)** — current link is 1:1. A recipe table
  would let one menu item consume from multiple inventory items.
