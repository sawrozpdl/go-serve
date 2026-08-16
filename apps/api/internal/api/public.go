package api

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// PUBLIC MENU — customer-facing, unauthenticated (the QR landing page).
//
// Reached via GET /public/menu/{slug}. The tenant is resolved by
// tenant.SlugParamMiddleware and queries are RLS-scoped by db.TxMiddleware,
// so this only ever sees one cafe's catalog.
//
// SECURITY: the wire types here are a DELIBERATELY NARROW projection. They
// expose only what a guest needs to read a menu — never operator-only fields
// (cost_cents, sku, modifiers, sort, is_active, inventory links). Add fields
// with care: anything added here becomes world-readable.
// =========================================================================

type publicMenuItem struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	PriceCents  int64     `json:"price_cents"`
	ImageURL    *string   `json:"image_url,omitempty"`
	Icon        string    `json:"icon"`
	// Operator-pinned "popular" flag — surfaced so the page can badge a few
	// items. Purely presentational; reveals nothing sensitive.
	IsFeatured bool `json:"is_featured"`
	// Available add-ons, NESTED under the dish they belong to. They live in
	// their own catalog (0062), so an add-on can never appear as a standalone
	// orderable row the way "Add-on cheese" used to. Name + price only — the
	// customer needs no ids, and cost is the cafe's business. Always an array.
	AddOns []publicAddOn `json:"add_ons"`
}

type publicAddOn struct {
	Name       string `json:"name"`
	PriceCents int64  `json:"price_cents"`
}

type publicMenuCategory struct {
	ID       uuid.UUID        `json:"id"`
	Name     string           `json:"name"`
	Icon     string           `json:"icon"`
	Color    *string          `json:"color,omitempty"`
	ImageURL *string          `json:"image_url,omitempty"`
	Items    []publicMenuItem `json:"items"`
}

type publicCafe struct {
	Name             string `json:"name"`
	Slug             string `json:"slug"`
	Tagline          string `json:"tagline,omitempty"`
	LogoURL          string `json:"logo_url,omitempty"`
	AccentEmoji      string `json:"accent_emoji,omitempty"`
	Currency         string `json:"currency"`
	VatPct           string `json:"vat_pct"`
	VatMode          string `json:"vat_mode"`
	ServiceChargePct string `json:"service_charge_pct"`
	// Safe subset of the branding jsonb (colors + typography) so the public
	// page can theme itself to match the cafe.
	Branding map[string]any `json:"branding"`
}

type publicMenuResponse struct {
	Cafe       publicCafe           `json:"cafe"`
	Categories []publicMenuCategory `json:"categories"`
}

