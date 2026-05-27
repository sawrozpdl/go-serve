package rbac

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Role is a tenant-scoped role row.
type Role struct {
	ID          uuid.UUID
	TenantID    uuid.UUID
	Key         string
	Name        string
	Description string
	IsSystem    bool
	Permissions []string // grant strings (exact, "resource:*", or "*:*")
	MemberCount int      // populated by List
}

// Repo is the data-access surface for RBAC. All callers must supply an
// already-open transaction (or a pool when no tx exists) — the live
// request flow runs inside the request-scoped tx so RLS is satisfied.
type Repo struct {
	pool  *pgxpool.Pool
	cache *Cache
}

func NewRepo(pool *pgxpool.Pool, cache *Cache) *Repo {
	if cache == nil {
		cache = NewCache(4096)
	}
	return &Repo{pool: pool, cache: cache}
}

// Cache returns the underlying cache. Test helper.
func (r *Repo) Cache() *Cache { return r.cache }

// LoadForMember loads the permission set for (tenantID, userID), reading
// tenants.roles_version first. If the cache holds an entry at the same
// version, that's returned. Otherwise a single query joins
// tenant_member_roles → roles → role_permissions and the result is cached.
//
// Caller passes a connection — typically the request tx — which already
// has app.tenant_id / app.user_id set for RLS. We do NOT open our own tx.
func (r *Repo) LoadForMember(ctx context.Context, tx pgx.Tx, tenantID, userID uuid.UUID) (PermissionSet, error) {
	var version int64
	if err := tx.QueryRow(ctx,
		`SELECT roles_version FROM tenants WHERE id = $1`, tenantID,
	).Scan(&version); err != nil {
		return PermissionSet{}, fmt.Errorf("rbac: read roles_version: %w", err)
	}
	if ps, ok := r.cache.Get(tenantID, userID, version); ok {
		return ps, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT r.key, rp.permission
		FROM tenant_member_roles tmr
		JOIN roles r ON r.id = tmr.role_id
		JOIN role_permissions rp ON rp.role_id = r.id
		WHERE tmr.tenant_id = $1 AND tmr.user_id = $2
	`, tenantID, userID)
	if err != nil {
		return PermissionSet{}, fmt.Errorf("rbac: load grants: %w", err)
	}
	defer rows.Close()
	set := make(map[string]struct{}, 32)
	roleSet := make(map[string]struct{}, 4)
	for rows.Next() {
		var roleKey, perm string
		if err := rows.Scan(&roleKey, &perm); err != nil {
			return PermissionSet{}, fmt.Errorf("rbac: scan grant: %w", err)
		}
		set[perm] = struct{}{}
		roleSet[roleKey] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return PermissionSet{}, fmt.Errorf("rbac: iter grants: %w", err)
	}
	roles := make([]string, 0, len(roleSet))
	for k := range roleSet {
		roles = append(roles, k)
	}
	sort.Strings(roles)
	ps := PermissionSet{Version: version, Set: set, Roles: roles}
	r.cache.Put(tenantID, userID, ps)
	return ps, nil
}

// ErrNotFound is returned by single-row lookups when no row matches.
var ErrNotFound = errors.New("rbac: not found")

// ErrOwnerImmutable is returned when a caller tries to edit or remove
// the system owner role / its permissions.
var ErrOwnerImmutable = errors.New("rbac: owner role is immutable")

// ErrRoleHasMembers is returned when a caller tries to delete a role
// that still has members assigned to it.
var ErrRoleHasMembers = errors.New("rbac: role has members assigned")

// List returns every role in the tenant (system first, then custom by
// name), populated with grants + member counts.
func (r *Repo) List(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) ([]Role, error) {
	rows, err := tx.Query(ctx, `
		SELECT r.id, r.key, r.name, r.description, r.is_system,
		       COALESCE(array_agg(DISTINCT rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS perms,
		       COALESCE((SELECT count(*) FROM tenant_member_roles tmr WHERE tmr.role_id = r.id), 0) AS member_count
		FROM roles r
		LEFT JOIN role_permissions rp ON rp.role_id = r.id
		WHERE r.tenant_id = $1
		GROUP BY r.id
		ORDER BY r.is_system DESC,
		         CASE r.key WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'waiter' THEN 2 WHEN 'kitchen' THEN 3 ELSE 4 END,
		         r.name
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("rbac: list roles: %w", err)
	}
	defer rows.Close()
	out := []Role{}
	for rows.Next() {
		var role Role
		role.TenantID = tenantID
		if err := rows.Scan(&role.ID, &role.Key, &role.Name, &role.Description, &role.IsSystem, &role.Permissions, &role.MemberCount); err != nil {
			return nil, fmt.Errorf("rbac: scan role: %w", err)
		}
		sort.Strings(role.Permissions)
		out = append(out, role)
	}
	return out, rows.Err()
}

// Get fetches a single role with grants.
func (r *Repo) Get(ctx context.Context, tx pgx.Tx, tenantID, roleID uuid.UUID) (Role, error) {
	var role Role
	role.TenantID = tenantID
	err := tx.QueryRow(ctx, `
		SELECT r.id, r.key, r.name, r.description, r.is_system,
		       COALESCE(array_agg(DISTINCT rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS perms,
		       COALESCE((SELECT count(*) FROM tenant_member_roles tmr WHERE tmr.role_id = r.id), 0) AS member_count
		FROM roles r
		LEFT JOIN role_permissions rp ON rp.role_id = r.id
		WHERE r.tenant_id = $1 AND r.id = $2
		GROUP BY r.id
	`, tenantID, roleID).Scan(&role.ID, &role.Key, &role.Name, &role.Description, &role.IsSystem, &role.Permissions, &role.MemberCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, err
	}
	sort.Strings(role.Permissions)
	return role, nil
}

// Create inserts a new custom role (is_system = false) with the supplied
// grants. The owner role can never be created via this path — the seed
// migration is the only way.
func (r *Repo) Create(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, key, name, description string, grants []string) (Role, error) {
	if key == "owner" {
		return Role{}, ErrOwnerImmutable
	}
	for _, g := range grants {
		if err := M.ValidateGrant(g); err != nil {
			return Role{}, err
		}
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO roles (tenant_id, key, name, description, is_system)
		VALUES ($1, $2, $3, $4, false)
		RETURNING id
	`, tenantID, key, name, description).Scan(&id)
	if err != nil {
		return Role{}, fmt.Errorf("rbac: create role: %w", err)
	}
	if err := r.replaceGrants(ctx, tx, id, grants); err != nil {
		return Role{}, err
	}
	return r.Get(ctx, tx, tenantID, id)
}

// Update edits a role's display fields and grants. The owner row's
// metadata + grants cannot be changed. For other system roles, the
// caller can change name/description/grants but not the key or
// is_system flag.
func (r *Repo) Update(ctx context.Context, tx pgx.Tx, tenantID, roleID uuid.UUID, name *string, description *string, grants *[]string) (Role, error) {
	existing, err := r.Get(ctx, tx, tenantID, roleID)
	if err != nil {
		return Role{}, err
	}
	if existing.IsSystem && existing.Key == "owner" {
		return Role{}, ErrOwnerImmutable
	}
	if grants != nil {
		for _, g := range *grants {
			if err := M.ValidateGrant(g); err != nil {
				return Role{}, err
			}
		}
	}
	setName := existing.Name
	if name != nil {
		setName = *name
	}
	setDesc := existing.Description
	if description != nil {
		setDesc = *description
	}
	if _, err := tx.Exec(ctx, `
		UPDATE roles SET name = $3, description = $4
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, roleID, setName, setDesc); err != nil {
		return Role{}, fmt.Errorf("rbac: update role: %w", err)
	}
	if grants != nil {
		if err := r.replaceGrants(ctx, tx, roleID, *grants); err != nil {
			return Role{}, err
		}
	}
	return r.Get(ctx, tx, tenantID, roleID)
}

// Delete removes a role. The owner row is protected by DB trigger; any
// other system role can be removed, but only if zero members hold it.
// Returns ErrRoleHasMembers when members are still assigned.
func (r *Repo) Delete(ctx context.Context, tx pgx.Tx, tenantID, roleID uuid.UUID) error {
	existing, err := r.Get(ctx, tx, tenantID, roleID)
	if err != nil {
		return err
	}
	if existing.IsSystem && existing.Key == "owner" {
		return ErrOwnerImmutable
	}
	if existing.MemberCount > 0 {
		return ErrRoleHasMembers
	}
	if _, err := tx.Exec(ctx, `DELETE FROM roles WHERE tenant_id = $1 AND id = $2`, tenantID, roleID); err != nil {
		return fmt.Errorf("rbac: delete role: %w", err)
	}
	return nil
}

// AssignMemberRoles replaces a member's role assignments wholesale to
// the supplied set of role IDs. Used by the team-management UI.
func (r *Repo) AssignMemberRoles(ctx context.Context, tx pgx.Tx, tenantID, userID uuid.UUID, roleIDs []uuid.UUID) error {
	for _, rid := range roleIDs {
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM roles WHERE tenant_id = $1 AND id = $2)`,
			tenantID, rid,
		).Scan(&exists); err != nil {
			return fmt.Errorf("rbac: verify role: %w", err)
		}
		if !exists {
			return fmt.Errorf("rbac: role %s not in tenant", rid)
		}
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM tenant_member_roles WHERE tenant_id = $1 AND user_id = $2`,
		tenantID, userID,
	); err != nil {
		return fmt.Errorf("rbac: clear member roles: %w", err)
	}
	for _, rid := range roleIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO tenant_member_roles (tenant_id, user_id, role_id)
			VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING
		`, tenantID, userID, rid); err != nil {
			return fmt.Errorf("rbac: insert member role: %w", err)
		}
	}
	return nil
}

// SeedSystemRoles creates the four default roles for a freshly created
// tenant from the manifest. Called from the tenant-creation flow inside
// the same tx that inserts the tenant row.
func (r *Repo) SeedSystemRoles(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (map[string]uuid.UUID, error) {
	out := make(map[string]uuid.UUID, len(M.SystemRoles))
	for _, sr := range M.SystemRoles {
		var id uuid.UUID
		err := tx.QueryRow(ctx, `
			INSERT INTO roles (tenant_id, key, name, description, is_system)
			VALUES ($1, $2, $3, $4, true)
			RETURNING id
		`, tenantID, sr.Key, sr.Name, sr.Description).Scan(&id)
		if err != nil {
			return nil, fmt.Errorf("rbac: seed role %s: %w", sr.Key, err)
		}
		for _, g := range sr.Permissions {
			if _, err := tx.Exec(ctx, `
				INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)
			`, id, g); err != nil {
				return nil, fmt.Errorf("rbac: seed grant %s for %s: %w", g, sr.Key, err)
			}
		}
		out[sr.Key] = id
	}
	return out, nil
}

// LookupRoleByKey returns the role row for (tenantID, key). Used by the
// invite-acceptance flow to map a stored role key onto a real role row.
func (r *Repo) LookupRoleByKey(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, key string) (Role, error) {
	var id uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM roles WHERE tenant_id = $1 AND key = $2`,
		tenantID, key,
	).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Role{}, ErrNotFound
		}
		return Role{}, err
	}
	return r.Get(ctx, tx, tenantID, id)
}

func (r *Repo) replaceGrants(ctx context.Context, tx pgx.Tx, roleID uuid.UUID, grants []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, roleID); err != nil {
		return fmt.Errorf("rbac: clear grants: %w", err)
	}
	seen := make(map[string]struct{}, len(grants))
	for _, g := range grants {
		if _, dup := seen[g]; dup {
			continue
		}
		seen[g] = struct{}{}
		if _, err := tx.Exec(ctx,
			`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
			roleID, g,
		); err != nil {
			return fmt.Errorf("rbac: insert grant: %w", err)
		}
	}
	return nil
}
