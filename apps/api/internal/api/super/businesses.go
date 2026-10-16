package super

// Businesses group several tenants as branches of one business (migration
// 0088). A branch is an ordinary tenant; the business row only gives the group
// a name, drives the branch switcher, and scopes consolidated reports.
//
// Branches are created here, by a platform admin, never self-serve.

import (
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
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
	"github.com/pewssh/cafe-mgmt/api/internal/tenant"
)

// BusinessBranch is one tenant inside a business, as the console lists it.
type BusinessBranch struct {
	TenantID uuid.UUID `json:"tenant_id"`
	Slug     string    `json:"slug"`
	Name     string    `json:"name"`
	Status   string    `json:"status"`
	PlanKey  *string   `json:"plan_key"`
	Phone    *string   `json:"contact_phone"`
}

// Business is a business with its branches.
type Business struct {
	ID        uuid.UUID        `json:"id"`
	Name      string           `json:"name"`
	CreatedAt time.Time        `json:"created_at"`
	Branches  []BusinessBranch `json:"branches"`
}

func loadBusiness(r *http.Request, tx pgx.Tx, id uuid.UUID) (*Business, error) {
	var b Business
	if err := tx.QueryRow(r.Context(),
		`SELECT id, name, created_at FROM businesses WHERE id = $1`, id,
	).Scan(&b.ID, &b.Name, &b.CreatedAt); err != nil {
		return nil, err
	}
	rows, err := tx.Query(r.Context(), `
		SELECT t.id, t.slug, t.name, t.status::text, p.key, NULLIF(btrim(t.contact_phone), '')
		FROM tenants t
		LEFT JOIN plans p ON p.id = t.plan_id
		WHERE t.business_id = $1 AND t.deleted_at IS NULL
		ORDER BY t.name, t.slug
	`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	b.Branches = []BusinessBranch{}
	for rows.Next() {
		var br BusinessBranch
		if err := rows.Scan(&br.TenantID, &br.Slug, &br.Name, &br.Status, &br.PlanKey, &br.Phone); err != nil {
			return nil, err
		}
		b.Branches = append(b.Branches, br)
	}
	return &b, rows.Err()
}

// ListBusinesses — GET /v1/super/businesses.
func ListBusinesses(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `SELECT id FROM businesses ORDER BY name`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	out := make([]*Business, 0, len(ids))
	for _, id := range ids {
		b, err := loadBusiness(r, tx, id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, b)
	}
	writeJSON(w, http.StatusOK, map[string]any{"businesses": out})
}

// GetBusiness — GET /v1/super/businesses/{id}.
func GetBusiness(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	b, err := loadBusiness(r, appctx.Tx(r.Context()), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "no such business")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// CreateBusiness — POST /v1/super/businesses  body: {name, tenant_id?}
//
// With tenant_id, that café becomes the business's first branch — the usual
// way in: "Sahan Cafe is opening a second place" starts from Sahan.
func CreateBusiness(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string     `json:"name"`
		TenantID *uuid.UUID `json:"tenant_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name is required")
		return
	}
	ctx := r.Context()
	tx := appctx.Tx(ctx)
	actor, _ := appctx.UserFromContext(ctx)

	var id uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO businesses (name, created_by_user_id) VALUES ($1, $2) RETURNING id`,
		name, actor.ID,
	).Scan(&id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if body.TenantID != nil {
		if code, kind, msg := attachTenant(r, tx, *body.TenantID, &id); code != 0 {
			writeErr(w, code, kind, msg)
			return
		}
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "business.create", TargetTenantID: body.TenantID,
		TargetID: id.String(), Summary: "created business " + name})

	b, err := loadBusiness(r, tx, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, b)
}

// RenameBusiness — PATCH /v1/super/businesses/{id}  body: {name}
func RenameBusiness(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "name is required")
		return
	}
	tx := appctx.Tx(r.Context())
	tag, err := tx.Exec(r.Context(), `UPDATE businesses SET name = $2 WHERE id = $1`, id, strings.TrimSpace(body.Name))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such business")
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "business.rename", TargetID: id.String(),
		Summary: "renamed business to " + strings.TrimSpace(body.Name)})
	b, err := loadBusiness(r, tx, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// SetTenantBusiness — PATCH /v1/super/tenants/{id}/business  body: {business_id|null}
//
// Attaches a café to a business as a branch, or detaches it (null). Detaching
// never touches the café's data; it only stops appearing in the switcher and
// in consolidated reports.
func SetTenantBusiness(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		BusinessID *uuid.UUID `json:"business_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	tx := appctx.Tx(r.Context())
	if code, kind, msg := attachTenant(r, tx, id, body.BusinessID); code != 0 {
		writeErr(w, code, kind, msg)
		return
	}
	summary := "detached from business"
	target := ""
	if body.BusinessID != nil {
		summary = "attached to business " + body.BusinessID.String()
		target = body.BusinessID.String()
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "tenant.business", TargetTenantID: &id,
		TargetID: target, Summary: summary})
	writeJSON(w, http.StatusOK, map[string]any{"tenant_id": id, "business_id": body.BusinessID})
}

// attachTenant sets (or clears) a tenant's business. It returns a non-zero
// HTTP code with an error kind/message when the change is refused.
func attachTenant(r *http.Request, tx pgx.Tx, tenantID uuid.UUID, businessID *uuid.UUID) (int, string, string) {
	ctx := r.Context()
	var isClone bool
	err := tx.QueryRow(ctx,
		`SELECT cloned_from_tenant_id IS NOT NULL FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
		tenantID,
	).Scan(&isClone)
	if errors.Is(err, pgx.ErrNoRows) {
		return http.StatusNotFound, "not_found", "no such tenant"
	}
	if err != nil {
		return http.StatusInternalServerError, "internal_error", err.Error()
	}
	if isClone && businessID != nil {
		// A QA clone is a copy of a real café's books; letting it into a
		// business would put its numbers into the owner's consolidated view.
		return http.StatusConflict, "tenant_is_clone", "a QA clone can't be a branch"
	}
	if businessID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM businesses WHERE id = $1)`, *businessID).Scan(&exists); err != nil {
			return http.StatusInternalServerError, "internal_error", err.Error()
		}
		if !exists {
			return http.StatusNotFound, "not_found", "no such business"
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE tenants SET business_id = $2 WHERE id = $1`, tenantID, businessID); err != nil {
		return http.StatusInternalServerError, "internal_error", err.Error()
	}
	tenant.InvalidateByID(tenantID)
	return 0, "", ""
}

