package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
)

// =========================================================================
// Manager-PIN gating
//
// Roles owner / manager can void + discount on their own. Waiter / kitchen
// must include approver_email + approver_pin in the request body; the
// backend resolves the approver, verifies they're an active manager+ in
// this tenant, and bcrypt-checks the PIN.
//
// All approval results (success or failure) write an audit_events row.
// =========================================================================

type approvalReq struct {
	ApproverEmail string `json:"approver_email"`
	ApproverPin   string `json:"approver_pin"`
}

// requireManagerOrApproval returns the user_id to record as the
// "approved_by" person. If the actor is owner/manager, that's themselves.
// If actor is waiter/kitchen, the body must carry approver_email + pin.
//
// Returns:
//   approverID — uuid of the user authorising the action
//   ok         — true if authorised
//   reason     — human-readable failure reason when ok=false
func requireManagerOrApproval(
	ctx context.Context,
	r *http.Request,
	approval approvalReq,
) (approverID uuid.UUID, ok bool, reason string) {
	user, _ := appctx.UserFromContext(ctx)
	// Anyone holding owner or manager (in addition to other hats like
	// waiter/kitchen) can self-approve.
	if auth.HasAnyRole(r, "owner", "manager") {
		return user.ID, true, ""
	}
	// Need an approver.
	if strings.TrimSpace(approval.ApproverEmail) == "" || approval.ApproverPin == "" {
		return uuid.Nil, false, "approver_email + approver_pin required"
	}
	id, ok := verifyApprover(ctx, approval.ApproverEmail, approval.ApproverPin)
	if !ok {
		return uuid.Nil, false, "approver email or PIN didn't match"
	}
	return id, true, ""
}

// verifyApprover looks up an active owner|manager for the current tenant
// by email and verifies the bcrypt PIN.
func verifyApprover(ctx context.Context, email, pin string) (uuid.UUID, bool) {
	tx := appctx.Tx(ctx)
	var id uuid.UUID
	var hash *string
	// Accept the approver if owner or manager appears anywhere in their
	// roles array on this tenant.
	err := tx.QueryRow(ctx, `
		SELECT u.id, tm.pin_hash
		FROM tenant_members tm
		JOIN users u ON u.id = tm.user_id
		WHERE u.email = $1
		  AND ('owner'::tenant_role  = ANY(tm.roles)
		    OR 'manager'::tenant_role = ANY(tm.roles))
		  AND tm.status = 'active'
	`, strings.ToLower(strings.TrimSpace(email))).Scan(&id, &hash)
	if errors.Is(err, pgx.ErrNoRows) || err != nil {
		return uuid.Nil, false
	}
	if hash == nil || *hash == "" {
		return uuid.Nil, false
	}
	if err := bcrypt.CompareHashAndPassword([]byte(*hash), []byte(pin)); err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// auditEvent inserts an audit row inside the current request transaction.
// Quiet on failure — auditing is best-effort, not blocking.
func auditEvent(ctx context.Context, action, entityType, entityID string, meta map[string]any) {
	t, ok := appctx.TenantFromContext(ctx)
	if !ok {
		return
	}
	user, _ := appctx.UserFromContext(ctx)
	tx := appctx.Tx(ctx)
	metaJSON, _ := json.Marshal(meta)
	if metaJSON == nil {
		metaJSON = []byte("{}")
	}
	_, _ = tx.Exec(ctx, `
		INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, t.ID, user.ID, action, entityType, entityID, metaJSON)
}

// =========================================================================
// /v1/me/pin — set or clear my own PIN
//
// Allowed only for owner|manager roles. Body: { "pin": "1234" } (4-8 chars).
// Body { "pin": "" } clears the PIN.
// =========================================================================

func SetMyPIN(w http.ResponseWriter, r *http.Request) {
	user, _ := appctx.UserFromContext(r.Context())
	t, _ := appctx.TenantFromContext(r.Context())
	if !auth.HasAnyRole(r, "owner", "manager") {
		writeErr(w, http.StatusForbidden, "role_not_allowed",
			"only owners and managers can set an approval PIN")
		return
	}

	var body struct {
		Pin string `json:"pin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "approvals.set_pin", "clear", body.Pin == "")

	tx := appctx.Tx(r.Context())
	if body.Pin == "" {
		if _, err := tx.Exec(r.Context(),
			`UPDATE tenant_members SET pin_hash = NULL WHERE tenant_id = $1 AND user_id = $2`,
			t.ID, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		auditEvent(r.Context(), "user.pin_cleared", "user", user.ID.String(), nil)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(body.Pin) < 4 || len(body.Pin) > 8 {
		writeErr(w, http.StatusBadRequest, "bad_pin", "PIN must be 4-8 characters")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Pin), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE tenant_members SET pin_hash = $3 WHERE tenant_id = $1 AND user_id = $2`,
		t.ID, user.ID, string(hash)); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	auditEvent(r.Context(), "user.pin_set", "user", user.ID.String(), nil)
	w.WriteHeader(http.StatusNoContent)
}
