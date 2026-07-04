package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// =========================================================================
// MENU CATEGORIES
// =========================================================================

type MenuCategory struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Sort  int       `json:"sort"`
	Color *string   `json:"color,omitempty"`
	Icon  string    `json:"icon"`
	// Optional banner image (object URL) shown on the public customer menu.
	ImageURL *string `json:"image_url,omitempty"`
	IsActive bool    `json:"is_active"`
	// KitchenBehavior is the default kitchen routing for this category's items:
	// 'inherit' (use the tenant default), 'cook', 'ready', or 'serve'. An item
	// may override it. See validKitchenBehavior + SendOrderToKitchen.
	KitchenBehavior string `json:"kitchen_behavior"`
	// ItemCount is the live count of non-deleted items in this category.
	// Surfaced so the FE can show a badge AND so it can decide whether to
	// even let the user attempt a delete (the API enforces it too).
	ItemCount int `json:"item_count"`
}

// validKitchenBehavior reports whether v is an accepted kitchen-routing value.
// 'inherit' defers to the parent level (item → category → tenant default).
func validKitchenBehavior(v string) bool {
	switch v {
	case "inherit", "cook", "ready", "serve":
		return true
	}
	return false
}

func ListMenuCategories(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.list_categories")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT c.id, c.name, c.sort, c.color, c.icon, c.image_url, c.is_active, c.kitchen_behavior,
		       COALESCE((
		         SELECT COUNT(*)::int FROM menu_items mi
		         WHERE mi.category_id = c.id AND mi.deleted_at IS NULL
		       ), 0)
		FROM menu_categories c
		WHERE c.deleted_at IS NULL
		ORDER BY c.sort, lower(c.name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []MenuCategory{}
	for rows.Next() {
		var c MenuCategory
		if err := rows.Scan(&c.ID, &c.Name, &c.Sort, &c.Color, &c.Icon, &c.ImageURL, &c.IsActive, &c.KitchenBehavior, &c.ItemCount); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"categories": out})
}