// GetPublicMenu serves a tenant's active menu to anonymous guests.
func GetPublicMenu(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	t, ok := appctx.TenantFromContext(ctx)
	if !ok {
		writeErr(w, http.StatusNotFound, "tenant_not_found", "")
		return
	}
	tx := appctx.Tx(ctx)

	// --- Cafe identity + public branding + tax rates ---------------------
	var name string
	var brandingRaw []byte
	var vatPct, vatMode, servicePct string
	if err := tx.QueryRow(ctx, `
		SELECT name, branding, vat_pct::text, vat_mode, service_charge_pct::text
		FROM tenants WHERE id = $1
	`, t.ID).Scan(&name, &brandingRaw, &vatPct, &vatMode, &servicePct); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	var branding map[string]any
	_ = json.Unmarshal(brandingRaw, &branding)
	if branding == nil {
		branding = map[string]any{}
	}

	cafe := publicCafe{
		Name:             name,
		Slug:             t.Slug,
		Currency:         "NPR",
		VatPct:           vatPct,
		VatMode:          vatMode,
		ServiceChargePct: servicePct,
	}
	// Hoist presentational keys to the top level; expose only a known-safe
	// subset of branding for theming (never the whole jsonb verbatim).
	if v, ok := branding["cafeName"].(string); ok && v != "" {
		cafe.Name = v
	}
	if v, ok := branding["tagline"].(string); ok {
		cafe.Tagline = v
	}
	if v, ok := branding["logoUrl"].(string); ok {
		cafe.LogoURL = v
	}
	if v, ok := branding["accentEmoji"].(string); ok {
		cafe.AccentEmoji = v
	}
	cafe.Branding = map[string]any{}
	for _, k := range []string{"brandPrimary", "brandAccent", "mood", "typography"} {
		if v, ok := branding[k]; ok {
			cafe.Branding[k] = v
		}
	}

	// --- Active categories (order preserved) -----------------------------
	catRows, err := tx.Query(ctx, `
		SELECT id, name, icon, color, image_url
		FROM menu_categories
		WHERE deleted_at IS NULL AND is_active = true
		ORDER BY sort, lower(name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer catRows.Close()

	cats := []*publicMenuCategory{}
	byID := map[uuid.UUID]*publicMenuCategory{}
	for catRows.Next() {
		c := &publicMenuCategory{Items: []publicMenuItem{}}
		if err := catRows.Scan(&c.ID, &c.Name, &c.Icon, &c.Color, &c.ImageURL); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		cats = append(cats, c)
		byID[c.ID] = c
	}
	catRows.Close()

	// --- Active items, attached to their category ------------------------
	//
	// Add-ons come back nested per item, resolved through BOTH attachment levels
	// (the item's own groups and its category's) — the same union the POS uses.
	// Aggregated in-query so the whole menu is still one round trip; this is an
	// unauthenticated endpoint and a per-item query would be a free N+1.
	itemRows, err := tx.Query(ctx, `
		SELECT mi.category_id, mi.id, mi.name, mi.description, mi.price_cents,
		       mi.image_url, mi.icon, mi.is_featured,
		       COALESCE((
		         SELECT jsonb_agg(jsonb_build_object('name', a.name, 'price_cents', a.price_cents)
		                          ORDER BY a.g_sort, a.sort, lower(a.name))
		         FROM (
		           SELECT DISTINCT m.id, m.name, m.price_cents, m.sort, g.sort AS g_sort
		           FROM menu_modifiers m
		           JOIN menu_modifier_groups g ON g.id = m.group_id
		           WHERE m.deleted_at IS NULL AND m.is_active
		             AND g.deleted_at IS NULL AND g.is_active
		             AND (
		               EXISTS (SELECT 1 FROM menu_item_modifier_groups l
		                        WHERE l.group_id = g.id AND l.menu_item_id = mi.id)
		               OR EXISTS (SELECT 1 FROM menu_category_modifier_groups l
		                          WHERE l.group_id = g.id AND l.category_id = mi.category_id)
		             )
		         ) a
		       ), '[]'::jsonb)
		FROM menu_items mi
		WHERE mi.deleted_at IS NULL AND mi.is_active = true
		ORDER BY mi.sort, lower(mi.name)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer itemRows.Close()

	for itemRows.Next() {
		var catID uuid.UUID
		var it publicMenuItem
		var addOns []byte
		if err := itemRows.Scan(&catID, &it.ID, &it.Name, &it.Description,
			&it.PriceCents, &it.ImageURL, &it.Icon, &it.IsFeatured, &addOns); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		it.AddOns = []publicAddOn{}
		_ = json.Unmarshal(addOns, &it.AddOns)
		if c, ok := byID[catID]; ok {
			c.Items = append(c.Items, it)
		}
	}
	itemRows.Close()

	// Drop empty categories so the guest never sees a bare header.
	out := publicMenuResponse{Cafe: cafe, Categories: []publicMenuCategory{}}
	for _, c := range cats {
		if len(c.Items) == 0 {
			continue
		}
		out.Categories = append(out.Categories, *c)
	}

	// Short browser/CDN cache — the menu changes rarely and this is the most
	// hammered (anonymous) endpoint. 60s keeps a busy QR table from stampeding.
	w.Header().Set("Cache-Control", "public, max-age=60")
	writeJSON(w, http.StatusOK, out)
}
