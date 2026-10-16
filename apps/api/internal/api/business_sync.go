package api

// Menu sync across branches: push the active branch's menu to its siblings.
//
// It is the bulk import (applyMenuImport) run once per target branch, in that
// branch's own transaction, behind that branch's own permissions and write
// lock. Matching is by name, nothing is ever deleted, and by default each
// branch keeps its own prices — a branch can charge more in a tourist area
// without the next sync undoing it.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/db"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

type menuSyncReq struct {
	Targets       []string `json:"targets"` // branch slugs or tenant ids
	IncludePrices bool     `json:"include_prices"`
	DryRun        bool     `json:"dry_run"`
	// Opt-in extras (business_sync_extras.go).
	Photos   bool `json:"photos"`
	Stations bool `json:"stations"`
	AddOns   bool `json:"add_ons"`
}

type syncTarget struct {
	TenantID uuid.UUID     `json:"tenant_id"`
	Slug     string        `json:"slug"`
	Name     string        `json:"name"`
	Status   string        `json:"status"` // ok | forbidden | write_locked | not_found | error
	Error    string        `json:"error,omitempty"`
	Result   importResult  `json:"result"`
	Extras   *extrasResult `json:"extras,omitempty"`
}

// notSynced is a source item that can't be pushed as-is (e.g. a free item —
// the import refuses a zero price), reported instead of failing the sync.
type notSynced struct {
	Category string `json:"category"`
	Item     string `json:"item"`
	Reason   string `json:"reason"`
}

type menuSyncResp struct {
	DryRun    bool         `json:"dry_run"`
	Source    BranchStatus `json:"source"`
	Targets   []syncTarget `json:"targets"`
	NotSynced []notSynced  `json:"not_synced"`
}

