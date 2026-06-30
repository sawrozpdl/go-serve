package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// =========================================================================
// BULK MENU IMPORT
// =========================================================================
//
// One transactional upsert of an entire menu (categories + their items) from a
// reviewed JSON payload — the back end of the "copy a prompt → ChatGPT reads
// your menu photo → paste the JSON" onboarding flow. Matching is by name:
// categories by lower(name) (their tenant-unique key), items by
// (category, lower(name)). A match is updated when overwrite_existing is set
// (the default) and otherwise left untouched; everything else is created.
// Nothing is ever deleted — re-running an import is safe and idempotent.
//
// dry_run runs the full match + validation pass and returns the NEW/UPDATE/SKIP
// tally WITHOUT writing, which powers the per-row badges in the review step.
//
// The whole handler runs in one transaction that commits only on status < 500
// (see db.TxMiddleware), so a 4xx still commits. We therefore validate the
// ENTIRE payload up front and only start writing once it is known-good — a bad
// row deep in the list can never leave a half-imported menu behind.

const (
	maxImportCategories = 100
	maxImportItems      = 1000
)

type bulkImportItem struct {
	Name            string `json:"name"`
	Description     string `json:"description"`
	Icon            string `json:"icon"`
	KitchenBehavior string `json:"kitchen_behavior"`
	PriceCents      int64  `json:"price_cents"`
	CostCents       *int64 `json:"cost_cents"`
}

type bulkImportCategory struct {
	Name            string           `json:"name"`
	Icon            string           `json:"icon"`
	Color           *string          `json:"color"`
	KitchenBehavior string           `json:"kitchen_behavior"`
	Items           []bulkImportItem `json:"items"`
}

type bulkImportReq struct {
	DryRun bool `json:"dry_run"`
	// OverwriteExisting controls what happens to a name that already exists.
	// Pointer so an absent key defaults to true (the friendly upsert default)
	// rather than to the bool zero value.
	OverwriteExisting *bool                `json:"overwrite_existing"`
	Categories        []bulkImportCategory `json:"categories"`
}

// bulkCounts is the per-entity NEW/UPDATE/SKIP tally returned to the FE.
type bulkCounts struct {
	Created int `json:"created"`
	Updated int `json:"updated"`
	Skipped int `json:"skipped"`
}

type bulkImportResp struct {
	DryRun     bool       `json:"dry_run"`
	Categories bulkCounts `json:"categories"`
	Items      bulkCounts `json:"items"`
}

