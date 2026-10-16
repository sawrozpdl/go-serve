package api

// Multi-branch (0088). A business groups several tenants; each is a branch
// with its own data, RLS scope and money. Everything here is anchored on the
// ACTIVE tenant (the request's X-Tenant-ID): the business is the anchor's, and
// the branches are the ones the caller is an active member of — resolved by
// my_business_branches(), which cannot be pointed at anyone else's business.

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// BusinessInfo names the business the active branch belongs to.
type BusinessInfo struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// BranchCan is what the caller may do in a branch, for the switcher and the
// all-branches view. Loaded per branch, so a custom role is honoured exactly.
type BranchCan struct {
	ReportRead  bool `json:"report_read"`
	FinanceRead bool `json:"finance_read"`
	MenuUpdate  bool `json:"menu_update"`
}

// Branch is one tenant of the active business that the caller can enter.
type Branch struct {
	TenantID uuid.UUID  `json:"tenant_id"`
	Slug     string     `json:"slug"`
	Name     string     `json:"name"`
	Timezone string     `json:"timezone"`
	Roles    []string   `json:"roles"`
	IsActive bool       `json:"is_active"`
	Can      *BranchCan `json:"can,omitempty"`
}

// loadMyBusiness returns the active tenant's business and the branches the
// caller belongs to. A standalone café returns (nil, nil, nil).
func loadMyBusiness(ctx context.Context, tx pgx.Tx) (*BusinessInfo, []Branch, error) {
	rows, err := tx.Query(ctx, `
		SELECT tenant_id, slug, name, timezone, business_id, business_name, roles, is_anchor
		FROM my_business_branches()
	`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var biz *BusinessInfo
	branches := []Branch{}
	for rows.Next() {
		var b Branch
		var bi BusinessInfo
		if err := rows.Scan(&b.TenantID, &b.Slug, &b.Name, &b.Timezone, &bi.ID, &bi.Name, &b.Roles, &b.IsActive); err != nil {
			return nil, nil, err
		}
		if biz == nil {
			biz = &bi
		}
		branches = append(branches, b)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if biz == nil {
		return nil, nil, nil
	}
	return biz, branches, nil
}

// GetBusinessBranches — GET /v1/business/branches
//
// The active business and every branch the caller can enter, each with what
// the caller may do there. Standalone café → {business: null, branches: []}.
func GetBusinessBranches(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		biz, branches, err := loadMyBusiness(ctx, appctx.Tx(ctx))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if biz == nil {
			writeJSON(w, http.StatusOK, map[string]any{"business": nil, "branches": []Branch{}})
			return
		}
		user, _ := appctx.UserFromContext(ctx)
		for i := range branches {
			mctx, err := auth.LoadMember(ctx, pool, repo, branches[i].TenantID, user.ID)
			if err != nil {
				// Membership changed between the two reads, or a DB blip: the
				// branch stays listed (they are a member) with nothing allowed.
				branches[i].Can = &BranchCan{}
				continue
			}
			set, _ := appctx.Permissions(mctx)
			ps := rbac.PermissionSet{Set: set}
			branches[i].Can = &BranchCan{
				ReportRead:  ps.Has("report:read"),
				FinanceRead: ps.Has("finance:read"),
				MenuUpdate:  ps.Has("menu:update"),
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"business": biz, "branches": branches})
	}
}