// loadSourceMenu reads the active branch's live menu (active, not deleted)
// in the import's shape, setting aside anything the import would refuse.
func loadSourceMenu(ctx context.Context, tx pgx.Tx) ([]bulkImportCategory, []notSynced, error) {
	rows, err := tx.Query(ctx, `
		SELECT c.name, COALESCE(c.icon, ''), c.color, c.kitchen_behavior,
		       i.name, COALESCE(i.description, ''), COALESCE(i.icon, ''), i.kitchen_behavior,
		       i.price_cents, i.cost_cents
		FROM menu_categories c
		JOIN menu_items i ON i.category_id = c.id AND i.deleted_at IS NULL AND i.is_active
		WHERE c.deleted_at IS NULL AND c.is_active
		ORDER BY c.sort, c.name, i.sort, i.name
	`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var cats []bulkImportCategory
	idx := map[string]int{}
	skipped := []notSynced{}
	for rows.Next() {
		var c bulkImportCategory
		var it bulkImportItem
		if err := rows.Scan(&c.Name, &c.Icon, &c.Color, &c.KitchenBehavior,
			&it.Name, &it.Description, &it.Icon, &it.KitchenBehavior, &it.PriceCents, &it.CostCents); err != nil {
			return nil, nil, err
		}
		if it.PriceCents <= 0 {
			skipped = append(skipped, notSynced{Category: c.Name, Item: it.Name, Reason: "free items can't be synced yet — add them in each branch"})
			continue
		}
		if _, ok := nameInput(it.Name); !ok {
			skipped = append(skipped, notSynced{Category: c.Name, Item: it.Name, Reason: "the name needs tidying first"})
			continue
		}
		key := strings.ToLower(c.Name)
		i, ok := idx[key]
		if !ok {
			i = len(cats)
			idx[key] = i
			cats = append(cats, c)
		}
		cats[i].Items = append(cats[i].Items, it)
	}
	return cats, skipped, rows.Err()
}

// syncIntoBranch applies the menu to one branch as that branch's own write.
//
// A preview (o.DryRun) does the same writes inside the branch's transaction
// and rolls them back, so it reports exactly what a real sync would do —
// including add-ons attached to items the sync itself creates.
func syncIntoBranch(base context.Context, pool *pgxpool.Pool, repo *rbac.Repo, userID uuid.UUID, br Branch, cats []bulkImportCategory, o importOpts, extras menuExtras, xo syncExtrasOpts) syncTarget {
	out := syncTarget{TenantID: br.TenantID, Slug: br.Slug, Name: br.Name}
	ctx := appctx.WithTenant(base, appctx.Tenant{ID: br.TenantID, Slug: br.Slug, Name: br.Name, Timezone: br.Timezone})
	mctx, err := auth.LoadMember(ctx, pool, repo, br.TenantID, userID)
	if errors.Is(err, auth.ErrNotMember) {
		out.Status = branchDenied
		return out
	}
	if err != nil {
		out.Status, out.Error = branchError, err.Error()
		return out
	}
	set, _ := appctx.Permissions(mctx)
	ps := rbac.PermissionSet{Set: set}
	if !ps.Has("menu:create") || !ps.Has("menu:update") {
		out.Status = branchDenied
		return out
	}
	if st, ok := billing.StateFromContext(mctx); ok && st.WriteLocked {
		out.Status = "write_locked"
		return out
	}

	tx, err := db.BeginScopedTx(mctx, pool, br.TenantID, userID, pgx.TxOptions{})
	if err != nil {
		out.Status, out.Error = branchError, err.Error()
		return out
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	wctx := appctx.WithPostCommit(appctx.WithTx(mctx, tx))
	dryRun := o.DryRun
	o.DryRun = false // write for real; a preview rolls back below
	res, err := applyMenuImport(wctx, tx, br.TenantID, cats, o)
	if err != nil {
		out.Status, out.Error = branchError, err.Error()
		return out
	}
	out.Result = res
	if xo.any() {
		x, err := applyMenuExtras(wctx, tx, br.TenantID, extras, xo, o.KeepTargetPrice)
		if err != nil {
			out.Status, out.Error = branchError, err.Error()
			return out
		}
		out.Extras = &x
	}
	out.Status = branchOK
	if dryRun {
		return out // deferred rollback discards the writes
	}
	if err := audit.Log(wctx, tx, audit.Entry{Action: "import", Entity: "menu", Summary: res.summary("menu synced from another branch")}); err != nil {
		out.Status, out.Error = branchError, err.Error()
		return out
	}
	if err := tx.Commit(wctx); err != nil {
		out.Status, out.Error = branchError, err.Error()
		return out
	}
	appctx.RunPostCommit(wctx)
	return out
}

// SyncBusinessMenu — POST /v1/business/menu/sync
//
// Body: {targets: [slug…], include_prices, dry_run}. Targets are synced one at
// a time, each in its own transaction: one locked or forbidden branch doesn't
// stop the others, and a failure in one never half-applies another.
func SyncBusinessMenu(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body menuSyncReq
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
			return
		}
		if len(body.Targets) == 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "pick at least one branch to sync to")
			return
		}
		ctx := r.Context()
		tx := appctx.Tx(ctx)
		_, branches, err := loadMyBusiness(ctx, tx)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		var source *Branch
		for i := range branches {
			if branches[i].IsActive {
				source = &branches[i]
			}
		}
		if source == nil {
			writeErr(w, http.StatusBadRequest, "not_a_branch", "this café isn't a branch of a business")
			return
		}

		cats, skipped, err := loadSourceMenu(ctx, tx)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		xo := syncExtrasOpts{Photos: body.Photos, Stations: body.Stations, AddOns: body.AddOns}
		var extras menuExtras
		if xo.any() {
			if extras, err = loadMenuExtras(ctx, tx); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}
		resp := menuSyncResp{
			DryRun:    body.DryRun,
			Source:    BranchStatus{TenantID: source.TenantID, Slug: source.Slug, Name: source.Name, Timezone: source.Timezone, Status: branchOK},
			Targets:   []syncTarget{},
			NotSynced: skipped,
		}
		if len(cats) > 0 {
			// Validate once, before any branch is touched; the source is
			// already-stored data, so this only fails on a real bug.
			if cats, err = normalizeImport(cats); err != nil {
				writeErr(w, http.StatusUnprocessableEntity, "source_menu_invalid", err.Error())
				return
			}
		}

		user, _ := appctx.UserFromContext(ctx)
		opts := importOpts{Overwrite: true, DryRun: body.DryRun, KeepTargetPrice: !body.IncludePrices, Diff: true}
		targets, missing := selectBranches(branches, strings.Join(body.Targets, ","))
		for _, m := range missing {
			resp.Targets = append(resp.Targets, syncTarget{Slug: m.Slug, Status: branchNotFound})
		}
		for _, br := range targets {
			if br.TenantID == source.TenantID {
				continue // syncing a branch into itself is a no-op
			}
			if len(cats) == 0 {
				resp.Targets = append(resp.Targets, syncTarget{TenantID: br.TenantID, Slug: br.Slug, Name: br.Name, Status: branchOK})
				continue
			}
			resp.Targets = append(resp.Targets, syncIntoBranch(ctx, pool, repo, user.ID, br, cats, opts, extras, xo))
		}

		if !body.DryRun {
			synced := 0
			for _, t := range resp.Targets {
				if t.Status == branchOK {
					synced++
				}
			}
			if err := audit.Log(ctx, tx, audit.Entry{Action: "export", Entity: "menu",
				Summary: "menu pushed to " + pluralBranches(synced)}); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func pluralBranches(n int) string {
	if n == 1 {
		return "1 branch"
	}
	return fmt.Sprintf("%d branches", n)
}
