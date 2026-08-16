package super

// Tenant cloning for QA: copy a real café into a throwaway workspace so a
// production bug can be reproduced against real data instead of a hand-built
// approximation. See migration 0063 for the copy engine.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
	"github.com/pewssh/cafe-mgmt/api/internal/tenant"
)

// clonePrefix marks a clone's slug so it is obvious in every list, URL and log
// line that this is not the real café.
const clonePrefix = "qa-"

// CloneTenant — POST /v1/super/tenants/{id}/clone
//
// Body: { name?, slug?, confirm_slug }
//
// confirm_slug must equal the SOURCE tenant's slug. Cloning is not destructive,
// but it produces a full copy of a real café's books — including customer names
// and staff records — so it asks the operator to name what they are copying,
// the same typed-confirmation gate the purge panel uses.
func CloneTenant(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		srcID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid tenant id")
			return
		}
		var body struct {
			Name        string `json:"name"`
			Slug        string `json:"slug"`
			ConfirmSlug string `json:"confirm_slug"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
			return
		}

		ctx := r.Context()
		tx := appctx.Tx(ctx)

		// Read the source. Cloning a soft-deleted tenant is pointless, and
		// cloning a clone compounds drift — refuse both.
		var (
			srcSlug, srcName string
			srcTZ            string
			srcPhone         *string
			srcOwnerEmail    *string
			isClone          bool
		)
		err = tx.QueryRow(ctx, `
			SELECT t.slug, t.name, COALESCE(t.timezone, 'Asia/Kathmandu'), t.contact_phone,
			       (SELECT u.email FROM tenant_members tm JOIN users u ON u.id = tm.user_id
			         WHERE tm.tenant_id = t.id ORDER BY tm.joined_at LIMIT 1),
			       t.cloned_from_tenant_id IS NOT NULL
			FROM tenants t
			WHERE t.id = $1 AND t.deleted_at IS NULL
		`, srcID).Scan(&srcSlug, &srcName, &srcTZ, &srcPhone, &srcOwnerEmail, &isClone)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "tenant not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if isClone {
			writeErr(w, http.StatusConflict, "source_is_clone",
				"that workspace is itself a clone — clone the original café instead")
			return
		}
		if strings.TrimSpace(body.ConfirmSlug) != srcSlug {
			writeErr(w, http.StatusBadRequest, "confirm_mismatch",
				"type the source workspace's slug ("+srcSlug+") to confirm")
			return
		}

		// Provision the shell exactly as a real café would be, so the clone has
		// seeded roles/outlet/invite machinery and nothing downstream has to know
		// it was made differently. provisionTenant resolves slug collisions.
		name := strings.TrimSpace(body.Name)
		if name == "" {
			name = srcName + " (QA clone)"
		}
		slug := strings.TrimSpace(body.Slug)
		if slug == "" {
			slug = clonePrefix + srcSlug
		}
		ownerEmail := ""
		if srcOwnerEmail != nil {
			ownerEmail = *srcOwnerEmail
		}
		if ownerEmail == "" {
			// A tenant with no members at all: fall back to the acting admin so
			// the clone still has an owner to log in as.
			actor, _ := appctx.UserFromContext(ctx)
			if err := tx.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, actor.ID).Scan(&ownerEmail); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}
		phone := "0000000000" // provisioning requires one; a clone is never contacted
		if srcPhone != nil && strings.TrimSpace(*srcPhone) != "" {
			phone = *srcPhone
		}

		actor, _ := appctx.UserFromContext(ctx)
		dstID, dstSlug, err := provisionTenant(ctx, tx, repo, actor.ID, ProvisionParams{
			Name: name, Slug: slug, Timezone: srcTZ,
			OwnerEmail: ownerEmail, PlanKey: "", Phone: phone,
		})
		if errors.Is(err, errInvalidSlug) {
			writeErr(w, http.StatusBadRequest, "invalid_slug",
				"Slug must be 2–63 characters: lowercase letters, numbers and hyphens only.")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Stamp the lineage BEFORE copying, so a clone is identifiable even if the
		// copy fails and the transaction is inspected mid-flight. Also comp the
		// billing state: a QA copy must never show up in the past-due KPI or start
		// a trial clock someone has to chase.
		if _, err := tx.Exec(ctx, `
			UPDATE tenants
			   SET cloned_from_tenant_id = $2,
			       cloned_at = now(),
			       trial_ends_at = NULL,
			       paid_through_at = now() + interval '100 years'
			 WHERE id = $1
		`, dstID, srcID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		var counts []byte
		if err := tx.QueryRow(ctx, `SELECT clone_tenant_data($1, $2)`, srcID, dstID).Scan(&counts); err != nil {
			writeErr(w, http.StatusInternalServerError, "clone_failed", err.Error())
			return
		}
		var parsed map[string]int64
		_ = json.Unmarshal(counts, &parsed)
		var rows int64
		for _, v := range parsed {
			rows += v
		}

		// The clone wrote rows for a tenant the cache may already hold under this
		// slug (collision-resolved slugs are fresh, but be explicit).
		tenant.InvalidateByID(dstID)

		logPlatform(r, tx, audit.PlatformEntry{
			Action: "tenant.clone", TargetTenantID: &dstID, TargetID: dstSlug,
			Summary: "cloned " + srcSlug + " → " + dstSlug + " for QA",
		})

		writeJSON(w, http.StatusCreated, map[string]any{
			"id":     dstID,
			"slug":   dstSlug,
			"name":   name,
			"rows":   rows,
			"counts": parsed,
		})
	}
}
