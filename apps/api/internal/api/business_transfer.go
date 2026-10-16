package api

// Stock transfers between branches: "send 5 L of milk from Sorakhutte to
// Thamel" (the central-kitchen pattern most multi-branch cafés run).
//
// A transfer is two stock movements with reason 'transfer' — out of the
// sending branch, into the receiving one — sharing ref_type 'branch_transfer'
// and one ref_id. Both are written in ONE transaction: the request tx is
// re-scoped to the receiving branch for its half and back again (the same
// technique provisionTenant uses), so a transfer can never leave stock gone
// from one branch and missing from the other.
//
// The receiving branch is matched by item NAME; if it has no such item yet,
// one is created (with the sender's unit, kind and pack rules) — the receiving
// branch just started stocking it.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

type transferLineReq struct {
	InventoryItemID uuid.UUID `json:"inventory_item_id"`
	QtyUnits        string    `json:"qty_units"`
}

type transferReq struct {
	To    string            `json:"to"` // branch slug or tenant id
	Lines []transferLineReq `json:"lines"`
	Note  string            `json:"note"`
}

type transferLine struct {
	Item          string    `json:"item"`
	SaleUnit      string    `json:"sale_unit"`
	QtyUnits      string    `json:"qty_units"`
	FromItemID    uuid.UUID `json:"from_item_id"`
	ToItemID      uuid.UUID `json:"to_item_id"`
	CreatedAtDest bool      `json:"created_at_destination"`
	UnitCostCents *int64    `json:"unit_cost_cents,omitempty"`
}

type transferResp struct {
	ID    uuid.UUID      `json:"id"`
	From  BranchStatus   `json:"from"`
	To    BranchStatus   `json:"to"`
	Lines []transferLine `json:"lines"`
}

// setScope re-points the RLS tenant of the running tx.
func setScope(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	_, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID.String())
	return err
}

