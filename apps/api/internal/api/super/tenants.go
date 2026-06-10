package super

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
	"github.com/pewssh/cafe-mgmt/api/internal/tenant"
)

// TenantSummary is one row of the cross-tenant overview.
type TenantSummary struct {
	TenantID       uuid.UUID  `json:"tenant_id"`
	Slug           string     `json:"slug"`
	Name           string     `json:"name"`
	Status         string     `json:"status"`
	BillingState   string     `json:"billing_state"`
	PlanKey        string     `json:"plan_key"`
	PlanName       string     `json:"plan_name"`
	MemberLimit    *int       `json:"member_limit"`
	TrialEndsAt    *time.Time `json:"trial_ends_at,omitempty"`
	ActiveMembers  int        `json:"active_members"`
	PendingInvites int        `json:"pending_invites"`
	OwnerEmail     *string    `json:"owner_email,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	LastActivity   *time.Time `json:"last_activity,omitempty"`
}

func scanTenantSummaries(rows pgx.Rows) ([]TenantSummary, error) {
	defer rows.Close()
	out := []TenantSummary{}
	for rows.Next() {
		var t TenantSummary
		if err := rows.Scan(
			&t.TenantID, &t.Slug, &t.Name, &t.Status, &t.BillingState,
			&t.PlanKey, &t.PlanName, &t.MemberLimit, &t.TrialEndsAt,
			&t.ActiveMembers, &t.PendingInvites, &t.OwnerEmail,
			&t.CreatedAt, &t.LastActivity,
		); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ListTenants — GET /v1/super/tenants. Cross-tenant overview + KPI summary.
func ListTenants(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `SELECT * FROM platform_tenant_summaries()`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	tenants, err := scanTenantSummaries(rows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// KPI summary.
	var active, trialsExpiringSoon int
	byPlan := map[string]int{}
	soon := time.Now().Add(14 * 24 * time.Hour)
	for _, t := range tenants {
		if t.Status == "active" {
			active++
		}
		byPlan[t.PlanKey]++
		if t.TrialEndsAt != nil && t.TrialEndsAt.After(time.Now()) && t.TrialEndsAt.Before(soon) {
			trialsExpiringSoon++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tenants": tenants,
		"summary": map[string]any{
			"total":                 len(tenants),
			"active":                active,
			"trials_expiring_soon":  trialsExpiringSoon,
			"by_plan":               byPlan,
		},
	})
}

// TenantDetail extends the summary with raw editable fields.
type TenantDetail struct {
	TenantSummary
	MemberLimitOverride *int            `json:"member_limit_override"`
	FeatureOverrides    json.RawMessage `json:"feature_overrides"`
	BillingNote         string          `json:"billing_note"`
	Timezone            string          `json:"timezone"`
}

// GetTenantDetail — GET /v1/super/tenants/{id}.
func GetTenantDetail(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `SELECT * FROM platform_tenant_summaries() WHERE tenant_id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	list, err := scanTenantSummaries(rows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if len(list) == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such tenant")
		return
	}
	d := TenantDetail{TenantSummary: list[0]}
	if err := tx.QueryRow(r.Context(), `
		SELECT member_limit_override, feature_overrides, billing_note, timezone
		FROM tenants WHERE id = $1
	`, id).Scan(&d.MemberLimitOverride, &d.FeatureOverrides, &d.BillingNote, &d.Timezone); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// ChangePlan — PATCH /v1/super/tenants/{id}/plan  body: {plan_key}.
// Moving to the trial plan (re)starts a 90-day window; any other plan clears
// the trial gate (trial_ends_at = NULL).
func ChangePlan(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		PlanKey string `json:"plan_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.PlanKey == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "plan_key required")
		return
	}
	tx := appctx.Tx(r.Context())
	var planID uuid.UUID
	if err := tx.QueryRow(r.Context(), `SELECT id FROM plans WHERE key = $1`, body.PlanKey).Scan(&planID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusBadRequest, "bad_plan", "unknown plan key")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	trialClause := "NULL"
	if body.PlanKey == "trial" {
		trialClause = "now() + interval '90 days'"
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE tenants SET plan_id = $1, trial_ends_at = `+trialClause+` WHERE id = $2`,
		planID, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.change_plan", TargetTenantID: &id, TargetID: body.PlanKey,
		Summary: "changed plan to " + body.PlanKey})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// SetMemberLimitOverride — PATCH /v1/super/tenants/{id}/member-limit  body: {member_limit:int|null}.