// BulkImportMenu upserts a whole menu (categories + items) in one transaction.
func BulkImportMenu(w http.ResponseWriter, r *http.Request) {
	t, ok := appctx.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	var body bulkImportReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	overwrite := body.OverwriteExisting == nil || *body.OverwriteExisting

	// Collapse duplicate names within the request and validate everything
	// before touching the database (see the commit-on-4xx note above). The
	// merge also avoids a unique-constraint 500 from two same-named categories.
	cats, err := normalizeImport(body.Categories)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "menu.bulk_import",
		"categories", len(cats), "dry_run", body.DryRun, "overwrite", overwrite)

	tx := appctx.Tx(r.Context())
	ctx := r.Context()

	var catCounts, itemCounts bulkCounts

	// Sort base for newly created categories so they append after the existing
	// ones in display order.
	catSort, err := nextSort(ctx, tx, `SELECT COALESCE(MAX(sort), -1) + 1 FROM menu_categories WHERE deleted_at IS NULL`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	for _, c := range cats {
		// Resolve the category: find an existing one by name, otherwise create
		// it (skipping the write in dry-run). catID is uuid.Nil only for a new
		// category in dry-run — in which case all its items are new by
		// definition and we never read or write them.
		var catID uuid.UUID
		existing := false
		if err := tx.QueryRow(ctx,
			`SELECT id FROM menu_categories WHERE lower(name) = lower($1) AND deleted_at IS NULL`,
			c.Name).Scan(&catID); err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		} else {
			existing = true
		}

		switch {
		case existing && overwrite:
			catCounts.Updated++
			if !body.DryRun {
				if _, err := tx.Exec(ctx, `
					UPDATE menu_categories SET
						icon             = COALESCE(NULLIF($2, ''), icon),
						color            = COALESCE($3, color),
						kitchen_behavior = $4
					WHERE id = $1
				`, catID, c.Icon, c.Color, c.KitchenBehavior); err != nil {
					writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
					return
				}
			}
		case existing:
			catCounts.Skipped++
		default:
			catCounts.Created++
			if !body.DryRun {
				if err := tx.QueryRow(ctx, `
					INSERT INTO menu_categories (tenant_id, name, sort, color, icon, kitchen_behavior)
					VALUES ($1, $2, $3, $4, $5, $6)
					RETURNING id
				`, t.ID, c.Name, catSort, c.Color, c.Icon, c.KitchenBehavior).Scan(&catID); err != nil {
					writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
					return
				}
			}
			catSort++
		}

		// Item sort base within this category (new categories start at 0).
		itemSort := 0
		if existing {
			itemSort, err = nextSort(ctx, tx,
				`SELECT COALESCE(MAX(sort), -1) + 1 FROM menu_items WHERE category_id = $1 AND deleted_at IS NULL`, catID)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}

		for _, it := range c.Items {
			var itemID uuid.UUID
			itemExists := false
			if existing { // only an existing category can hold existing items
				if err := tx.QueryRow(ctx,
					`SELECT id FROM menu_items WHERE category_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`,
					catID, it.Name).Scan(&itemID); err != nil {
					if !errors.Is(err, pgx.ErrNoRows) {
						writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
						return
					}
				} else {
					itemExists = true
				}
			}

			switch {
			case itemExists && overwrite:
				itemCounts.Updated++
				if !body.DryRun {
					// Update the reviewed fields; preserve operator-managed state
					// (is_active, is_featured, image_url, sku, modifiers, presets).
					if _, err := tx.Exec(ctx, `
						UPDATE menu_items SET
							price_cents      = $2,
							description      = $3,
							cost_cents       = COALESCE($4, cost_cents),
							icon             = COALESCE(NULLIF($5, ''), icon),
							kitchen_behavior = $6
						WHERE id = $1
					`, itemID, it.PriceCents, it.Description, it.CostCents, it.Icon, it.KitchenBehavior); err != nil {
						writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
						return
					}
				}
			case itemExists:
				itemCounts.Skipped++
			default:
				itemCounts.Created++
				if !body.DryRun {
					if _, err := tx.Exec(ctx, `
						INSERT INTO menu_items (tenant_id, category_id, name, description, price_cents, cost_cents, icon, sort, kitchen_behavior)
						VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
					`, t.ID, catID, it.Name, it.Description, it.PriceCents, it.CostCents, it.Icon, itemSort, it.KitchenBehavior); err != nil {
						writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
						return
					}
				}
				itemSort++
			}
		}
	}

	if !body.DryRun {
		catTotal := catCounts.Created + catCounts.Updated + catCounts.Skipped
		itemTotal := itemCounts.Created + itemCounts.Updated + itemCounts.Skipped
		if err := audit.Log(ctx, tx, audit.Entry{
			Action: "import", Entity: "menu",
			Summary: fmt.Sprintf("bulk menu import: %d categories (%d new, %d updated), %d items (%d new, %d updated)",
				catTotal, catCounts.Created, catCounts.Updated,
				itemTotal, itemCounts.Created, itemCounts.Updated),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	writeJSON(w, http.StatusOK, bulkImportResp{
		DryRun:     body.DryRun,
		Categories: catCounts,
		Items:      itemCounts,
	})
}

// nextSort runs a "SELECT COALESCE(MAX(sort), -1) + 1" style query and returns
// the next free sort position so newly created rows append in display order.
func nextSort(ctx context.Context, tx pgx.Tx, q string, args ...any) (int, error) {
	var n int
	err := tx.QueryRow(ctx, q, args...).Scan(&n)
	return n, err
}

// normalizeImport validates the payload and merges duplicate names so the
// upsert pass never collides on the unique category index or double-counts.
// Category names are merged case-insensitively (first occurrence keeps its
// metadata, later items are appended); item names are deduped within a
// category the same way. Returns a 400-worthy error on the first problem.
func normalizeImport(in []bulkImportCategory) ([]bulkImportCategory, error) {
	if len(in) == 0 {
		return nil, errors.New("no categories to import")
	}
	if len(in) > maxImportCategories {
		return nil, fmt.Errorf("too many categories (%d) — limit is %d", len(in), maxImportCategories)
	}

	var out []bulkImportCategory
	catIdx := map[string]int{}  // lower(name) -> index into out
	totalItems := 0

	for _, c := range in {
		name := strings.TrimSpace(c.Name)
		if name == "" {
			return nil, errors.New("category name is required")
		}
		kb := strings.TrimSpace(c.KitchenBehavior)
		if kb == "" {
			kb = "inherit"
		}
		if !validKitchenBehavior(kb) {
			return nil, fmt.Errorf("category %s: kitchen_behavior must be one of inherit, cook, ready, serve", audit.Quote(name))
		}

		key := strings.ToLower(name)
		idx, seen := catIdx[key]
		if !seen {
			idx = len(out)
			catIdx[key] = idx
			out = append(out, bulkImportCategory{
				Name:            name,
				Icon:            strings.TrimSpace(c.Icon),
				Color:           c.Color,
				KitchenBehavior: kb,
			})
		}

		itemIdx := map[string]bool{}
		for _, it := range out[idx].Items {
			itemIdx[strings.ToLower(it.Name)] = true
		}

		for _, it := range c.Items {
			iname := strings.TrimSpace(it.Name)
			if iname == "" {
				return nil, fmt.Errorf("category %s: an item is missing a name", audit.Quote(name))
			}
			if it.PriceCents <= 0 {
				return nil, fmt.Errorf("item %s: price must be greater than 0", audit.Quote(iname))
			}
			if it.CostCents != nil && *it.CostCents < 0 {
				return nil, fmt.Errorf("item %s: cost cannot be negative", audit.Quote(iname))
			}
			ikb := strings.TrimSpace(it.KitchenBehavior)
			if ikb == "" {
				ikb = "inherit"
			}
			if !validKitchenBehavior(ikb) {
				return nil, fmt.Errorf("item %s: kitchen_behavior must be one of inherit, cook, ready, serve", audit.Quote(iname))
			}

			ikey := strings.ToLower(iname)
			if itemIdx[ikey] {
				continue // first occurrence within a category wins
			}
			itemIdx[ikey] = true
			totalItems++
			if totalItems > maxImportItems {
				return nil, fmt.Errorf("too many items — limit is %d", maxImportItems)
			}
			out[idx].Items = append(out[idx].Items, bulkImportItem{
				Name:            iname,
				Description:     strings.TrimSpace(it.Description),
				Icon:            strings.TrimSpace(it.Icon),
				KitchenBehavior: ikb,
				PriceCents:      it.PriceCents,
				CostCents:       it.CostCents,
			})
		}
	}
	return out, nil
}
