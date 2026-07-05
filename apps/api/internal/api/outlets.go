package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// =========================================================================
// OUTLETS (prep destinations: Kitchen, Bar, Bar2, …) — 0045
//
// An outlet is a named prep station with its own KDS board and a single
// networked ESC/POS printer. Categories (and, as an override, items) route to
// an outlet; on send-to-kitchen the effective outlet is stamped onto the order
// item (see SendOrderToKitchen). Exactly one outlet per tenant is the default
// (the seeded "Kitchen"), used as the routing fallback.
// =========================================================================

type Outlet struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Sort      int       `json:"sort"`
	IsActive  bool      `json:"is_active"`
	IsDefault bool      `json:"is_default"`
	// The outlet's single network printer. PrinterIP is null when no printer is
	// configured yet. Mobile prints ESC/POS straight to it; the web browser
	// path can't target an IP (it prints to the device's OS-default printer),
	// so on web the IP is informational.
	PrinterIP    *string `json:"printer_ip,omitempty"`
	PrinterPort  int     `json:"printer_port"`
	PrinterWidth string  `json:"printer_width"`
}

// outletBelongsToTenant reports whether the outlet exists and is live for the
// current tenant. RLS scopes the SELECT to the caller's tenant, so this also
// rejects a routing FK that points at another tenant's outlet (FK checks
// themselves bypass RLS). Nil id is treated as "no outlet" (valid = inherit).
func outletBelongsToTenant(r *http.Request, id *uuid.UUID) (bool, error) {
	if id == nil {
		return true, nil
	}
	var ok bool
	err := appctx.Tx(r.Context()).QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM outlets WHERE id = $1 AND deleted_at IS NULL)`, *id).Scan(&ok)
	return ok, err
}

// validateOutletPrinter bounds the printer fields on an outlet. The printer is
// optional (empty IP == none); when set, the same limits as validatePrinters
// apply. Returns a human message on the first problem ("" == valid).
func validateOutletPrinter(ip *string, port int, width string) string {
	if ip != nil && strings.TrimSpace(*ip) != "" && len(*ip) > 64 {
		return "printer_ip must be ≤ 64 characters"
	}
	if port < 1 || port > 65535 {
		return "printer_port must be 1–65535"
	}
	if width != "58" && width != "80" {
		return "printer_width must be \"58\" or \"80\""
	}
	return ""
}

func ListOutlets(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "outlets.list")
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, sort, is_active, is_default, printer_ip, printer_port, printer_width
		FROM outlets
		WHERE deleted_at IS NULL
		ORDER BY is_default DESC, sort, lower(name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []Outlet{}
	for rows.Next() {
		var o Outlet
		if err := rows.Scan(&o.ID, &o.Name, &o.Sort, &o.IsActive, &o.IsDefault, &o.PrinterIP, &o.PrinterPort, &o.PrinterWidth); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, o)
	}
	writeJSON(w, http.StatusOK, map[string]any{"outlets": out})
}

func CreateOutlet(w http.ResponseWriter, r *http.Request) {
	t, ok := appctx.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	var body struct {
		Name         string  `json:"name"`
		Sort         int     `json:"sort"`
		PrinterIP    *string `json:"printer_ip"`
		PrinterPort  *int    `json:"printer_port"`
		PrinterWidth *string `json:"printer_width"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	port := 9100
	if body.PrinterPort != nil {
		port = *body.PrinterPort
	}
	width := "80"
	if body.PrinterWidth != nil {
		width = *body.PrinterWidth
	}
	// Normalise the IP: a blank/whitespace value means "no printer" (NULL), not
	// an empty string, so downstream (mobile outletTarget) reads cleanly.
	var ip *string
	if body.PrinterIP != nil {
		if trimmed := strings.TrimSpace(*body.PrinterIP); trimmed != "" {
			ip = &trimmed
		}
	}
	if msg := validateOutletPrinter(ip, port, width); msg != "" {
		writeErr(w, http.StatusBadRequest, "bad_request", msg)
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "outlets.create", "name", body.Name)
	tx := appctx.Tx(r.Context())
	var o Outlet
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO outlets (tenant_id, name, sort, printer_ip, printer_port, printer_width)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, name, sort, is_active, is_default, printer_ip, printer_port, printer_width
	`, t.ID, body.Name, body.Sort, ip, port, width).Scan(
		&o.ID, &o.Name, &o.Sort, &o.IsActive, &o.IsDefault, &o.PrinterIP, &o.PrinterPort, &o.PrinterWidth); err != nil {
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "name_taken", "an outlet with this name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "outlet", EntityID: &o.ID,
		Summary: fmt.Sprintf("created outlet %s", audit.Quote(o.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, o)
}

func UpdateOutlet(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var body struct {
		Name      *string `json:"name"`
		Sort      *int    `json:"sort"`
		IsActive  *bool   `json:"is_active"`
		IsDefault *bool   `json:"is_default"`
		// Send "" to clear the printer, an IP to set it, or omit to leave as-is.
		PrinterIP    *string `json:"printer_ip"`
		PrinterPort  *int    `json:"printer_port"`
		PrinterWidth *string `json:"printer_width"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.PrinterWidth != nil && *body.PrinterWidth != "58" && *body.PrinterWidth != "80" {
		writeErr(w, http.StatusBadRequest, "bad_request", "printer_width must be \"58\" or \"80\"")
		return
	}
	if body.PrinterPort != nil && (*body.PrinterPort < 1 || *body.PrinterPort > 65535) {
		writeErr(w, http.StatusBadRequest, "bad_request", "printer_port must be 1–65535")
		return
	}
	if body.PrinterIP != nil {
		trimmed := strings.TrimSpace(*body.PrinterIP)
		if len(trimmed) > 64 {
			writeErr(w, http.StatusBadRequest, "bad_request", "printer_ip must be ≤ 64 characters")
			return
		}
		// Normalise so a whitespace-only value clears the printer (CASE '' → NULL).
		body.PrinterIP = &trimmed
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "outlets.update", "id", id)
	tx := appctx.Tx(r.Context())

	// Promoting this outlet to default: clear the current default first so the
	// one-default-per-tenant partial unique index doesn't collide. Demotion
	// (is_default=false) is a no-op — pick a different outlet as default instead.
	if body.IsDefault != nil && *body.IsDefault {
		if _, err := tx.Exec(r.Context(),
			`UPDATE outlets SET is_default = false WHERE is_default = true AND id <> $1`, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}
	setDefault := body.IsDefault != nil && *body.IsDefault

	var o Outlet
	if err := tx.QueryRow(r.Context(), `
		UPDATE outlets
		SET name          = COALESCE($2, name),
		    sort          = COALESCE($3, sort),
		    is_active     = COALESCE($4, is_active),
		    is_default    = CASE WHEN $5 THEN true ELSE is_default END,
		    printer_ip    = CASE WHEN $6::text IS NULL THEN printer_ip
		                         WHEN $6 = '' THEN NULL ELSE $6 END,
		    printer_port  = COALESCE($7, printer_port),
		    printer_width = COALESCE($8, printer_width)
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING id, name, sort, is_active, is_default, printer_ip, printer_port, printer_width
	`, id, body.Name, body.Sort, body.IsActive, setDefault, body.PrinterIP, body.PrinterPort, body.PrinterWidth).Scan(
		&o.ID, &o.Name, &o.Sort, &o.IsActive, &o.IsDefault, &o.PrinterIP, &o.PrinterPort, &o.PrinterWidth); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "name_taken", "an outlet with this name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "outlet", EntityID: &o.ID,
		Summary: fmt.Sprintf("updated outlet %s", audit.Quote(o.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, o)
}

func DeleteOutlet(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "outlets.delete", "id", id)
	tx := appctx.Tx(r.Context())

	// The default outlet is the routing fallback and cannot be removed — the
	// user must promote another outlet to default first.
	var isDefault bool
	var name string
	if err := tx.QueryRow(r.Context(),
		`SELECT is_default, name FROM outlets WHERE id = $1 AND deleted_at IS NULL`, id).Scan(&isDefault, &name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if isDefault {
		writeErr(w, http.StatusConflict, "outlet_is_default",
			"this is the default outlet — set another outlet as default first")
		return
	}

	// Categories/items pointing here fall back to the default (FK ON DELETE SET
	// NULL fires on the soft delete's null-out too — clear them explicitly since
	// soft delete doesn't trigger the FK).
	if _, err := tx.Exec(r.Context(),
		`UPDATE menu_categories SET outlet_id = NULL WHERE outlet_id = $1`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE menu_items SET outlet_id = NULL WHERE outlet_id = $1`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if _, err := tx.Exec(r.Context(),
		`UPDATE outlets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "outlet", EntityID: &id,
		Summary: fmt.Sprintf("deleted outlet %s", audit.Quote(name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
