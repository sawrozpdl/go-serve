package super

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// ProvisionParams describes a new tenant to create.
type ProvisionParams struct {
	Name       string
	Slug       string // derived from Name when empty
	Timezone   string // defaults to Asia/Kathmandu
	OwnerEmail string // gets an owner invite (auto-accepted on first login)
	PlanKey    string // defaults to "trial"
	Phone      string // required contact phone for the workspace
}

// errSlugTaken is returned when the slug collides with an existing tenant.
var errSlugTaken = errors.New("slug_taken")

// errInvalidSlug is returned when a caller-supplied slug fails slugRe. It maps
// to a 400 so the helpful message reaches the client (5xx bodies get masked in
// prod) — an invalid slug is a validation failure, not an internal error.
var errInvalidSlug = errors.New("invalid_slug")

// provisionTenant creates a tenant, seeds its system roles, and issues an
// owner invite for OwnerEmail — all inside the caller's transaction. The owner
// becomes an active member via AcceptPendingInvites on their first login, so
// the tenant starts with zero members and one pending invite. The trial window
// is the chosen plan's trial_days (0 = no trial → trial_ends_at = NULL); paid
// access is then tracked via recorded payments, not a trial gate.
//
// The caller's tx must already have app.user_id set (TxMiddleware does this);
// this function sets app.tenant_id mid-tx so the FORCE-RLS writes (roles,
// invites) succeed for the new tenant.
func provisionTenant(ctx context.Context, tx pgx.Tx, repo *rbac.Repo, actorID uuid.UUID, p ProvisionParams) (uuid.UUID, string, error) {
	slug := p.Slug
	if slug == "" {
		slug = slugify(p.Name)
	}
	if !slugRe.MatchString(slug) {
		return uuid.Nil, "", errInvalidSlug
	}
	tz := p.Timezone
	if tz == "" {
		tz = "Asia/Kathmandu"
	}
	planKey := p.PlanKey
	if planKey == "" {
		planKey = "trial"
	}

	// Resolve the plan and its trial window. trial_days > 0 → trial gate;
	// 0 → no trial (paid-only / comped tracking begins immediately).
	var (
		planID    uuid.UUID
		trialDays int
	)
	if err := tx.QueryRow(ctx, `SELECT id, trial_days FROM plans WHERE key = $1 AND active`, planKey).Scan(&planID, &trialDays); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, "", fmt.Errorf("unknown plan %q", planKey)
		}
		return uuid.Nil, "", err
	}

	var tenantID uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, timezone, plan_id, contact_phone, trial_ends_at)
		VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 > 0 THEN now() + make_interval(days => $6) ELSE NULL END)
		RETURNING id
	`, slug, p.Name, tz, planID, strings.TrimSpace(p.Phone), trialDays).Scan(&tenantID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return uuid.Nil, "", errSlugTaken
		}
		return uuid.Nil, "", err
	}

	// Scope the rest of the tx to the new tenant so FORCE-RLS inserts succeed.
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID.String()); err != nil {
		return uuid.Nil, "", err
	}

	if _, err := repo.SeedSystemRoles(ctx, tx, tenantID); err != nil {
		return uuid.Nil, "", err
	}

	// Every tenant starts with one default prep outlet ("Kitchen"). Adding a
	// second outlet (e.g. Bar) is what turns on multi-outlet routing; a
	// single-outlet cafe never sees the extra UI.
	if _, err := tx.Exec(ctx, `
		INSERT INTO outlets (tenant_id, name, is_default) VALUES ($1, 'Kitchen', true)
	`, tenantID); err != nil {
		return uuid.Nil, "", err
	}

	// Owner invite — claimed automatically when the owner first logs in with
	// this email (AcceptPendingInvites grants the owner role).
	var inviter any
	if actorID != uuid.Nil {
		inviter = actorID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenant_invites (tenant_id, email, roles, invited_by_user_id)
		VALUES ($1, $2, ARRAY['owner']::text[], $3)
	`, tenantID, p.OwnerEmail, inviter); err != nil {
		return uuid.Nil, "", err
	}

	// Tenant-scoped activity row so the workspace's own Activity page shows the
	// creation. app.tenant_id + app.user_id are both set, so RLS allows it.
	actor, _ := appctx.UserFromContext(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_log (
			tenant_id, actor_id, actor_name, actor_email, role_snap,
			action, entity, entity_id, summary, request_id
		) VALUES ($1, $2, $3, $4, ARRAY['platform_admin']::text[], 'create', 'tenant', $1, $5, $6)
	`, tenantID, actorID, actor.Name, actor.Email,
		"provisioned workspace "+slug+" (owner "+p.OwnerEmail+")", reqID(ctx)); err != nil {
		return uuid.Nil, "", err
	}

	return tenantID, slug, nil
}

func reqID(ctx context.Context) string {
	id, _ := appctx.RequestID(ctx)
	return id
}