// AddBranch — POST /v1/super/businesses/{id}/branches
//
// Body: {name, slug?, timezone?, phone?, plan_key?, owner_email?, seed_from_tenant_id?}
//
// Provisions a new café exactly as CreateTenant does, attaches it to the
// business, optionally seeds it with a sibling branch's menu and setup, and
// makes every current owner of the business an owner of the new branch — so
// the people who run the business can open it straight away.
func AddBranch(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		businessID, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid business id")
			return
		}
		var body struct {
			Name             string     `json:"name"`
			Slug             string     `json:"slug"`
			Timezone         string     `json:"timezone"`
			Phone            string     `json:"phone"`
			PlanKey          string     `json:"plan_key"`
			OwnerEmail       string     `json:"owner_email"`
			SeedFromTenantID *uuid.UUID `json:"seed_from_tenant_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "name is required")
			return
		}
		ctx := r.Context()
		tx := appctx.Tx(ctx)
		actor, _ := appctx.UserFromContext(ctx)

		biz, err := loadBusiness(r, tx, businessID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "no such business")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if body.SeedFromTenantID != nil {
			inBusiness := false
			for _, br := range biz.Branches {
				if br.TenantID == *body.SeedFromTenantID {
					inBusiness = true
				}
			}
			if !inBusiness {
				writeErr(w, http.StatusBadRequest, "bad_seed", "the branch to copy from must belong to this business")
				return
			}
		}

		// Owners of the business. Read BEFORE provisioning: provisionTenant
		// moves app.tenant_id to the new branch for the rest of the tx.
		var ownerIDs []uuid.UUID
		var ownerEmails []string
		rows, err := tx.Query(ctx, `
			SELECT o.user_id, u.email
			FROM business_owner_ids($1) o
			JOIN users u ON u.id = o.user_id
			ORDER BY u.email
		`, businessID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		for rows.Next() {
			var id uuid.UUID
			var email string
			if err := rows.Scan(&id, &email); err != nil {
				rows.Close()
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			ownerIDs = append(ownerIDs, id)
			ownerEmails = append(ownerEmails, email)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		ownerEmail := strings.TrimSpace(body.OwnerEmail)
		if ownerEmail == "" && len(ownerEmails) > 0 {
			ownerEmail = ownerEmails[0]
		}
		if ownerEmail == "" {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"this business has no owners yet — give the new branch an owner_email")
			return
		}

		// Defaults from a sibling: same timezone, contact phone and plan as the
		// seed (or the first branch) — branches of one business usually share
		// all three, and a new branch of a paying business should not quietly
		// start on a trial clock.
		tz, phone, planKey := strings.TrimSpace(body.Timezone), strings.TrimSpace(body.Phone), strings.TrimSpace(body.PlanKey)
		if (tz == "" || phone == "" || planKey == "") && len(biz.Branches) > 0 {
			ref := biz.Branches[0].TenantID
			if body.SeedFromTenantID != nil {
				ref = *body.SeedFromTenantID
			}
			var refTZ, refPlan string
			var refPhone *string
			if err := tx.QueryRow(ctx, `
				SELECT COALESCE(t.timezone, ''), t.contact_phone, COALESCE(p.key, '')
				FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id AND p.active
				WHERE t.id = $1`, ref).
				Scan(&refTZ, &refPhone, &refPlan); err == nil {
				if tz == "" {
					tz = refTZ
				}
				if phone == "" && refPhone != nil {
					phone = strings.TrimSpace(*refPhone)
				}
				if planKey == "" {
					planKey = refPlan
				}
			}
		}
		if phone == "" {
			writeErr(w, http.StatusBadRequest, "phone_required",
				"a contact phone number is required — the branch you're copying from doesn't have one")
			return
		}

		newID, slug, err := provisionTenant(ctx, tx, repo, actor.ID, ProvisionParams{
			Name: strings.TrimSpace(body.Name), Slug: strings.TrimSpace(body.Slug), Timezone: tz,
			OwnerEmail: ownerEmail, PlanKey: planKey, Phone: phone,
			OnboardedBy:       actingPersonID(ctx, tx, actor.ID),
			AcquisitionSource: "",
		})
		if errors.Is(err, errSlugTaken) {
			writeErr(w, http.StatusConflict, "slug_taken", "that slug is already taken")
			return
		}
		if errors.Is(err, errInvalidSlug) {
			writeErr(w, http.StatusBadRequest, "invalid_slug",
				"Slug must be 2–63 characters: lowercase letters, numbers and hyphens only. Leave it blank to derive it from the name.")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET business_id = $2 WHERE id = $1`, newID, businessID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		var copied json.RawMessage
		if body.SeedFromTenantID != nil {
			if err := tx.QueryRow(ctx, `SELECT clone_tenant_catalog($1, $2)`, *body.SeedFromTenantID, newID).Scan(&copied); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}

		// Business owners become owners here directly. app.tenant_id is the new
		// branch (provisionTenant set it), so the RLS WITH CHECK passes.
		for _, uid := range ownerIDs {
			if _, err := tx.Exec(ctx, `
				INSERT INTO tenant_members (tenant_id, user_id, status, invited_by_user_id)
				VALUES ($1, $2, 'active', $3)
				ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
			`, newID, uid, actor.ID); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO tenant_member_roles (tenant_id, user_id, role_id)
				SELECT $1, $2, r.id FROM roles r WHERE r.tenant_id = $1 AND r.is_system AND r.key = 'owner'
				ON CONFLICT DO NOTHING
			`, newID, uid); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}
		// The owner invite provisionTenant issued is already satisfied when its
		// email belongs to one of those owners — close it so it doesn't sit as
		// a pending seat.
		if len(ownerIDs) > 0 {
			if _, err := tx.Exec(ctx, `
				UPDATE tenant_invites i
				   SET accepted_at = now(), accepted_by_user_id = u.id
				  FROM users u
				 WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
				   AND lower(u.email) = lower(i.email::text) AND u.id = ANY($2)
			`, newID, ownerIDs); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}

		logPlatform(r, tx, audit.PlatformEntry{Action: "business.add_branch", TargetTenantID: &newID,
			TargetID: businessID.String(), Summary: "added branch " + slug + " to " + biz.Name})

		resp := map[string]any{"id": newID, "slug": slug, "business_id": businessID}
		if copied != nil {
			resp["copied"] = copied
		}
		writeJSON(w, http.StatusCreated, resp)
	}
}
