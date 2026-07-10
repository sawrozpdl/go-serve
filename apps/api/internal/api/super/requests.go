package super

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// TenantRequest is the wire shape for a public access request.
type TenantRequest struct {
	ID                  uuid.UUID  `json:"id"`
	Name                string     `json:"name"`
	CafeName            string     `json:"cafe_name"`
	Email               string     `json:"email"`
	Phone               string     `json:"phone"`
	DesiredPlan         string     `json:"desired_plan"`
	Message             string     `json:"message"`
	State               string     `json:"state"`
	ProvisionedTenantID *uuid.UUID `json:"provisioned_tenant_id,omitempty"`
	ReviewNote          string     `json:"review_note"`
	CreatedAt           time.Time  `json:"created_at"`
	ReviewedAt          *time.Time `json:"reviewed_at,omitempty"`
}

// ListRequests — GET /v1/super/requests?state=pending (default all).
func ListRequests(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	state := r.URL.Query().Get("state")
	rows, err := tx.Query(r.Context(), `
		SELECT id, name, cafe_name, email::text, phone, desired_plan, message, state,
		       provisioned_tenant_id, review_note, created_at, reviewed_at
		FROM tenant_requests
		WHERE ($1 = '' OR state = $1)
		ORDER BY (state = 'pending') DESC, created_at DESC
	`, state)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []TenantRequest{}
	for rows.Next() {
		var t TenantRequest
		if err := rows.Scan(&t.ID, &t.Name, &t.CafeName, &t.Email, &t.Phone, &t.DesiredPlan,
			&t.Message, &t.State, &t.ProvisionedTenantID, &t.ReviewNote, &t.CreatedAt, &t.ReviewedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": out})
}

// ApproveRequest — POST /v1/super/requests/{id}/approve
// body: {slug?, timezone?, plan_key?}. Provisions a tenant + owner invite from
// the request's cafe_name/email, then marks the request approved.
func ApproveRequest(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseID(w, r)
		if !ok {
			return
		}
		var body struct {
			Slug     string `json:"slug"`
			Timezone string `json:"timezone"`
			PlanKey  string `json:"plan_key"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body) // all optional

		tx := appctx.Tx(r.Context())
		var cafeName, email, phone, state string
		err := tx.QueryRow(r.Context(),
			`SELECT cafe_name, email::text, phone, state FROM tenant_requests WHERE id = $1`, id).
			Scan(&cafeName, &email, &phone, &state)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "no such request")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if state != "pending" {
			writeErr(w, http.StatusConflict, "already_reviewed", "this request has already been reviewed")
			return
		}

		actor, _ := appctx.UserFromContext(r.Context())
		tenantID, slug, err := provisionTenant(r.Context(), tx, repo, actor.ID, ProvisionParams{
			Name: cafeName, Slug: body.Slug, Timezone: body.Timezone,
			OwnerEmail: email, PlanKey: body.PlanKey, Phone: phone,
		})
		if errors.Is(err, errSlugTaken) {
			writeErr(w, http.StatusConflict, "slug_taken", "that slug is already taken — pass a different one")
			return
		}
		if errors.Is(err, errInvalidSlug) {
			writeErr(w, http.StatusBadRequest, "invalid_slug",
				"Slug must be 2–63 characters: lowercase letters, numbers and hyphens only (e.g. my-cafe). Leave it blank to derive it from the name.")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Re-scope the GUC: provisionTenant set app.tenant_id to the new tenant,
		// but tenant_requests is a global table so the UPDATE works regardless.
		if _, err := tx.Exec(r.Context(), `
			UPDATE tenant_requests
			SET state = 'approved', provisioned_tenant_id = $2, reviewed_by = $3, reviewed_at = now()
			WHERE id = $1
		`, id, tenantID, actor.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		logPlatform(r, tx, audit.PlatformEntry{Action: "request.approve", TargetTenantID: &tenantID, TargetID: id.String(),
			Summary: "approved request from " + email + " → " + slug})
		writeJSON(w, http.StatusOK, map[string]any{"tenant_id": tenantID, "slug": slug})
	}
}

// RejectRequest — POST /v1/super/requests/{id}/reject  body: {note?:string}.
func RejectRequest(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	actor, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	ct, err := tx.Exec(r.Context(), `
		UPDATE tenant_requests
		SET state = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = now()
		WHERE id = $1 AND state = 'pending'
	`, id, body.Note, actor.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no pending request with that id")
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "request.reject", TargetID: id.String(), Summary: "rejected request"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
