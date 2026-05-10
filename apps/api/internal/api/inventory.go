package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// types
// =========================================================================

type InventoryItem struct {
	ID                          uuid.UUID `json:"id"`
	Name                        string    `json:"name"`
	SKU                         *string   `json:"sku,omitempty"`
	Kind                        string    `json:"kind"`
	SaleUnit                    string    `json:"sale_unit"`
	QtyOnHandUnits              string    `json:"qty_on_hand_units"`
	ParLowUnits                 string    `json:"par_low_units"`
	LastPurchaseUnitCostCents   *int64    `json:"last_purchase_unit_cost_cents,omitempty"`
	Notes                       string    `json:"notes"`
	IsLowStock                  bool      `json:"is_low_stock"`
}

type PackRule struct {
	ID                   uuid.UUID `json:"id"`
	InventoryItemID      uuid.UUID `json:"inventory_item_id"`
	ContainerUnit        string    `json:"container_unit"`
	ContainerQty         int       `json:"container_qty"`
	SaleUnit             string    `json:"sale_unit"`
	SaleQtyPerContainer  int       `json:"sale_qty_per_container"`
	CreatedAt            time.Time `json:"created_at"`
}

type StockMovement struct {
	ID               uuid.UUID  `json:"id"`
	InventoryItemID  uuid.UUID  `json:"inventory_item_id"`
	DeltaUnits       string     `json:"delta_units"`
	Reason           string     `json:"reason"`
	RefType          *string    `json:"ref_type,omitempty"`
	RefID            *uuid.UUID `json:"ref_id,omitempty"`
	UnitCostCents    *int64     `json:"unit_cost_cents,omitempty"`
	Notes            string     `json:"notes"`
	ByUserID         *uuid.UUID `json:"by_user_id,omitempty"`
	At               time.Time  `json:"at"`
}

type MenuItemInventoryLink struct {
	MenuItemID         uuid.UUID `json:"menu_item_id"`
	InventoryItemID    uuid.UUID `json:"inventory_item_id"`
	QtyConsumedPerSale string    `json:"qty_consumed_per_sale"`
}

// =========================================================================
// LIST inventory items (with low-stock flag)
// =========================================================================

