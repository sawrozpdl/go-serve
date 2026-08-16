package api

// Add-ons ("modifiers"), the reusable-group model — see migration 0062.
//
// A modifier group is a named set of choices ("Sandwich extras") holding
// modifiers ("Extra cheese" +50). A group attaches to any number of menu items
// AND/OR whole categories, so it is defined once and reused.
//
// The effective groups for an item are the UNION of its own attachments and its
// category's. That is the difference from kitchen_behavior (0040) and outlet
// (0045), which resolve item → category → tenant to a single winner: groups
// COMPOSE. resolveModifierGroups in packages/api-types/src/menu.ts mirrors this
// on the client.
//
// Add-ons deliberately do NOT live in menu_items. Putting them there is what
// made "Add-on cheese" show up as a peer line on the ticket, as its own KDS
// card, and as a standalone orderable row on the public QR menu.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// =========================================================================
// DTOs
// =========================================================================

// Modifier is one choice inside a group.
type Modifier struct {
	ID      uuid.UUID `json:"id"`
	GroupID uuid.UUID `json:"group_id"`
	Name    string    `json:"name"`
	// Zero is legal (a free choice like "No sugar"), unlike menu items.
	PriceCents int64 `json:"price_cents"`
	// nil = cost not set; contributes 0 to COGS, matching menu_items.cost_cents.
	CostCents *int64 `json:"cost_cents,omitempty"`
	Sort      int    `json:"sort"`
	IsActive  bool   `json:"is_active"`
}

// ModifierGroup is a reusable set of add-on choices plus its selection bounds.
type ModifierGroup struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
	// MinSelect >= 1 makes the group required — the POS must not let a line be
	// added without a choice. MaxSelect nil = unlimited.
	MinSelect int        `json:"min_select"`
	MaxSelect *int       `json:"max_select,omitempty"`
	Sort      int        `json:"sort"`
	IsActive  bool       `json:"is_active"`
	Modifiers []Modifier `json:"modifiers"`
	// How many menu items / categories this group is attached to, so the admin
	// UI can warn before a delete and show reuse at a glance.
	ItemCount     int `json:"item_count"`
	CategoryCount int `json:"category_count"`
}

// OrderItemAddOn is one chosen add-on on an order line. Name/price/cost are
// snapshots taken when the line was added, so renaming or repricing a modifier
// never rewrites an old receipt.
type OrderItemAddOn struct {
	ID         uuid.UUID `json:"id"`
	ModifierID uuid.UUID `json:"modifier_id"`
	GroupName  string    `json:"group_name"`
	Name       string    `json:"name"`
	PriceCents int64     `json:"price_cents"`
	CostCents  int64     `json:"cost_cents"`
	// Count of this add-on on ONE unit of the parent (double cheese = 2). The
	// parent's qty multiplies through the folded unit price.
	Qty float64 `json:"qty"`
}

// =========================================================================
// Group CRUD
// =========================================================================