func CreateMenuCategory(w http.ResponseWriter, r *http.Request) {
	t, ok := appctx.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	var body struct {
		Name            string  `json:"name"`
		Sort            int     `json:"sort"`
		Color           *string `json:"color"`
		Icon            string  `json:"icon"`
		ImageURL        *string `json:"image_url"`
		KitchenBehavior string  `json:"kitchen_behavior"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	if body.KitchenBehavior == "" {
		body.KitchenBehavior = "inherit"
	}
	if !validKitchenBehavior(body.KitchenBehavior) {
		writeErr(w, http.StatusBadRequest, "bad_request", "kitchen_behavior must be one of inherit, cook, ready, serve")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.create_category", "name", body.Name)
	tx := appctx.Tx(r.Context())
	var c MenuCategory
	c.IsActive = true
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO menu_categories (tenant_id, name, sort, color, icon, image_url, kitchen_behavior)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, name, sort, color, icon, image_url, is_active, kitchen_behavior
	`, t.ID, body.Name, body.Sort, body.Color, body.Icon, body.ImageURL, body.KitchenBehavior).Scan(&c.ID, &c.Name, &c.Sort, &c.Color, &c.Icon, &c.ImageURL, &c.IsActive, &c.KitchenBehavior); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "menu_category", EntityID: &c.ID,
		Summary: fmt.Sprintf("created menu category %s", audit.Quote(c.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func UpdateMenuCategory(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		Name  *string `json:"name"`
		Sort  *int    `json:"sort"`
		Color *string `json:"color"`
		Icon  *string `json:"icon"`
		// Send "" to clear the banner image, a URL to set it, or omit to leave
		// as-is (COALESCE keeps the existing value when the JSON key is absent).
		ImageURL        *string `json:"image_url"`
		IsActive        *bool   `json:"is_active"`
		KitchenBehavior *string `json:"kitchen_behavior"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.KitchenBehavior != nil && !validKitchenBehavior(*body.KitchenBehavior) {
		writeErr(w, http.StatusBadRequest, "bad_request", "kitchen_behavior must be one of inherit, cook, ready, serve")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.update_category", "id", id)
	tx := appctx.Tx(r.Context())
	var c MenuCategory
	if err := tx.QueryRow(r.Context(), `
		UPDATE menu_categories
		SET name             = COALESCE($2, name),
		    sort             = COALESCE($3, sort),
		    color            = COALESCE($4, color),
		    icon             = COALESCE($5, icon),
		    image_url        = COALESCE($6, image_url),
		    is_active        = COALESCE($7, is_active),
		    kitchen_behavior = COALESCE($8, kitchen_behavior)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, sort, color, icon, image_url, is_active, kitchen_behavior
	`, id, body.Name, body.Sort, body.Color, body.Icon, body.ImageURL, body.IsActive, body.KitchenBehavior).Scan(&c.ID, &c.Name, &c.Sort, &c.Color, &c.Icon, &c.ImageURL, &c.IsActive, &c.KitchenBehavior); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "menu_category", EntityID: &c.ID,
		Summary: fmt.Sprintf("updated menu category %s", audit.Quote(c.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func DeleteMenuCategory(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.delete_category", "id", id)
	tx := appctx.Tx(r.Context())

	// Block deletion when live items still belong to the category. We use
	// soft-deletion so historical orders keep their category labels intact;
	// the safer pattern is to ask the user to move or remove the items
	// first rather than silently orphaning them in the catalog.
	var itemCount int
	if err := tx.QueryRow(r.Context(), `
		SELECT COUNT(*)::int FROM menu_items
		WHERE category_id = $1 AND deleted_at IS NULL
	`, id).Scan(&itemCount); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if itemCount > 0 {
		writeErr(w, http.StatusConflict, "category_has_items",
			fmt.Sprintf("category still has %d item(s) — remove or move them first", itemCount))
		return
	}

	var name string
	if err := tx.QueryRow(r.Context(), `
		UPDATE menu_categories SET deleted_at = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING name
	`, id).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "menu_category", EntityID: &id,
		Summary: fmt.Sprintf("deleted menu category %s", audit.Quote(name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// MENU ITEMS
// =========================================================================

type MenuItem struct {
	ID          uuid.UUID `json:"id"`
	CategoryID  uuid.UUID `json:"category_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	PriceCents  int64     `json:"price_cents"`
	// CostCents is the cafe's own per-unit cost (what it costs to make/buy
	// one). Optional — null means "cost not set, ignored in COGS".
	CostCents *int64  `json:"cost_cents,omitempty"`
	SKU       *string `json:"sku,omitempty"`
	ImageURL  *string `json:"image_url,omitempty"`
	Icon      string  `json:"icon"`
	IsActive  bool    `json:"is_active"`
	// Operator-pinned: appears in the "Frequently used" row regardless of
	// order history. The popular endpoint blends featured + sales velocity.
	IsFeatured bool `json:"is_featured"`
	// KitchenBehavior is the per-item kitchen routing override: 'inherit'
	// (follow the category, then tenant default), 'cook', 'ready', or 'serve'.
	// 'serve' is the old auto_ready behaviour (skip kitchen, straight-serve).
	KitchenBehavior string `json:"kitchen_behavior"`
	// AllowHalf opts this item into fractional (½-step) quantities. When false
	// the API rejects any non-integer qty for lines of this item.
	AllowHalf bool `json:"allow_half"`
	Sort      int  `json:"sort"`
	Modifiers any  `json:"modifiers"`
	// Preset notes are short, pre-canned annotations a waiter can tap to
	// attach when adding this item (e.g. "low sugar", "no ice"). Always
	// returned as an array — empty when no presets are configured.
	PresetNotes []string `json:"preset_notes"`
}

func ListMenuItems(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.list_items",
		"category_id", r.URL.Query().Get("category_id"))
	tx := appctx.Tx(r.Context())
	categoryID := r.URL.Query().Get("category_id")

	q := `
		SELECT id, category_id, name, description, price_cents, cost_cents, sku, image_url, icon, is_active, is_featured, kitchen_behavior, allow_half, sort, modifiers, preset_notes
		FROM menu_items
		WHERE deleted_at IS NULL
	`
	args := []any{}
	if categoryID != "" {
		q += " AND category_id = $1"
		args = append(args, categoryID)
	}
	q += " ORDER BY sort, lower(name)"

	rows, err := tx.Query(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []MenuItem{}
	for rows.Next() {
		var m MenuItem
		var mod []byte
		if err := rows.Scan(&m.ID, &m.CategoryID, &m.Name, &m.Description, &m.PriceCents,
			&m.CostCents, &m.SKU, &m.ImageURL, &m.Icon, &m.IsActive, &m.IsFeatured, &m.KitchenBehavior, &m.AllowHalf, &m.Sort, &mod, &m.PresetNotes); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		_ = json.Unmarshal(mod, &m.Modifiers)
		if m.PresetNotes == nil {
			m.PresetNotes = []string{}
		}
		out = append(out, m)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func CreateMenuItem(w http.ResponseWriter, r *http.Request) {
	t, ok := appctx.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	var body struct {
		CategoryID  uuid.UUID `json:"category_id"`
		Name        string    `json:"name"`
		Description string    `json:"description"`
		PriceCents  int64     `json:"price_cents"`
		CostCents   *int64    `json:"cost_cents"`
		SKU         *string   `json:"sku"`
		ImageURL    *string   `json:"image_url"`
		Icon            string   `json:"icon"`
		Sort            int      `json:"sort"`
		Modifiers       any      `json:"modifiers"`
		PresetNotes     []string `json:"preset_notes"`
		KitchenBehavior string   `json:"kitchen_behavior"`
		AllowHalf       bool     `json:"allow_half"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.CategoryID == uuid.Nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "name + category_id required")
		return
	}
	if body.PriceCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "price must be greater than 0")
		return
	}
	if body.KitchenBehavior == "" {
		body.KitchenBehavior = "inherit"
	}
	if !validKitchenBehavior(body.KitchenBehavior) {
		writeErr(w, http.StatusBadRequest, "bad_request", "kitchen_behavior must be one of inherit, cook, ready, serve")
		return
	}
	mod, err := json.Marshal(body.Modifiers)
	if err != nil || string(mod) == "null" {
		mod = []byte("{}")
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.create_item",
		"name", body.Name,
		"category_id", body.CategoryID,
		"price_cents", body.PriceCents)
	tx := appctx.Tx(r.Context())
	if body.PresetNotes == nil {
		body.PresetNotes = []string{}
	}
	var m MenuItem
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO menu_items (tenant_id, category_id, name, description, price_cents, cost_cents, sku, image_url, icon, sort, modifiers, preset_notes, kitchen_behavior, allow_half)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		RETURNING id, category_id, name, description, price_cents, cost_cents, sku, image_url, icon, is_active, is_featured, kitchen_behavior, allow_half, sort, modifiers, preset_notes
	`, t.ID, body.CategoryID, body.Name, body.Description, body.PriceCents,
		body.CostCents, body.SKU, body.ImageURL, body.Icon, body.Sort, mod, body.PresetNotes, body.KitchenBehavior, body.AllowHalf).Scan(
		&m.ID, &m.CategoryID, &m.Name, &m.Description, &m.PriceCents,
		&m.CostCents, &m.SKU, &m.ImageURL, &m.Icon, &m.IsActive, &m.IsFeatured, &m.KitchenBehavior, &m.AllowHalf, &m.Sort, &mod, &m.PresetNotes); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "menu_item", EntityID: &m.ID,
		Summary: fmt.Sprintf("created menu item %s (%s)", audit.Quote(m.Name), audit.Money(m.PriceCents)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	_ = json.Unmarshal(mod, &m.Modifiers)
	if m.PresetNotes == nil {
		m.PresetNotes = []string{}
	}
	writeJSON(w, http.StatusCreated, m)
}

func UpdateMenuItem(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		CategoryID  *uuid.UUID `json:"category_id"`
		Name        *string    `json:"name"`
		Description *string    `json:"description"`
		PriceCents  *int64     `json:"price_cents"`
		// Note: distinguishing "leave as-is" from "clear" requires sending
		// the field with a JSON null. The COALESCE keeps the existing
		// value when the JSON field is omitted. To explicitly clear cost,
		// set it to 0 — null in JSON is treated the same as missing.
		CostCents  *int64  `json:"cost_cents"`
		SKU        *string `json:"sku"`
		ImageURL   *string `json:"image_url"`
		Icon       *string `json:"icon"`
		IsActive        *bool   `json:"is_active"`
		IsFeatured      *bool   `json:"is_featured"`
		KitchenBehavior *string `json:"kitchen_behavior"`
		AllowHalf       *bool   `json:"allow_half"`
		Sort            *int    `json:"sort"`
		// Send an empty array to clear; omit to leave as-is.
		PresetNotes *[]string `json:"preset_notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.KitchenBehavior != nil && !validKitchenBehavior(*body.KitchenBehavior) {
		writeErr(w, http.StatusBadRequest, "bad_request", "kitchen_behavior must be one of inherit, cook, ready, serve")
		return
	}
	if body.PriceCents != nil && *body.PriceCents <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "price must be greater than 0")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.update_item", "id", id)
	tx := appctx.Tx(r.Context())
	var m MenuItem
	var mod []byte
	var presetNotesArg any
	if body.PresetNotes != nil {
		presetNotesArg = *body.PresetNotes
	}
	if err := tx.QueryRow(r.Context(), `
		UPDATE menu_items
		SET category_id  = COALESCE($2, category_id),
		    name         = COALESCE($3, name),
		    description  = COALESCE($4, description),
		    price_cents  = COALESCE($5, price_cents),
		    cost_cents   = COALESCE($6, cost_cents),
		    sku          = COALESCE($7, sku),
		    image_url    = COALESCE($8, image_url),
		    icon         = COALESCE($9, icon),
		    is_active    = COALESCE($10, is_active),
		    is_featured  = COALESCE($11, is_featured),
		    kitchen_behavior = COALESCE($12, kitchen_behavior),
		    sort         = COALESCE($13, sort),
		    preset_notes = COALESCE($14::text[], preset_notes),
		    allow_half   = COALESCE($15, allow_half)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, category_id, name, description, price_cents, cost_cents, sku, image_url, icon, is_active, is_featured, kitchen_behavior, allow_half, sort, modifiers, preset_notes
	`, id, body.CategoryID, body.Name, body.Description, body.PriceCents,
		body.CostCents, body.SKU, body.ImageURL, body.Icon, body.IsActive, body.IsFeatured, body.KitchenBehavior, body.Sort, presetNotesArg, body.AllowHalf).Scan(
		&m.ID, &m.CategoryID, &m.Name, &m.Description, &m.PriceCents,
		&m.CostCents, &m.SKU, &m.ImageURL, &m.Icon, &m.IsActive, &m.IsFeatured, &m.KitchenBehavior, &m.AllowHalf, &m.Sort, &mod, &m.PresetNotes); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "menu_item", EntityID: &m.ID,
		Summary: fmt.Sprintf("updated menu item %s", audit.Quote(m.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	_ = json.Unmarshal(mod, &m.Modifiers)
	if m.PresetNotes == nil {
		m.PresetNotes = []string{}
	}
	writeJSON(w, http.StatusOK, m)
}

func DeleteMenuItem(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.delete_item", "id", id)
	tx := appctx.Tx(r.Context())
	var name string
	if err := tx.QueryRow(r.Context(), `
		UPDATE menu_items SET deleted_at = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING name
	`, id).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "menu_item", EntityID: &id,
		Summary: fmt.Sprintf("deleted menu item %s", audit.Quote(name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// SERVICE TABLES
// =========================================================================

type ServiceTable struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Capacity int       `json:"capacity"`
	Area     string    `json:"area"`
	Status   string    `json:"status"`
	Icon     string    `json:"icon"`
	Sort     int       `json:"sort"`
}

func ListServiceTables(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "tables.list")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, capacity, area, status::text, icon, sort
		FROM service_tables
		WHERE deleted_at IS NULL
		ORDER BY sort, lower(name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []ServiceTable{}
	for rows.Next() {
		var s ServiceTable
		if err := rows.Scan(&s.ID, &s.Name, &s.Capacity, &s.Area, &s.Status, &s.Icon, &s.Sort); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"tables": out})
}

func CreateServiceTable(w http.ResponseWriter, r *http.Request) {
	t, ok := appctx.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	var body struct {
		Name     string `json:"name"`
		Capacity int    `json:"capacity"`
		Area     string `json:"area"`
		Icon     string `json:"icon"`
		Sort     int    `json:"sort"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	if body.Capacity <= 0 {
		body.Capacity = 2
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "tables.create",
		"name", body.Name, "capacity", body.Capacity, "area", body.Area)
	tx := appctx.Tx(r.Context())
	var s ServiceTable
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO service_tables (tenant_id, name, capacity, area, icon, sort)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, name, capacity, area, status::text, icon, sort
	`, t.ID, body.Name, body.Capacity, body.Area, body.Icon, body.Sort).Scan(
		&s.ID, &s.Name, &s.Capacity, &s.Area, &s.Status, &s.Icon, &s.Sort); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "table", EntityID: &s.ID,
		Summary: fmt.Sprintf("created table %s (capacity %d)", audit.Quote(s.Name), s.Capacity),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, s)
}

func UpdateServiceTable(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		Name     *string `json:"name"`
		Capacity *int    `json:"capacity"`
		Area     *string `json:"area"`
		Status   *string `json:"status"`
		Icon     *string `json:"icon"`
		Sort     *int    `json:"sort"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "tables.update", "id", id)
	tx := appctx.Tx(r.Context())
	var s ServiceTable
	if err := tx.QueryRow(r.Context(), `
		UPDATE service_tables
		SET name     = COALESCE($2, name),
		    capacity = COALESCE($3, capacity),
		    area     = COALESCE($4, area),
		    status   = COALESCE($5::service_table_status, status),
		    icon     = COALESCE($6, icon),
		    sort     = COALESCE($7, sort)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, capacity, area, status::text, icon, sort
	`, id, body.Name, body.Capacity, body.Area, body.Status, body.Icon, body.Sort).Scan(
		&s.ID, &s.Name, &s.Capacity, &s.Area, &s.Status, &s.Icon, &s.Sort); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "table", EntityID: &s.ID,
		Summary: fmt.Sprintf("updated table %s", audit.Quote(s.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func DeleteServiceTable(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "tables.delete", "id", id)
	tx := appctx.Tx(r.Context())
	var name string
	if err := tx.QueryRow(r.Context(), `
		UPDATE service_tables SET deleted_at = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING name
	`, id).Scan(&name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "table", EntityID: &id,
		Summary: fmt.Sprintf("deleted table %s", audit.Quote(name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// POPULAR ITEMS — frequently used menu items
// =========================================================================
//
// Two-source ranking:
//
//   1. Operator-pinned (menu_items.is_featured = true) always show first.
//      The owner controls what waiters see in the "Frequently used" row
//      out of the gate — useful before there's any order history.
//   2. Sales velocity: SUM(qty) over the last 30 days of closed orders.
//      Featured items are still in this list — order_count adds onto their
//      ranking, it doesn't replace it.
//
// Both lists are merged in a single query: ORDER BY is_featured DESC,
// qty_30d DESC keeps pins on top and sorts the long tail by velocity.
// If neither bucket fills the limit, pad with most-recently-created
// active items so freshly seeded tenants still see *something* on tap.

func ListPopularMenuItems(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())

	limit := 8
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 50 {
			limit = n
		}
	}

	since := time.Now().AddDate(0, 0, -30)

	// Featured items always surface; sold items rank by velocity.
	rows, err := tx.Query(r.Context(), `
		SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price_cents,
		       mi.cost_cents, mi.sku, mi.image_url, mi.icon, mi.is_active, mi.is_featured,
		       mi.kitchen_behavior, mi.allow_half, mi.sort, mi.modifiers, mi.preset_notes,
		       COALESCE(ROUND(SUM(oi.qty))::int, 0) AS qty_30d
		FROM menu_items mi
		LEFT JOIN order_items oi ON oi.menu_item_id = mi.id AND oi.voided_at IS NULL
		LEFT JOIN orders o ON o.id = oi.order_id
		    AND o.status = 'closed'
		    AND o.closed_at >= $1
		WHERE mi.deleted_at IS NULL AND mi.is_active = true
		GROUP BY mi.id
		HAVING mi.is_featured = true OR COALESCE(SUM(oi.qty), 0) > 0
		ORDER BY mi.is_featured DESC, qty_30d DESC, mi.sort, lower(mi.name)
		LIMIT $2
	`, since, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	type popularItem struct {
		MenuItem
		Qty30d int `json:"qty_30d"`
	}
	out := []popularItem{}
	seen := map[uuid.UUID]bool{}
	for rows.Next() {
		var m popularItem
		var mod []byte
		if err := rows.Scan(&m.ID, &m.CategoryID, &m.Name, &m.Description, &m.PriceCents,
			&m.CostCents, &m.SKU, &m.ImageURL, &m.Icon, &m.IsActive, &m.IsFeatured,
			&m.KitchenBehavior, &m.AllowHalf, &m.Sort, &mod, &m.PresetNotes, &m.Qty30d); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		_ = json.Unmarshal(mod, &m.Modifiers)
		if m.PresetNotes == nil {
			m.PresetNotes = []string{}
		}
		out = append(out, m)
		seen[m.ID] = true
	}
	rows.Close()

	// Pad with newest active items so a brand-new tenant — no featured
	// pins, no order history — still sees a row of items they can tap.
	if remaining := limit - len(out); remaining > 0 {
		padRows, err := tx.Query(r.Context(), `
			SELECT id, category_id, name, description, price_cents, cost_cents,
			       sku, image_url, icon, is_active, is_featured, kitchen_behavior, allow_half, sort, modifiers, preset_notes
			FROM menu_items
			WHERE deleted_at IS NULL AND is_active = true
			ORDER BY created_at DESC, sort, lower(name)
			LIMIT $1
		`, remaining+len(out))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		defer padRows.Close()
		for padRows.Next() && remaining > 0 {
			var m popularItem
			var mod []byte
			if err := padRows.Scan(&m.ID, &m.CategoryID, &m.Name, &m.Description, &m.PriceCents,
				&m.CostCents, &m.SKU, &m.ImageURL, &m.Icon, &m.IsActive, &m.IsFeatured,
				&m.KitchenBehavior, &m.AllowHalf, &m.Sort, &mod, &m.PresetNotes); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if seen[m.ID] {
				continue
			}
			_ = json.Unmarshal(mod, &m.Modifiers)
			if m.PresetNotes == nil {
				m.PresetNotes = []string{}
			}
			out = append(out, m)
			seen[m.ID] = true
			remaining--
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