func ListInventoryItems(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, sku, kind::text, sale_unit,
		       qty_on_hand_units::text, par_low_units::text,
		       last_purchase_unit_cost_cents, notes,
		       (par_low_units > 0 AND qty_on_hand_units <= par_low_units) AS low
		FROM inventory_items
		WHERE deleted_at IS NULL
		ORDER BY lower(name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []InventoryItem{}
	for rows.Next() {
		var it InventoryItem
		if err := rows.Scan(&it.ID, &it.Name, &it.SKU, &it.Kind, &it.SaleUnit,
			&it.QtyOnHandUnits, &it.ParLowUnits, &it.LastPurchaseUnitCostCents,
			&it.Notes, &it.IsLowStock); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func CreateInventoryItem(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	var body struct {
		Name        string  `json:"name"`
		SKU         *string `json:"sku"`
		Kind        string  `json:"kind"`
		SaleUnit    string  `json:"sale_unit"`
		ParLowUnits string  `json:"par_low_units"`
		Notes       string  `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	if body.Kind != "retail" && body.Kind != "ingredient" {
		body.Kind = "retail"
	}
	if body.SaleUnit == "" {
		body.SaleUnit = "unit"
	}
	if body.ParLowUnits == "" {
		body.ParLowUnits = "0"
	}
	tx := appctx.Tx(r.Context())
	var it InventoryItem
	err := tx.QueryRow(r.Context(), `
		INSERT INTO inventory_items (tenant_id, name, sku, kind, sale_unit, par_low_units, notes)
		VALUES ($1, $2, $3, $4::inventory_item_kind, $5, $6::numeric, $7)
		RETURNING id, name, sku, kind::text, sale_unit,
		          qty_on_hand_units::text, par_low_units::text,
		          last_purchase_unit_cost_cents, notes,
		          (par_low_units > 0 AND qty_on_hand_units <= par_low_units)
	`, t.ID, body.Name, body.SKU, body.Kind, body.SaleUnit, body.ParLowUnits, body.Notes).Scan(
		&it.ID, &it.Name, &it.SKU, &it.Kind, &it.SaleUnit,
		&it.QtyOnHandUnits, &it.ParLowUnits, &it.LastPurchaseUnitCostCents, &it.Notes, &it.IsLowStock)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, it)
}

func UpdateInventoryItem(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		Name        *string `json:"name"`
		SKU         *string `json:"sku"`
		Kind        *string `json:"kind"`
		SaleUnit    *string `json:"sale_unit"`
		ParLowUnits *string `json:"par_low_units"`
		Notes       *string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())
	var it InventoryItem
	err = tx.QueryRow(r.Context(), `
		UPDATE inventory_items
		SET name          = COALESCE($2, name),
		    sku           = COALESCE($3, sku),
		    kind          = COALESCE($4::inventory_item_kind, kind),
		    sale_unit     = COALESCE($5, sale_unit),
		    par_low_units = COALESCE($6::numeric, par_low_units),
		    notes         = COALESCE($7, notes)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, sku, kind::text, sale_unit,
		          qty_on_hand_units::text, par_low_units::text,
		          last_purchase_unit_cost_cents, notes,
		          (par_low_units > 0 AND qty_on_hand_units <= par_low_units)
	`, id, body.Name, body.SKU, body.Kind, body.SaleUnit, body.ParLowUnits, body.Notes).Scan(
		&it.ID, &it.Name, &it.SKU, &it.Kind, &it.SaleUnit,
		&it.QtyOnHandUnits, &it.ParLowUnits, &it.LastPurchaseUnitCostCents, &it.Notes, &it.IsLowStock)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, it)
}

func DeleteInventoryItem(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	cmd, err := tx.Exec(r.Context(),
		`UPDATE inventory_items SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if cmd.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// MOVEMENTS / ADJUST
// =========================================================================

func ListInventoryMovements(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, inventory_item_id, delta_units::text, reason::text, ref_type, ref_id,
		       unit_cost_cents, notes, by_user_id, at
		FROM stock_movements
		WHERE inventory_item_id = $1
		ORDER BY at DESC
		LIMIT 200
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []StockMovement{}
	for rows.Next() {
		var m StockMovement
		if err := rows.Scan(&m.ID, &m.InventoryItemID, &m.DeltaUnits, &m.Reason,
			&m.RefType, &m.RefID, &m.UnitCostCents, &m.Notes, &m.ByUserID, &m.At); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, m)
	}
	writeJSON(w, http.StatusOK, map[string]any{"movements": out})
}

// AdjustInventory records a manual stock movement (purchase, waste, adjust).
// All fields are required for an audit trail.
func AdjustInventory(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	user, _ := appctx.UserFromContext(r.Context())
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		DeltaUnits    string  `json:"delta_units"`
		Reason        string  `json:"reason"`
		Notes         string  `json:"notes"`
		UnitCostCents *int64  `json:"unit_cost_cents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DeltaUnits == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "delta_units required")
		return
	}
	switch body.Reason {
	case "purchase", "waste", "adjust", "transfer":
	default:
		writeErr(w, http.StatusBadRequest, "bad_reason",
			"reason must be one of purchase|waste|adjust|transfer")
		return
	}
	if body.Reason != "purchase" && body.UnitCostCents != nil {
		body.UnitCostCents = nil // cost only stored on purchases
	}
	if body.Notes == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "notes required for audit trail")
		return
	}

	tx := appctx.Tx(r.Context())
	var m StockMovement
	err = tx.QueryRow(r.Context(), `
		INSERT INTO stock_movements (tenant_id, inventory_item_id, delta_units, reason, ref_type, unit_cost_cents, notes, by_user_id)
		VALUES ($1, $2, $3::numeric, $4::stock_movement_reason, 'manual', $5, $6, $7)
		RETURNING id, inventory_item_id, delta_units::text, reason::text, ref_type, ref_id,
		          unit_cost_cents, notes, by_user_id, at
	`, t.ID, id, body.DeltaUnits, body.Reason, body.UnitCostCents, body.Notes, user.ID).Scan(
		&m.ID, &m.InventoryItemID, &m.DeltaUnits, &m.Reason, &m.RefType, &m.RefID,
		&m.UnitCostCents, &m.Notes, &m.ByUserID, &m.At)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

// =========================================================================
// PACK RULES
// =========================================================================

func ListPackRules(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, inventory_item_id, container_unit, container_qty, sale_unit, sale_qty_per_container, created_at
		FROM pack_rules WHERE inventory_item_id = $1 ORDER BY container_qty
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []PackRule{}
	for rows.Next() {
		var p PackRule
		if err := rows.Scan(&p.ID, &p.InventoryItemID, &p.ContainerUnit, &p.ContainerQty,
			&p.SaleUnit, &p.SaleQtyPerContainer, &p.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"pack_rules": out})
}

func CreatePackRule(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	t, _ := appctx.TenantFromContext(r.Context())
	var body struct {
		ContainerUnit        string `json:"container_unit"`
		ContainerQty         int    `json:"container_qty"`
		SaleUnit             string `json:"sale_unit"`
		SaleQtyPerContainer  int    `json:"sale_qty_per_container"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
		body.ContainerUnit == "" || body.SaleUnit == "" || body.SaleQtyPerContainer <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"container_unit, sale_unit, and sale_qty_per_container > 0 required")
		return
	}
	if body.ContainerQty <= 0 {
		body.ContainerQty = 1
	}
	tx := appctx.Tx(r.Context())
	var p PackRule
	err = tx.QueryRow(r.Context(), `
		INSERT INTO pack_rules (tenant_id, inventory_item_id, container_unit, container_qty, sale_unit, sale_qty_per_container)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, inventory_item_id, container_unit, container_qty, sale_unit, sale_qty_per_container, created_at
	`, t.ID, id, body.ContainerUnit, body.ContainerQty, body.SaleUnit, body.SaleQtyPerContainer).Scan(
		&p.ID, &p.InventoryItemID, &p.ContainerUnit, &p.ContainerQty,
		&p.SaleUnit, &p.SaleQtyPerContainer, &p.CreatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func DeletePackRule(w http.ResponseWriter, r *http.Request) {
	prID, err := uuid.Parse(chi.URLParam(r, "ruleId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	cmd, err := tx.Exec(r.Context(), `DELETE FROM pack_rules WHERE id = $1`, prID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if cmd.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// MENU ITEM ↔ INVENTORY LINK
// =========================================================================

func GetMenuItemLink(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	var l MenuItemInventoryLink
	err = tx.QueryRow(r.Context(), `
		SELECT menu_item_id, inventory_item_id, qty_consumed_per_sale::text
		FROM menu_item_inventory_link WHERE menu_item_id = $1
	`, id).Scan(&l.MenuItemID, &l.InventoryItemID, &l.QtyConsumedPerSale)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, l)
}

// PutMenuItemLink upserts the link. Body inventory_item_id == null deletes.
func PutMenuItemLink(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	t, _ := appctx.TenantFromContext(r.Context())
	var body struct {
		InventoryItemID    *uuid.UUID `json:"inventory_item_id"`
		QtyConsumedPerSale string     `json:"qty_consumed_per_sale"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())

	if body.InventoryItemID == nil {
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM menu_item_inventory_link WHERE menu_item_id = $1`, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if body.QtyConsumedPerSale == "" {
		body.QtyConsumedPerSale = "1"
	}

	var l MenuItemInventoryLink
	err = tx.QueryRow(r.Context(), `
		INSERT INTO menu_item_inventory_link (menu_item_id, tenant_id, inventory_item_id, qty_consumed_per_sale)
		VALUES ($1, $2, $3, $4::numeric)
		ON CONFLICT (menu_item_id) DO UPDATE
		  SET inventory_item_id = EXCLUDED.inventory_item_id,
		      qty_consumed_per_sale = EXCLUDED.qty_consumed_per_sale
		RETURNING menu_item_id, inventory_item_id, qty_consumed_per_sale::text
	`, id, t.ID, *body.InventoryItemID, body.QtyConsumedPerSale).Scan(
		&l.MenuItemID, &l.InventoryItemID, &l.QtyConsumedPerSale)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, l)
}

// =========================================================================
// helpers used elsewhere
// =========================================================================

// DecrementInventoryForOrder is called from CloseOrder. For every
// non-voided line in the order, if the menu item is linked to inventory,
// it inserts a 'sale' stock_movement for delta = -qty * qty_consumed_per_sale.
//
// The trigger keeps inventory_items.qty_on_hand_units in sync.
func DecrementInventoryForOrder(ctx context.Context, orderID, tenantID, byUserID uuid.UUID) error {
	tx := appctx.Tx(ctx)
	rows, err := tx.Query(ctx, `
		SELECT oi.id, oi.qty, l.inventory_item_id, l.qty_consumed_per_sale
		FROM order_items oi
		JOIN menu_item_inventory_link l ON l.menu_item_id = oi.menu_item_id
		WHERE oi.order_id = $1 AND oi.voided_at IS NULL
	`, orderID)
	if err != nil {
		return err
	}
	type row struct {
		orderItemID uuid.UUID
		qty         int
		invID       uuid.UUID
		perSale     string
	}
	var pending []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.orderItemID, &r.qty, &r.invID, &r.perSale); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, r)
	}
	rows.Close()

	for _, r := range pending {
		// delta = -(qty * qty_consumed_per_sale). Computed in Postgres
		// to avoid float rounding on the Go side.
		if _, err := tx.Exec(ctx, `
			INSERT INTO stock_movements
			  (tenant_id, inventory_item_id, delta_units, reason, ref_type, ref_id, by_user_id, notes)
			VALUES
			  ($1, $2, -($3::int * $4::numeric), 'sale', 'order_item', $5, $6, '')
		`, tenantID, r.invID, r.qty, r.perSale, r.orderItemID, byUserID); err != nil {
			return err
		}
	}
	return nil
}