// ListModifierGroups returns every group with its modifiers nested, plus the
// attachment counts. One query per level rather than a join, so a group with no
// modifiers still comes back (and the nesting stays trivial to assemble).
func ListModifierGroups(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	appctx.Logger(ctx).DebugContext(ctx, "menu.list_modifier_groups")
	tx := appctx.Tx(ctx)

	rows, err := tx.Query(ctx, `
		SELECT g.id, g.name, g.min_select, g.max_select, g.sort, g.is_active,
		       (SELECT COUNT(*)::int FROM menu_item_modifier_groups l WHERE l.group_id = g.id),
		       (SELECT COUNT(*)::int FROM menu_category_modifier_groups l WHERE l.group_id = g.id)
		FROM menu_modifier_groups g
		WHERE g.deleted_at IS NULL
		ORDER BY g.sort, lower(g.name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	groups := []ModifierGroup{}
	byID := map[uuid.UUID]int{}
	for rows.Next() {
		var g ModifierGroup
		if err := rows.Scan(&g.ID, &g.Name, &g.MinSelect, &g.MaxSelect, &g.Sort, &g.IsActive,
			&g.ItemCount, &g.CategoryCount); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		g.Modifiers = []Modifier{}
		byID[g.ID] = len(groups)
		groups = append(groups, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	modRows, err := tx.Query(ctx, `
		SELECT id, group_id, name, price_cents, cost_cents, sort, is_active
		FROM menu_modifiers
		WHERE deleted_at IS NULL
		ORDER BY sort, lower(name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer modRows.Close()
	for modRows.Next() {
		var m Modifier
		if err := modRows.Scan(&m.ID, &m.GroupID, &m.Name, &m.PriceCents, &m.CostCents,
			&m.Sort, &m.IsActive); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if i, ok := byID[m.GroupID]; ok {
			groups[i].Modifiers = append(groups[i].Modifiers, m)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

// validSelectBounds rejects bounds that describe an unsatisfiable group. The DB
// has the same CHECK; this exists to return a 400 with a usable message instead
// of a 500 from a constraint violation.
func validSelectBounds(minSelect int, maxSelect *int) error {
	if minSelect < 0 {
		return errors.New("min_select cannot be negative")
	}
	if maxSelect == nil {
		return nil
	}
	if *maxSelect < 1 {
		return errors.New("max_select must be at least 1 when set")
	}
	if *maxSelect < minSelect {
		return errors.New("max_select cannot be less than min_select")
	}
	return nil
}

func CreateModifierGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	t, ok := appctx.TenantFromContext(ctx)
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	var body struct {
		Name      string `json:"name"`
		MinSelect int    `json:"min_select"`
		MaxSelect *int   `json:"max_select"`
		Sort      int    `json:"sort"`
		IsActive  *bool  `json:"is_active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	if err := validSelectBounds(body.MinSelect, body.MaxSelect); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	isActive := true
	if body.IsActive != nil {
		isActive = *body.IsActive
	}

	tx := appctx.Tx(ctx)
	var g ModifierGroup
	err := tx.QueryRow(ctx, `
		INSERT INTO menu_modifier_groups (tenant_id, name, min_select, max_select, sort, is_active)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, name, min_select, max_select, sort, is_active
	`, t.ID, body.Name, body.MinSelect, body.MaxSelect, body.Sort, isActive).
		Scan(&g.ID, &g.Name, &g.MinSelect, &g.MaxSelect, &g.Sort, &g.IsActive)
	if err != nil {
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "duplicate_name", "an add-on group with that name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	g.Modifiers = []Modifier{}

	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "create", Entity: "modifier_group", EntityID: &g.ID,
		Summary: "created add-on group " + g.Name,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

func UpdateModifierGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid group id")
		return
	}
	var body struct {
		Name      *string `json:"name"`
		MinSelect *int    `json:"min_select"`
		MaxSelect *int    `json:"max_select"`
		Sort      *int    `json:"sort"`
		IsActive  *bool   `json:"is_active"`
	}
	// max_select is nullable-meaningful (null = unlimited), so an omitted key and
	// an explicit null must be told apart.
	present, err := decodeWithPresence(r, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	tx := appctx.Tx(ctx)
	// Bounds are validated against the POST-update pair, not just what was sent:
	// raising min_select alone can invalidate an existing max_select.
	var curMin int
	var curMax *int
	if err := tx.QueryRow(ctx, `
		SELECT min_select, max_select FROM menu_modifier_groups
		WHERE id = $1 AND deleted_at IS NULL
	`, id).Scan(&curMin, &curMax); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "add-on group not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	nextMin, nextMax := curMin, curMax
	if body.MinSelect != nil {
		nextMin = *body.MinSelect
	}
	if _, sent := present["max_select"]; sent {
		nextMax = body.MaxSelect
	}
	if err := validSelectBounds(nextMin, nextMax); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	var g ModifierGroup
	_, maxSent := present["max_select"]
	err = tx.QueryRow(ctx, `
		UPDATE menu_modifier_groups SET
		  name       = COALESCE($2, name),
		  min_select = COALESCE($3, min_select),
		  max_select = CASE WHEN $4::boolean THEN $5::int ELSE max_select END,
		  sort       = COALESCE($6, sort),
		  is_active  = COALESCE($7, is_active)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, min_select, max_select, sort, is_active
	`, id, body.Name, body.MinSelect, maxSent, body.MaxSelect, body.Sort, body.IsActive).
		Scan(&g.ID, &g.Name, &g.MinSelect, &g.MaxSelect, &g.Sort, &g.IsActive)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "add-on group not found")
			return
		}
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "duplicate_name", "an add-on group with that name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	g.Modifiers = []Modifier{}

	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "update", Entity: "modifier_group", EntityID: &g.ID,
		Summary: "updated add-on group " + g.Name,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// DeleteModifierGroup soft-deletes a group. Refused while the group is still
// attached to any item or category: silently stripping add-ons off a live menu
// is worse than making the operator detach them first. Mirrors the
// category-delete guard in DeleteMenuCategory.
func DeleteModifierGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid group id")
		return
	}
	tx := appctx.Tx(ctx)

	var items, cats int
	if err := tx.QueryRow(ctx, `
		SELECT (SELECT COUNT(*)::int FROM menu_item_modifier_groups WHERE group_id = $1),
		       (SELECT COUNT(*)::int FROM menu_category_modifier_groups WHERE group_id = $1)
	`, id).Scan(&items, &cats); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if items > 0 || cats > 0 {
		writeErr(w, http.StatusConflict, "group_in_use",
			fmt.Sprintf("still attached to %d item(s) and %d category(ies) — detach it first", items, cats))
		return
	}

	var name string
	if err := tx.QueryRow(ctx, `
		UPDATE menu_modifier_groups SET deleted_at = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING name
	`, id).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "add-on group not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	// Soft-delete the children too, so they stop appearing in pickers. The rows
	// stay for order_item_modifiers' RESTRICT reference (sold history).
	if _, err := tx.Exec(ctx, `
		UPDATE menu_modifiers SET deleted_at = now()
		WHERE group_id = $1 AND deleted_at IS NULL
	`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "delete", Entity: "modifier_group", EntityID: &id,
		Summary: "deleted add-on group " + name,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// =========================================================================
// Modifier CRUD (nested under a group)
// =========================================================================

func CreateModifier(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	t, ok := appctx.TenantFromContext(ctx)
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	groupID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid group id")
		return
	}
	var body struct {
		Name       string `json:"name"`
		PriceCents int64  `json:"price_cents"`
		CostCents  *int64 `json:"cost_cents"`
		Sort       int    `json:"sort"`
		IsActive   *bool  `json:"is_active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	// Note: zero is allowed (a free choice), unlike CreateMenuItem. Negative is
	// not — an add-on that pays the customer is a discount, which has its own
	// flow.
	if body.PriceCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "price cannot be negative")
		return
	}
	if body.CostCents != nil && *body.CostCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "cost cannot be negative")
		return
	}
	isActive := true
	if body.IsActive != nil {
		isActive = *body.IsActive
	}

	tx := appctx.Tx(ctx)
	// The group must exist and be live; without this the FK error surfaces as a
	// 500 instead of a 404.
	var groupName string
	if err := tx.QueryRow(ctx, `
		SELECT name FROM menu_modifier_groups WHERE id = $1 AND deleted_at IS NULL
	`, groupID).Scan(&groupName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "add-on group not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	var m Modifier
	err = tx.QueryRow(ctx, `
		INSERT INTO menu_modifiers (tenant_id, group_id, name, price_cents, cost_cents, sort, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, group_id, name, price_cents, cost_cents, sort, is_active
	`, t.ID, groupID, body.Name, body.PriceCents, body.CostCents, body.Sort, isActive).
		Scan(&m.ID, &m.GroupID, &m.Name, &m.PriceCents, &m.CostCents, &m.Sort, &m.IsActive)
	if err != nil {
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "duplicate_name", "that add-on already exists in this group")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "create", Entity: "modifier", EntityID: &m.ID,
		Summary: fmt.Sprintf("added add-on %s to %s", m.Name, groupName),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func UpdateModifier(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	modID, err := uuid.Parse(chi.URLParam(r, "modifierId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid add-on id")
		return
	}
	var body struct {
		Name       *string `json:"name"`
		PriceCents *int64  `json:"price_cents"`
		CostCents  *int64  `json:"cost_cents"`
		Sort       *int    `json:"sort"`
		IsActive   *bool   `json:"is_active"`
	}
	// cost_cents is nullable-meaningful (null = unknown cost).
	present, err := decodeWithPresence(r, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.PriceCents != nil && *body.PriceCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "price cannot be negative")
		return
	}
	if body.CostCents != nil && *body.CostCents < 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "cost cannot be negative")
		return
	}
	_, costSent := present["cost_cents"]

	tx := appctx.Tx(ctx)
	var m Modifier
	err = tx.QueryRow(ctx, `
		UPDATE menu_modifiers SET
		  name        = COALESCE($2, name),
		  price_cents = COALESCE($3, price_cents),
		  cost_cents  = CASE WHEN $4::boolean THEN $5::bigint ELSE cost_cents END,
		  sort        = COALESCE($6, sort),
		  is_active   = COALESCE($7, is_active)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, group_id, name, price_cents, cost_cents, sort, is_active
	`, modID, body.Name, body.PriceCents, costSent, body.CostCents, body.Sort, body.IsActive).
		Scan(&m.ID, &m.GroupID, &m.Name, &m.PriceCents, &m.CostCents, &m.Sort, &m.IsActive)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "add-on not found")
			return
		}
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "duplicate_name", "that add-on already exists in this group")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Repricing does NOT rewrite history: order_item_modifiers snapshots the
	// price it was sold at.
	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "update", Entity: "modifier", EntityID: &m.ID,
		Summary: "updated add-on " + m.Name,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func DeleteModifier(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	modID, err := uuid.Parse(chi.URLParam(r, "modifierId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid add-on id")
		return
	}
	tx := appctx.Tx(ctx)
	// Soft delete: order_item_modifiers RESTRICT-references this row, so a sold
	// add-on can never be hard-deleted.
	var name string
	if err := tx.QueryRow(ctx, `
		UPDATE menu_modifiers SET deleted_at = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING name
	`, modID).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "add-on not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "delete", Entity: "modifier", EntityID: &modID,
		Summary: "deleted add-on " + name,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// =========================================================================
// Attaching groups to items / categories
// =========================================================================

// putAttachments replaces the full set of groups attached to one item or
// category. A whole-set PUT (rather than add/remove endpoints) matches how the
// admin form works — a multi-select whose value is submitted entire — and makes
// the operation idempotent, which the offline queue relies on.
func putAttachments(w http.ResponseWriter, r *http.Request, kind string) {
	ctx := r.Context()
	t, ok := appctx.TenantFromContext(ctx)
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	ownerID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		GroupIDs []uuid.UUID `json:"group_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	var table, ownerCol, ownerTable string
	switch kind {
	case "item":
		table, ownerCol, ownerTable = "menu_item_modifier_groups", "menu_item_id", "menu_items"
	case "category":
		table, ownerCol, ownerTable = "menu_category_modifier_groups", "category_id", "menu_categories"
	default:
		writeErr(w, http.StatusInternalServerError, "internal_error", "unknown attachment kind")
		return
	}

	tx := appctx.Tx(ctx)
	// The owner must exist and be live, so a stale id 404s instead of 500ing on
	// the FK.
	var exists bool
	if err := tx.QueryRow(ctx,
		fmt.Sprintf(`SELECT true FROM %s WHERE id = $1 AND deleted_at IS NULL`, ownerTable),
		ownerID).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", kind+" not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Validate every group up front. TxMiddleware COMMITS on a 4xx, so a partial
	// write followed by an error response would persist — the same trap
	// documented in menu_import.go.
	for _, gid := range body.GroupIDs {
		var live bool
		if err := tx.QueryRow(ctx, `
			SELECT true FROM menu_modifier_groups WHERE id = $1 AND deleted_at IS NULL
		`, gid).Scan(&live); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusBadRequest, "group_not_found",
					"add-on group "+gid.String()+" not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	if _, err := tx.Exec(ctx,
		fmt.Sprintf(`DELETE FROM %s WHERE %s = $1`, table, ownerCol), ownerID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	for i, gid := range body.GroupIDs {
		if _, err := tx.Exec(ctx, fmt.Sprintf(`
			INSERT INTO %s (tenant_id, %s, group_id, sort)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT DO NOTHING
		`, table, ownerCol), t.ID, ownerID, gid, i); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	entity := "menu_item"
	if kind == "category" {
		entity = "menu_category"
	}
	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "update", Entity: entity, EntityID: &ownerID,
		Summary: fmt.Sprintf("set %d add-on group(s)", len(body.GroupIDs)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"group_ids": body.GroupIDs})
}

// PutMenuItemModifierGroups — PUT /v1/menu/items/{id}/modifier-groups
func PutMenuItemModifierGroups(w http.ResponseWriter, r *http.Request) {
	putAttachments(w, r, "item")
}

// PutMenuCategoryModifierGroups — PUT /v1/menu/categories/{id}/modifier-groups
func PutMenuCategoryModifierGroups(w http.ResponseWriter, r *http.Request) {
	putAttachments(w, r, "category")
}

// =========================================================================
// Add-on stock links
// =========================================================================

// PutModifierInventoryLink replaces a modifier's inventory links. Mirrors the
// menu-item equivalent so extra cheese draws down cheese stock on sale.
func PutModifierInventoryLink(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	t, ok := appctx.TenantFromContext(ctx)
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	modID, err := uuid.Parse(chi.URLParam(r, "modifierId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid add-on id")
		return
	}
	// qty arrives as a STRING and goes through numericInput, exactly as
	// PutMenuItemLinks does: a float round-trip would corrupt quantities like
	// 0.05, and numericInput also normalises unicode minus signs from phone
	// keyboards.
	var body struct {
		Links []struct {
			InventoryItemID    uuid.UUID `json:"inventory_item_id"`
			QtyConsumedPerSale string    `json:"qty_consumed_per_sale"`
		} `json:"links"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	tx := appctx.Tx(ctx)
	var live bool
	if err := tx.QueryRow(ctx, `
		SELECT true FROM menu_modifiers WHERE id = $1 AND deleted_at IS NULL
	`, modID).Scan(&live); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "add-on not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Normalise + validate the whole set BEFORE the first write. TxMiddleware
	// commits on a 4xx, so a partial write followed by an error response would
	// persist (see the comment in menu_import.go).
	type link struct {
		inv uuid.UUID
		qty string
	}
	clean := []link{}
	seen := map[uuid.UUID]bool{}
	for _, l := range body.Links {
		if l.InventoryItemID == uuid.Nil || seen[l.InventoryItemID] {
			continue // skip blanks and duplicates, as PutMenuItemLinks does
		}
		seen[l.InventoryItemID] = true
		raw := l.QtyConsumedPerSale
		if raw == "" {
			raw = "1"
		}
		qty, ok := numericInput(raw)
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_number",
				"qty_consumed_per_sale must be a plain number like 1 or 0.25 (got "+
					l.QtyConsumedPerSale+")")
			return
		}
		var exists bool
		if err := tx.QueryRow(ctx, `
			SELECT true FROM inventory_items WHERE id = $1 AND deleted_at IS NULL
		`, l.InventoryItemID).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusBadRequest, "inventory_item_not_found",
					"inventory item "+l.InventoryItemID.String()+" not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		clean = append(clean, link{inv: l.InventoryItemID, qty: qty})
	}

	if _, err := tx.Exec(ctx, `DELETE FROM modifier_inventory_link WHERE modifier_id = $1`, modID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	for _, l := range clean {
		if _, err := tx.Exec(ctx, `
			INSERT INTO modifier_inventory_link (tenant_id, modifier_id, inventory_item_id, qty_consumed_per_sale)
			VALUES ($1, $2, $3, $4::numeric)
		`, t.ID, modID, l.inv, l.qty); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "update", Entity: "modifier", EntityID: &modID,
		Summary: fmt.Sprintf("set %d inventory link(s) on add-on", len(clean)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GetModifierInventoryLink — GET /v1/menu/modifiers/{modifierId}/inventory-link
func GetModifierInventoryLink(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	modID, err := uuid.Parse(chi.URLParam(r, "modifierId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid add-on id")
		return
	}
	// ::text on the numeric for the same reason PutMenuItemLinks returns a
	// string — the exact decimal must survive the round trip.
	rows, err := appctx.Tx(ctx).Query(ctx, `
		SELECT l.modifier_id, l.inventory_item_id, l.qty_consumed_per_sale::text
		FROM modifier_inventory_link l
		WHERE l.modifier_id = $1
		ORDER BY l.inventory_item_id
	`, modID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []ModifierInventoryLink{}
	for rows.Next() {
		var l ModifierInventoryLink
		if err := rows.Scan(&l.ModifierID, &l.InventoryItemID, &l.QtyConsumedPerSale); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": out})
}

// ModifierInventoryLink mirrors MenuItemInventoryLink (inventory.go) — same
// field names and the same numeric-as-string discipline.
type ModifierInventoryLink struct {
	ModifierID         uuid.UUID `json:"modifier_id"`
	InventoryItemID    uuid.UUID `json:"inventory_item_id"`
	QtyConsumedPerSale string    `json:"qty_consumed_per_sale"`
}

// =========================================================================
// Resolution + validation used by the order path
// =========================================================================

// effectiveModifierGroupIDs returns the groups that apply to a menu item: the
// UNION of the item's own attachments and its category's.
//
// This composes rather than overrides, which is the opposite of how
// kitchen_behavior (0040) and outlet (0045) resolve. "All drinks can have an
// extra shot" (category) and "this latte can also have syrup" (item) must BOTH
// be offered; picking one level as the winner would silently drop the other.
func effectiveModifierGroupIDs(ctx context.Context, tx pgx.Tx, menuItemID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `
		SELECT g.id
		FROM menu_modifier_groups g
		WHERE g.deleted_at IS NULL AND g.is_active
		  AND (
		    EXISTS (SELECT 1 FROM menu_item_modifier_groups l
		             WHERE l.group_id = g.id AND l.menu_item_id = $1)
		    OR EXISTS (SELECT 1 FROM menu_category_modifier_groups l
		               JOIN menu_items mi ON mi.category_id = l.category_id
		                WHERE l.group_id = g.id AND mi.id = $1)
		  )
		ORDER BY g.sort, lower(g.name)
	`, menuItemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// addOnChoice is one add-on as the client sends it. ID is client-minted so a
// replayed offline batch is idempotent, exactly like the parent line's id.
type addOnChoice struct {
	ID         *uuid.UUID `json:"id"`
	ModifierID uuid.UUID  `json:"modifier_id"`
	Qty        float64    `json:"qty"`
}

// resolvedAddOns is the outcome of validating a line's chosen add-ons: the rows
// to insert, and the amounts to fold into the parent line.
type resolvedAddOns struct {
	rows []OrderItemAddOn
	// AddPriceCents/AddCostCents are per ONE unit of the parent, so they add
	// straight onto unit_price_cents / unit_cost_cents.
	AddPriceCents int64
	AddCostCents  int64
}

// addOnError carries an HTTP status + error kind so callers can translate a
// validation failure into the right response without re-deriving it.
type addOnError struct {
	status int
	kind   string
	msg    string
}

func (e *addOnError) Error() string { return e.msg }

func badAddOn(kind, msg string) *addOnError {
	return &addOnError{status: http.StatusBadRequest, kind: kind, msg: msg}
}

// resolveAddOns validates a line's chosen add-ons against the menu item's
// effective groups and returns the snapshot rows plus the folded amounts.
//
// Prices and costs are re-read from menu_modifiers here and NEVER taken from the
// client, the same discipline AddOrderItems already applies to menu_items.
// Every rule is checked before anything is written, because TxMiddleware commits
// on a 4xx.
func resolveAddOns(
	ctx context.Context,
	tx pgx.Tx,
	menuItemID uuid.UUID,
	choices []addOnChoice,
) (resolvedAddOns, error) {
	var out resolvedAddOns
	out.rows = []OrderItemAddOn{}

	allowed, err := effectiveModifierGroupIDs(ctx, tx, menuItemID)
	if err != nil {
		return out, err
	}
	allowedSet := map[uuid.UUID]bool{}
	for _, g := range allowed {
		allowedSet[g] = true
	}

	// Collapse duplicate picks of the same modifier into one row with summed
	// qty, so tapping "+" twice is one "×2" line rather than two identical ones.
	order := []uuid.UUID{}
	qtyByModifier := map[uuid.UUID]float64{}
	idByModifier := map[uuid.UUID]uuid.UUID{}
	for _, c := range choices {
		if c.ModifierID == uuid.Nil {
			return out, badAddOn("bad_request", "add-on modifier_id required")
		}
		qty := c.Qty
		if qty == 0 {
			qty = 1 // an omitted qty means one, matching the parent-line default
		}
		if qty < 0 {
			return out, badAddOn("invalid_qty", "add-on quantity must be positive")
		}
		// Whole numbers only: "half an extra cheese" is not a thing, and the
		// half-plate allowance (0044) belongs to the parent item, not its add-ons.
		if qty != math.Trunc(qty) {
			return out, badAddOn("invalid_qty", "add-on quantity must be a whole number")
		}
		if _, seen := qtyByModifier[c.ModifierID]; !seen {
			order = append(order, c.ModifierID)
			if c.ID != nil && *c.ID != uuid.Nil {
				idByModifier[c.ModifierID] = *c.ID
			}
		}
		qtyByModifier[c.ModifierID] += qty
	}

	countByGroup := map[uuid.UUID]int{}
	for _, modID := range order {
		var (
			groupID   uuid.UUID
			groupName string
			name      string
			price     int64
			cost      *int64
			maxSelect *int
		)
		err := tx.QueryRow(ctx, `
			SELECT m.group_id, g.name, m.name, m.price_cents, m.cost_cents, g.max_select
			FROM menu_modifiers m
			JOIN menu_modifier_groups g ON g.id = m.group_id
			WHERE m.id = $1 AND m.deleted_at IS NULL AND m.is_active
			  AND g.deleted_at IS NULL AND g.is_active
		`, modID).Scan(&groupID, &groupName, &name, &price, &cost, &maxSelect)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return out, badAddOn("modifier_not_found", "add-on not found or inactive")
			}
			return out, err
		}
		if !allowedSet[groupID] {
			return out, badAddOn("modifier_not_allowed",
				fmt.Sprintf("add-on %q is not offered on this item", name))
		}

		qty := qtyByModifier[modID]
		countByGroup[groupID]++
		if maxSelect != nil && countByGroup[groupID] > *maxSelect {
			return out, badAddOn("modifier_selection_invalid",
				fmt.Sprintf("%s allows at most %d choice(s)", groupName, *maxSelect))
		}

		unitCost := int64(0)
		if cost != nil {
			unitCost = *cost
		}
		row := OrderItemAddOn{
			ID:         uuid.New(),
			ModifierID: modID,
			GroupName:  groupName,
			Name:       name,
			PriceCents: price,
			CostCents:  unitCost,
			Qty:        qty,
		}
		if id, ok := idByModifier[modID]; ok {
			row.ID = id
		}
		out.rows = append(out.rows, row)
		// Round per row, then sum — the exact arithmetic
		// platform_accuracy_check_addons() uses, so the invariant it checks can
		// never disagree with what we wrote.
		out.AddPriceCents += int64(math.Round(qty * float64(price)))
		out.AddCostCents += int64(math.Round(qty * float64(unitCost)))
	}

	// Required groups: enforced only over the item's OWN effective groups, so
	// attaching a required group to a category can't retroactively make lines of
	// an unrelated item unaddable.
	reqRows, err := tx.Query(ctx, `
		SELECT id, name, min_select FROM menu_modifier_groups
		WHERE id = ANY($1) AND min_select > 0 AND deleted_at IS NULL AND is_active
		ORDER BY sort, lower(name)
	`, allowed)
	if err != nil {
		return out, err
	}
	defer reqRows.Close()
	for reqRows.Next() {
		var (
			gid  uuid.UUID
			name string
			min  int
		)
		if err := reqRows.Scan(&gid, &name, &min); err != nil {
			return out, err
		}
		if countByGroup[gid] < min {
			return out, badAddOn("modifier_selection_invalid",
				fmt.Sprintf("%s requires at least %d choice(s)", name, min))
		}
	}
	return out, reqRows.Err()
}

// insertAddOns writes the resolved rows for a line. ON CONFLICT DO NOTHING on
// the client-minted id makes a replayed offline batch a no-op, matching the
// parent line's exactly-once discipline in AddOrderItems.
func insertAddOns(ctx context.Context, tx pgx.Tx, tenantID, lineID uuid.UUID, rows []OrderItemAddOn) error {
	for _, a := range rows {
		if _, err := tx.Exec(ctx, `
			INSERT INTO order_item_modifiers
			  (id, tenant_id, order_item_id, modifier_id, group_name, name, price_cents, cost_cents, qty)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (id) DO NOTHING
		`, a.ID, tenantID, lineID, a.ModifierID, a.GroupName, a.Name,
			a.PriceCents, a.CostCents, a.Qty); err != nil {
			return err
		}
	}
	return nil
}

// loadAddOns reads the chosen add-ons for a set of lines, keyed by line id, so a
// list endpoint can hydrate every line in one round trip instead of N.
func loadAddOns(ctx context.Context, tx pgx.Tx, lineIDs []uuid.UUID) (map[uuid.UUID][]OrderItemAddOn, error) {
	out := map[uuid.UUID][]OrderItemAddOn{}
	if len(lineIDs) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT order_item_id, id, modifier_id, group_name, name, price_cents, cost_cents, qty
		FROM order_item_modifiers
		WHERE order_item_id = ANY($1)
		ORDER BY created_at, lower(name)
	`, lineIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var lineID uuid.UUID
		var a OrderItemAddOn
		if err := rows.Scan(&lineID, &a.ID, &a.ModifierID, &a.GroupName, &a.Name,
			&a.PriceCents, &a.CostCents, &a.Qty); err != nil {
			return nil, err
		}
		out[lineID] = append(out[lineID], a)
	}
	return out, rows.Err()
}