// CreateStockTransfer — POST /v1/business/stock-transfers
//
// Sent from the SENDING branch (the active one; inventory:adjust there is the
// route gate). The receiving branch is re-checked with its own membership:
// inventory:adjust, plus inventory:create when an item has to be created
// there, its inventory feature, and its write lock.
func CreateStockTransfer(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body transferReq
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
			return
		}
		if len(body.Lines) == 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "add at least one item to send")
			return
		}
		seen := map[uuid.UUID]bool{}
		for i := range body.Lines {
			v, ok := requireNumeric(w, "qty_units", body.Lines[i].QtyUnits)
			if !ok {
				return
			}
			if strings.HasPrefix(v, "-") || strings.Trim(v, "0.") == "" {
				writeErr(w, http.StatusBadRequest, "bad_number", "quantities to send must be more than zero")
				return
			}
			if seen[body.Lines[i].InventoryItemID] {
				writeErr(w, http.StatusBadRequest, "bad_request", "each item can appear only once in a transfer")
				return
			}
			seen[body.Lines[i].InventoryItemID] = true
			body.Lines[i].QtyUnits = v
		}

		ctx := r.Context()
		tx := appctx.Tx(ctx)
		user, _ := appctx.UserFromContext(ctx)
		_, branches, err := loadMyBusiness(ctx, tx)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		var from, to *Branch
		for i := range branches {
			b := &branches[i]
			if b.IsActive {
				from = b
			} else if b.Slug == body.To || b.TenantID.String() == body.To {
				to = b
			}
		}
		if from == nil {
			writeErr(w, http.StatusBadRequest, "not_a_branch", "this café isn't a branch of a business")
			return
		}
		if to == nil {
			writeErr(w, http.StatusNotFound, "not_found", "pick a branch of this business to send to")
			return
		}

		// The receiving branch, as that branch's own request would see it.
		toCtx := appctx.WithTenant(ctx, appctx.Tenant{ID: to.TenantID, Slug: to.Slug, Name: to.Name, Timezone: to.Timezone})
		mctx, err := auth.LoadMember(toCtx, pool, repo, to.TenantID, user.ID)
		if errors.Is(err, auth.ErrNotMember) {
			writeErr(w, http.StatusForbidden, "forbidden", "you aren't a member of "+to.Name)
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		set, _ := appctx.Permissions(mctx)
		toPerms := rbac.PermissionSet{Set: set}
		if !toPerms.Has("inventory:adjust") {
			writeErr(w, http.StatusForbidden, "forbidden", "you can't adjust stock at "+to.Name)
			return
		}
		if st, ok := billing.StateFromContext(mctx); ok {
			if st.WriteLocked {
				writeErr(w, http.StatusConflict, "destination_locked", to.Name+" is read-only until its plan is sorted out")
				return
			}
			if !st.Has(billing.FeatureInventory) {
				writeErr(w, http.StatusForbidden, "plan_upgrade_required", to.Name+"'s plan doesn't include inventory")
				return
			}
		}

		// Every write happens inside a savepoint. TxMiddleware COMMITS a 4xx, so
		// without it a refusal on the receiving side (say, no permission to add
		// an item there) would leave stock gone from this branch and never
		// arrived at the other. Rolling the savepoint back also restores the
		// tenant scope.
		sp, err := tx.Begin(ctx)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		tx = sp
		fail := func(code int, kind, msg string) {
			_ = sp.Rollback(context.Background())
			writeErr(w, code, kind, msg)
		}

		transferID := uuid.New()
		note := strings.TrimSpace(body.Note)
		withNote := func(s string) string {
			if note == "" {
				return s
			}
			return s + " — " + note
		}

		// 1) Sending side (tx is scoped to the active branch).
		type packRule struct {
			containerUnit, saleUnit string
			containerQty, perPack   int
		}
		type srcItem struct {
			name, sku, kind, saleUnit string
			par                       *string
			cost                      *int64
			packs                     []packRule
		}
		lines := make([]transferLine, 0, len(body.Lines))
		srcs := make([]srcItem, 0, len(body.Lines))
		for _, l := range body.Lines {
			var it srcItem
			var enough bool
			err := tx.QueryRow(ctx, `
				SELECT name, COALESCE(sku, ''), kind::text, sale_unit, par_low_units::text,
				       last_purchase_unit_cost_cents, qty_on_hand_units >= $2::numeric
				FROM inventory_items
				WHERE id = $1 AND deleted_at IS NULL
				FOR UPDATE
			`, l.InventoryItemID, l.QtyUnits).Scan(&it.name, &it.sku, &it.kind, &it.saleUnit, &it.par, &it.cost, &enough)
			if errors.Is(err, pgx.ErrNoRows) {
				fail(http.StatusNotFound, "not_found", "an item in this transfer isn't in this branch's inventory")
				return
			}
			if err != nil {
				fail(http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if !enough {
				fail(http.StatusConflict, "insufficient_stock",
					fmt.Sprintf("not enough %s on hand to send %s %s", it.name, l.QtyUnits, it.saleUnit))
				return
			}
			// Pack rules, read now — once the tx is re-scoped below, RLS hides them.
			prows, err := tx.Query(ctx, `
				SELECT container_unit, container_qty, sale_unit, sale_qty_per_container
				FROM pack_rules WHERE inventory_item_id = $1`, l.InventoryItemID)
			if err != nil {
				fail(http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			for prows.Next() {
				var p packRule
				if err := prows.Scan(&p.containerUnit, &p.containerQty, &p.saleUnit, &p.perPack); err != nil {
					prows.Close()
					fail(http.StatusInternalServerError, "internal_error", err.Error())
					return
				}
				it.packs = append(it.packs, p)
			}
			prows.Close()
			if _, err := tx.Exec(ctx, `
				INSERT INTO stock_movements (tenant_id, inventory_item_id, delta_units, reason, ref_type, ref_id, unit_cost_cents, notes, by_user_id)
				VALUES ($1, $2, -($3::numeric), 'transfer', 'branch_transfer', $4, $5, $6, $7)
			`, from.TenantID, l.InventoryItemID, l.QtyUnits, transferID, it.cost, withNote("Sent to "+to.Name), user.ID); err != nil {
				fail(http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			srcs = append(srcs, it)
			lines = append(lines, transferLine{Item: it.name, SaleUnit: it.saleUnit, QtyUnits: l.QtyUnits,
				FromItemID: l.InventoryItemID, UnitCostCents: it.cost})
		}

		// 2) Receiving side, in the same tx re-scoped to the other branch.
		if err := setScope(ctx, tx, to.TenantID); err != nil {
			fail(http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		for i, it := range srcs {
			var destID uuid.UUID
			err := tx.QueryRow(ctx,
				`SELECT id FROM inventory_items WHERE lower(name) = lower($1) AND deleted_at IS NULL`, it.name,
			).Scan(&destID)
			if errors.Is(err, pgx.ErrNoRows) {
				if !toPerms.Has("inventory:create") {
					fail(http.StatusForbidden, "forbidden",
						fmt.Sprintf("%s doesn't stock %s yet, and you can't add inventory items there", to.Name, it.name))
					return
				}
				if err := tx.QueryRow(ctx, `
					INSERT INTO inventory_items (tenant_id, name, sku, kind, sale_unit, par_low_units)
					VALUES ($1, $2, NULLIF($3, ''), $4::inventory_item_kind, $5, COALESCE($6::numeric, 0))
					RETURNING id
				`, to.TenantID, it.name, it.sku, it.kind, it.saleUnit, it.par).Scan(&destID); err != nil {
					fail(http.StatusInternalServerError, "internal_error", err.Error())
					return
				}
				// Same packs as the sender, so "1 crate" means the same thing there.
				for _, p := range it.packs {
					if _, err := tx.Exec(ctx, `
						INSERT INTO pack_rules (tenant_id, inventory_item_id, container_unit, container_qty, sale_unit, sale_qty_per_container)
						VALUES ($1, $2, $3, $4, $5, $6)
					`, to.TenantID, destID, p.containerUnit, p.containerQty, p.saleUnit, p.perPack); err != nil {
						fail(http.StatusInternalServerError, "internal_error", err.Error())
						return
					}
				}
				lines[i].CreatedAtDest = true
			} else if err != nil {
				fail(http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO stock_movements (tenant_id, inventory_item_id, delta_units, reason, ref_type, ref_id, unit_cost_cents, notes, by_user_id)
				VALUES ($1, $2, $3::numeric, 'transfer', 'branch_transfer', $4, $5, $6, $7)
			`, to.TenantID, destID, lines[i].QtyUnits, transferID, it.cost, withNote("Received from "+from.Name), user.ID); err != nil {
				fail(http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			lines[i].ToItemID = destID
		}
		summary := transferSummary(lines)
		if err := audit.Log(appctx.WithTx(mctx, tx), tx, audit.Entry{Action: "create", Entity: "stock_transfer",
			EntityID: &transferID, Summary: "received from " + from.Name + ": " + summary}); err != nil {
			fail(http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// 3) Back to the sending branch for the rest of the request.
		if err := setScope(ctx, tx, from.TenantID); err != nil {
			fail(http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if err := audit.Log(ctx, tx, audit.Entry{Action: "create", Entity: "stock_transfer",
			EntityID: &transferID, Summary: "sent to " + to.Name + ": " + summary}); err != nil {
			fail(http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := sp.Commit(ctx); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, transferResp{
			ID:    transferID,
			From:  BranchStatus{TenantID: from.TenantID, Slug: from.Slug, Name: from.Name, Timezone: from.Timezone, Status: branchOK},
			To:    BranchStatus{TenantID: to.TenantID, Slug: to.Slug, Name: to.Name, Timezone: to.Timezone, Status: branchOK},
			Lines: lines,
		})
	}
}

func transferSummary(lines []transferLine) string {
	parts := make([]string, len(lines))
	for i, l := range lines {
		parts[i] = fmt.Sprintf("%s %s %s", l.QtyUnits, l.SaleUnit, audit.Quote(l.Item))
	}
	return strings.Join(parts, ", ")
}

// TransferRow is one transfer as this branch saw it.
type TransferRow struct {
	ID        uuid.UUID         `json:"id"`
	At        time.Time         `json:"at"`
	Direction string            `json:"direction"` // in | out
	Note      string            `json:"note"`
	Lines     []TransferRowLine `json:"lines"`
}

type TransferRowLine struct {
	Item     string `json:"item"`
	SaleUnit string `json:"sale_unit"`
	QtyUnits string `json:"qty_units"`
}

// ListStockTransfers — GET /v1/business/stock-transfers?limit=
// This branch's transfers in and out, newest first.
func ListStockTransfers(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT m.ref_id, m.at, m.delta_units > 0, m.notes, i.name, i.sale_unit, abs(m.delta_units)::text
		FROM stock_movements m
		JOIN inventory_items i ON i.id = m.inventory_item_id
		WHERE m.ref_type = 'branch_transfer'
		  AND m.ref_id IN (
		    SELECT ref_id FROM stock_movements
		    WHERE ref_type = 'branch_transfer'
		    GROUP BY ref_id ORDER BY max(at) DESC LIMIT 50)
		ORDER BY m.at DESC, i.name
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()
	out := []TransferRow{}
	idx := map[uuid.UUID]int{}
	for rows.Next() {
		var id uuid.UUID
		var at time.Time
		var in bool
		var note string
		var l TransferRowLine
		if err := rows.Scan(&id, &at, &in, &note, &l.Item, &l.SaleUnit, &l.QtyUnits); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		i, ok := idx[id]
		if !ok {
			dir := "out"
			if in {
				dir = "in"
			}
			i = len(out)
			idx[id] = i
			out = append(out, TransferRow{ID: id, At: at, Direction: dir, Note: note, Lines: []TransferRowLine{}})
		}
		out[i].Lines = append(out[i].Lines, l)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"transfers": out})
}