func SetMemberLimitOverride(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		MemberLimit *int `json:"member_limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.MemberLimit != nil && *body.MemberLimit < 1 {
		writeErr(w, http.StatusBadRequest, "bad_request", "member_limit must be positive or null")
		return
	}
	tx := appctx.Tx(r.Context())
	if _, err := tx.Exec(r.Context(),
		`UPDATE tenants SET member_limit_override = $1 WHERE id = $2`, body.MemberLimit, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.set_seat_override", TargetTenantID: &id,
		Summary: "set seat override", Meta: map[string]any{"member_limit": body.MemberLimit}})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ExtendTrial — POST /v1/super/tenants/{id}/extend-trial  body: {days:int}.
// Extends from the current trial end (or now if none), re-enabling writes if
// the tenant had auto-locked.
func ExtendTrial(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		Days int `json:"days"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Days <= 0 || body.Days > 3650 {
		writeErr(w, http.StatusBadRequest, "bad_request", "days must be between 1 and 3650")
		return
	}
	tx := appctx.Tx(r.Context())
	if _, err := tx.Exec(r.Context(), `
		UPDATE tenants
		SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + make_interval(days => $1)
		WHERE id = $2
	`, body.Days, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.extend_trial", TargetTenantID: &id,
		Summary: "extended trial", Meta: map[string]any{"days": body.Days}})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ToggleWriteLock — POST /v1/super/tenants/{id}/write-lock  body: {locked:bool, note?:string}.
func ToggleWriteLock(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		Locked bool   `json:"locked"`
		Note   string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	state := "ok"
	if body.Locked {
		state = "write_locked"
	}
	tx := appctx.Tx(r.Context())
	if _, err := tx.Exec(r.Context(),
		`UPDATE tenants SET billing_state = $1, billing_note = $2 WHERE id = $3`,
		state, body.Note, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.write_lock", TargetTenantID: &id, TargetID: state,
		Summary: "set billing_state=" + state, Meta: map[string]any{"note": body.Note}})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// SuspendTenant / ReactivateTenant — POST /v1/super/tenants/{id}/(suspend|reactivate).
// Suspend flips status, which makes tenant.LookupBySlug 404 the whole tenant
// (hard deactivation, distinct from the write-lock). The local tenant cache is
// invalidated immediately; other instances converge within the cache TTL.
func SuspendTenant(w http.ResponseWriter, r *http.Request)    { setStatus(w, r, "suspended") }
func ReactivateTenant(w http.ResponseWriter, r *http.Request) { setStatus(w, r, "active") }

func setStatus(w http.ResponseWriter, r *http.Request, status string) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())
	ct, err := tx.Exec(r.Context(), `UPDATE tenants SET status = $1 WHERE id = $2 AND deleted_at IS NULL`, status, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such tenant")
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.set_status", TargetTenantID: &id, TargetID: status,
		Summary: "set status=" + status})
	tenant.InvalidateByID(id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// CreateTenant — POST /v1/super/tenants  body: {name, slug?, timezone?, owner_email, plan_key?}.
// Direct provisioning (when the super admin already spoke to the customer
// off-platform). Wraps provisionTenant.
func CreateTenant(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name       string `json:"name"`
			Slug       string `json:"slug"`
			Timezone   string `json:"timezone"`
			OwnerEmail string `json:"owner_email"`
			PlanKey    string `json:"plan_key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
			return
		}
		if body.Name == "" || body.OwnerEmail == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "name and owner_email are required")
			return
		}
		actor, _ := appctx.UserFromContext(r.Context())
		tx := appctx.Tx(r.Context())
		tenantID, slug, err := provisionTenant(r.Context(), tx, repo, actor.ID, ProvisionParams{
			Name: body.Name, Slug: body.Slug, Timezone: body.Timezone,
			OwnerEmail: body.OwnerEmail, PlanKey: body.PlanKey,
		})
		if errors.Is(err, errSlugTaken) {
			writeErr(w, http.StatusConflict, "slug_taken", "that slug is already taken")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.create", TargetTenantID: &tenantID, TargetID: slug,
			Summary: "provisioned " + slug + " for " + body.OwnerEmail})
		writeJSON(w, http.StatusCreated, map[string]any{"id": tenantID, "slug": slug})
	}
}

func parseID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return uuid.Nil, false
	}
	return id, true
}

// logPlatform writes a platform_audit row, surfacing failures as 500s would be
// noisy — instead we best-effort log and continue (the mutation already
// succeeded in the same tx; a failed audit insert would roll it back, so we DO
// propagate by writing within the tx and ignoring only the error return).
func logPlatform(r *http.Request, tx pgx.Tx, e audit.PlatformEntry) {
	_ = audit.LogPlatform(r.Context(), tx, e)
}
