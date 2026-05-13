package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

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
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Sort     int       `json:"sort"`
	Color    *string   `json:"color,omitempty"`
	IsActive bool      `json:"is_active"`
}

func ListMenuCategories(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.list_categories")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, sort, color, is_active
		FROM menu_categories
		WHERE deleted_at IS NULL
		ORDER BY sort, lower(name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []MenuCategory{}
	for rows.Next() {
		var c MenuCategory
		if err := rows.Scan(&c.ID, &c.Name, &c.Sort, &c.Color, &c.IsActive); err != nil {
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
		Name  string  `json:"name"`
		Sort  int     `json:"sort"`
		Color *string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.create_category", "name", body.Name)
	tx := appctx.Tx(r.Context())
	var c MenuCategory
	c.IsActive = true
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO menu_categories (tenant_id, name, sort, color)
		VALUES ($1, $2, $3, $4)
		RETURNING id, name, sort, color, is_active
	`, t.ID, body.Name, body.Sort, body.Color).Scan(&c.ID, &c.Name, &c.Sort, &c.Color, &c.IsActive); err != nil {
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
		Name     *string `json:"name"`
		Sort     *int    `json:"sort"`
		Color    *string `json:"color"`
		IsActive *bool   `json:"is_active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.update_category", "id", id)
	tx := appctx.Tx(r.Context())
	var c MenuCategory
	if err := tx.QueryRow(r.Context(), `
		UPDATE menu_categories
		SET name      = COALESCE($2, name),
		    sort      = COALESCE($3, sort),
		    color     = COALESCE($4, color),
		    is_active = COALESCE($5, is_active)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, sort, color, is_active
	`, id, body.Name, body.Sort, body.Color, body.IsActive).Scan(&c.ID, &c.Name, &c.Sort, &c.Color, &c.IsActive); err != nil {
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
	CostCents   *int64    `json:"cost_cents,omitempty"`
	SKU         *string   `json:"sku,omitempty"`
	ImageURL    *string   `json:"image_url,omitempty"`
	IsActive    bool      `json:"is_active"`
	Sort        int       `json:"sort"`
	Modifiers   any       `json:"modifiers"`
	// Preset notes are short, pre-canned annotations a waiter can tap to
	// attach when adding this item (e.g. "low sugar", "no ice"). Always
	// returned as an array — empty when no presets are configured.
	PresetNotes []string  `json:"preset_notes"`
}

func ListMenuItems(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.list_items",
		"category_id", r.URL.Query().Get("category_id"))
	tx := appctx.Tx(r.Context())
	categoryID := r.URL.Query().Get("category_id")

	q := `
		SELECT id, category_id, name, description, price_cents, cost_cents, sku, image_url, is_active, sort, modifiers, preset_notes
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
			&m.CostCents, &m.SKU, &m.ImageURL, &m.IsActive, &m.Sort, &mod, &m.PresetNotes); err != nil {
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
		Sort        int       `json:"sort"`
		Modifiers   any       `json:"modifiers"`
		PresetNotes []string  `json:"preset_notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.CategoryID == uuid.Nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "name + category_id required")
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
		INSERT INTO menu_items (tenant_id, category_id, name, description, price_cents, cost_cents, sku, image_url, sort, modifiers, preset_notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id, category_id, name, description, price_cents, cost_cents, sku, image_url, is_active, sort, modifiers, preset_notes
	`, t.ID, body.CategoryID, body.Name, body.Description, body.PriceCents,
		body.CostCents, body.SKU, body.ImageURL, body.Sort, mod, body.PresetNotes).Scan(
		&m.ID, &m.CategoryID, &m.Name, &m.Description, &m.PriceCents,
		&m.CostCents, &m.SKU, &m.ImageURL, &m.IsActive, &m.Sort, &mod, &m.PresetNotes); err != nil {
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
		CostCents   *int64     `json:"cost_cents"`
		SKU         *string    `json:"sku"`
		ImageURL    *string    `json:"image_url"`
		IsActive    *bool      `json:"is_active"`
		Sort        *int       `json:"sort"`
		// Send an empty array to clear; omit to leave as-is.
		PresetNotes *[]string  `json:"preset_notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
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
		    is_active    = COALESCE($9, is_active),
		    sort         = COALESCE($10, sort),
		    preset_notes = COALESCE($11::text[], preset_notes)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, category_id, name, description, price_cents, cost_cents, sku, image_url, is_active, sort, modifiers, preset_notes
	`, id, body.CategoryID, body.Name, body.Description, body.PriceCents,
		body.CostCents, body.SKU, body.ImageURL, body.IsActive, body.Sort, presetNotesArg).Scan(
		&m.ID, &m.CategoryID, &m.Name, &m.Description, &m.PriceCents,
		&m.CostCents, &m.SKU, &m.ImageURL, &m.IsActive, &m.Sort, &mod, &m.PresetNotes); err != nil {
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
	Sort     int       `json:"sort"`
}

func ListServiceTables(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "tables.list")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, capacity, area, status::text, sort
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
		if err := rows.Scan(&s.ID, &s.Name, &s.Capacity, &s.Area, &s.Status, &s.Sort); err != nil {
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
		INSERT INTO service_tables (tenant_id, name, capacity, area, sort)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, name, capacity, area, status::text, sort
	`, t.ID, body.Name, body.Capacity, body.Area, body.Sort).Scan(
		&s.ID, &s.Name, &s.Capacity, &s.Area, &s.Status, &s.Sort); err != nil {
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
		    sort     = COALESCE($6, sort)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, capacity, area, status::text, sort
	`, id, body.Name, body.Capacity, body.Area, body.Status, body.Sort).Scan(
		&s.ID, &s.Name, &s.Capacity, &s.Area, &s.Status, &s.Sort); err != nil {
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

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
