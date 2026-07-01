// Inventory items, stock movements, and menu-item links.
export type InventoryKind = 'retail' | 'ingredient';

export type StockReason = 'purchase' | 'sale' | 'waste' | 'adjust' | 'transfer';

export type InventoryItem = {
  id: string;
  name: string;
  sku?: string | null;
  kind: InventoryKind;
  sale_unit: string;
  qty_on_hand_units: string;
  par_low_units: string;
  last_purchase_unit_cost_cents?: number | null;
  notes: string;
  is_low_stock: boolean;
};

export type PackRule = {
  id: string;
  inventory_item_id: string;
  container_unit: string;
  container_qty: number;
  sale_unit: string;
  sale_qty_per_container: number;
  created_at: string;
};

export type StockMovement = {
  id: string;
  inventory_item_id: string;
  delta_units: string;
  reason: StockReason;
  ref_type?: string | null;
  ref_id?: string | null;
  unit_cost_cents?: number | null;
  notes: string;
  by_user_id?: string | null;
  by_user_name?: string | null;
  at: string;
};

export type MenuItemInventoryLink = {
  menu_item_id: string;
  inventory_item_id: string;
  qty_consumed_per_sale: string;
};
