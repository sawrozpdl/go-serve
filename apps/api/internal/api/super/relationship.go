package super

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// Shared with platform_leads.source (0061), so converting a lead can copy its
// source straight onto the tenant with no mapping in between. Keep in step with
// the CHECK constraints on tenants.acquisition_source and platform_leads.source.
var acquisitionSources = map[string]bool{
	"direct": true, "request_access": true, "referral": true, "walk_in": true,
	"outbound": true, "other": true,
}

// SetTenantRelationship — PATCH /v1/super/tenants/{id}/relationship
//
//	body: {onboarded_by_person_id, relationship_manager_id, onboarded_on,
//	       acquisition_source, owner_name}
//
// Person ids are pointers so null explicitly clears the attribution; omitting
// the RM while setting an onboarder defaults the RM to that onboarder, which is
// the overwhelmingly common case when recording a cafe after the fact.
func SetTenantRelationship(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		OnboardedByPersonID   *uuid.UUID `json:"onboarded_by_person_id"`
		RelationshipManagerID *uuid.UUID `json:"relationship_manager_id"`
		OnboardedOn           *string    `json:"onboarded_on"`
		AcquisitionSource     string     `json:"acquisition_source"`
		OwnerName             string     `json:"owner_name"`
		// Distinguishes "RM omitted, please default it" from "RM explicitly
		// cleared". Without this a JSON null and a missing key look identical
		// once decoded into a *uuid.UUID.
		RMProvided bool `json:"rm_provided"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.AcquisitionSource == "" {
		body.AcquisitionSource = "direct"
	}
	if !acquisitionSources[body.AcquisitionSource] {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"acquisition_source must be direct, request_access, referral, walk_in or other")
		return
	}
	var onboardedOn *string
	if body.OnboardedOn != nil && *body.OnboardedOn != "" {
		d, valid := parseDateOnly(*body.OnboardedOn)
		if !valid {
			writeErr(w, http.StatusBadRequest, "bad_request", "onboarded_on must be a YYYY-MM-DD date")
			return
		}
		onboardedOn = &d
	}

	rm := body.RelationshipManagerID
	if !body.RMProvided && rm == nil {
		rm = body.OnboardedByPersonID // default RM to the onboarder
	}

	tx := appctx.Tx(r.Context())
	// Validate both ids up front so a bad one is a clean 400 rather than a
	// foreign-key 500, and so the audit summary can name the people.
	onboarderName, ok := lookupPersonName(r.Context(), tx, w, body.OnboardedByPersonID)
	if !ok {
		return
	}
	rmName, ok := lookupPersonName(r.Context(), tx, w, rm)
	if !ok {
		return
	}

	ct, err := tx.Exec(r.Context(), `
		UPDATE tenants SET
			onboarded_by_person_id  = $1,
			relationship_manager_id = $2,
			onboarded_on            = COALESCE($3::date, onboarded_on),
			acquisition_source      = $4,
			owner_name              = $5
		WHERE id = $6 AND deleted_at IS NULL
	`, body.OnboardedByPersonID, rm, onboardedOn, body.AcquisitionSource,
		strings.TrimSpace(body.OwnerName), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such tenant")
		return
	}

	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.set_relationship", TargetTenantID: &id,
		Summary: "set relationship manager to " + orDash(rmName),
		Meta: map[string]any{
			"onboarded_by": orDash(onboarderName), "relationship_manager": orDash(rmName),
			"acquisition_source": body.AcquisitionSource,
		}})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// lookupPersonName resolves a person id to a name, writing a 400 and returning
// ok=false if the id doesn't exist. A nil id is valid (clearing) and yields "".
func lookupPersonName(ctx context.Context, tx pgx.Tx, w http.ResponseWriter, id *uuid.UUID) (string, bool) {
	if id == nil {
		return "", true
	}
	var name string
	switch err := tx.QueryRow(ctx, `SELECT name FROM platform_people WHERE id = $1`, *id).Scan(&name); {
	case err == nil:
		return name, true
	case errors.Is(err, pgx.ErrNoRows):
		writeErr(w, http.StatusBadRequest, "unknown_person", "no such person in the registry")
		return "", false
	default:
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return "", false
	}
}

func orDash(s string) string {
	if s == "" {
		return "nobody"
	}
	return s
}

// TenantNote is one entry in a cafe's CRM timeline.
type TenantNote struct {
	ID         uuid.UUID `json:"id"`
	Body       string    `json:"body"`
	Pinned     bool      `json:"pinned"`
	AuthorName string    `json:"author_name"`
	CreatedAt  time.Time `json:"created_at"`
}

// ListTenantNotes — GET /v1/super/tenants/{id}/notes. Pinned first, newest first.
func ListTenantNotes(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())
	// NULLIF before the fallback: users.name is NOT NULL and defaults to '',
	// so a plain COALESCE would return the empty string and never reach the
	// email — every note would show up as authored by nobody.
	rows, err := tx.Query(r.Context(), `
		SELECT n.id, n.body, n.pinned,
		       COALESCE(NULLIF(btrim(u.name), ''), u.email::text, ''),
		       n.created_at
		FROM tenant_notes n
		LEFT JOIN users u ON u.id = n.author_user_id
		WHERE n.tenant_id = $1
		ORDER BY n.pinned DESC, n.created_at DESC
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []TenantNote{}
	for rows.Next() {
		var n TenantNote
		if err := rows.Scan(&n.ID, &n.Body, &n.Pinned, &n.AuthorName, &n.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": out})
}

// AddTenantNote — POST /v1/super/tenants/{id}/notes  body: {body, pinned?}.
func AddTenantNote(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		Body   string `json:"body"`
		Pinned bool   `json:"pinned"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	body.Body = strings.TrimSpace(body.Body)
	if body.Body == "" || len(body.Body) > 4000 {
		writeErr(w, http.StatusBadRequest, "bad_request", "note must be 1–4000 characters")
		return
	}
	actor, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	var noteID uuid.UUID
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO tenant_notes (tenant_id, author_user_id, body, pinned)
		SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL)
		RETURNING id
	`, id, actor.ID, body.Body, body.Pinned).Scan(&noteID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "no such tenant")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.note_add", TargetTenantID: &id,
		TargetID: noteID.String(), Summary: "added a note: " + audit.Truncate(body.Body, 80)})
	writeJSON(w, http.StatusCreated, map[string]any{"id": noteID})
}

// UpdateTenantNote — PATCH /v1/super/tenants/{id}/notes/{noteId}  body: {pinned}.
// Only the pin flag is editable: a note is a dated record of what someone
// observed, and silently rewriting history would make the timeline worthless.
func UpdateTenantNote(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	noteID, err := uuid.Parse(chi.URLParam(r, "noteId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid note id")
		return
	}
	var body struct {
		Pinned bool `json:"pinned"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	tx := appctx.Tx(r.Context())
	ct, err := tx.Exec(r.Context(),
		`UPDATE tenant_notes SET pinned = $1 WHERE id = $2 AND tenant_id = $3`, body.Pinned, noteID, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such note")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// DeleteTenantNote — DELETE /v1/super/tenants/{id}/notes/{noteId}.
func DeleteTenantNote(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	noteID, err := uuid.Parse(chi.URLParam(r, "noteId"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid note id")
		return
	}
	tx := appctx.Tx(r.Context())
	ct, err := tx.Exec(r.Context(), `DELETE FROM tenant_notes WHERE id = $1 AND tenant_id = $2`, noteID, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such note")
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.note_delete", TargetTenantID: &id,
		TargetID: noteID.String(), Summary: "deleted a note"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
