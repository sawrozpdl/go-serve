package api

// Menu sync, part two: the things the bulk import never touched — photos,
// stations (prep routing) and add-ons. Each is opt-in per sync. Everything is
// matched by NAME in the target branch (ids are per branch), and, like the
// rest of sync, nothing is ever deleted or unlinked.
//
//   - Photos: the image URL is shared. Menu images are never removed from
//     storage (nothing calls store.Delete for them), so two branches pointing
//     at one object is safe.
//   - Stations: a category/item is pointed at the target's station of the same
//     name. Stations themselves are NOT created — a station has a printer, and
//     printers are per building — so a missing one is reported instead.
//   - Add-ons: groups and their options are upserted by name, then attached to
//     the synced items/categories. Option prices follow the same rule as item
//     prices: new options arrive at this branch's price, existing ones keep
//     their own unless prices are pushed too.

import (
	"context"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type syncExtrasOpts struct {
	Photos   bool `json:"photos"`
	Stations bool `json:"stations"`
	AddOns   bool `json:"add_ons"`
}

func (o syncExtrasOpts) any() bool { return o.Photos || o.Stations || o.AddOns }

type extrasResult struct {
	Photos            int      `json:"photos"`
	Stations          int      `json:"stations"`
	MissingStations   []string `json:"missing_stations,omitempty"`
	AddOnGroupsNew    int      `json:"add_on_groups_new"`
	AddOnGroupsUpdate int      `json:"add_on_groups_updated"`
	AddOnOptionsNew   int      `json:"add_on_options_new"`
	AddOnOptionsUpd   int      `json:"add_on_options_updated"`
	AddOnLinks        int      `json:"add_on_links"`
}

type srcModifier struct {
	Name     string
	Price    int64
	Cost     *int64
	Sort     int
	IsActive bool
}

type srcGroup struct {
	Name     string
	Min, Max int
	Sort     int
	IsActive bool
	Options  []srcModifier
}

type srcLink struct {
	Category string
	Item     string // "" for a category-level link
	Group    string
	Sort     int
}

type srcPlacement struct {
	Category string
	Item     string // "" for the category row itself
	Image    *string
	Station  *string // nil = inherit / default
}

// menuExtras is the source branch's photos, stations and add-ons, by name.
type menuExtras struct {
	Placements []srcPlacement
	Groups     []srcGroup
	Links      []srcLink
}

// loadMenuExtras reads the source branch's extras for the same live items
// loadSourceMenu syncs (active, not deleted).
func loadMenuExtras(ctx context.Context, tx pgx.Tx) (menuExtras, error) {
	var out menuExtras
	rows, err := tx.Query(ctx, `
		SELECT c.name, c.image_url, co.name, '' AS item, NULL::text, NULL::text
		FROM menu_categories c
		LEFT JOIN outlets co ON co.id = c.outlet_id AND co.deleted_at IS NULL
		WHERE c.deleted_at IS NULL AND c.is_active
		UNION ALL
		SELECT c.name, NULL, NULL, i.name, i.image_url, io.name
		FROM menu_items i
		JOIN menu_categories c ON c.id = i.category_id AND c.deleted_at IS NULL AND c.is_active
		LEFT JOIN outlets io ON io.id = i.outlet_id AND io.deleted_at IS NULL
		WHERE i.deleted_at IS NULL AND i.is_active
	`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var p srcPlacement
		var catImg, catStation, itemImg, itemStation *string
		if err := rows.Scan(&p.Category, &catImg, &catStation, &p.Item, &itemImg, &itemStation); err != nil {
			rows.Close()
			return out, err
		}
		if p.Item == "" {
			p.Image, p.Station = catImg, catStation
		} else {
			p.Image, p.Station = itemImg, itemStation
		}
		out.Placements = append(out.Placements, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	grows, err := tx.Query(ctx, `
		SELECT g.id, g.name, g.min_select, g.max_select, g.sort, g.is_active
		FROM menu_modifier_groups g
		WHERE g.deleted_at IS NULL
		ORDER BY g.sort, lower(g.name)
	`)
	if err != nil {
		return out, err
	}
	idx := map[uuid.UUID]int{}
	for grows.Next() {
		var id uuid.UUID
		var g srcGroup
		if err := grows.Scan(&id, &g.Name, &g.Min, &g.Max, &g.Sort, &g.IsActive); err != nil {
			grows.Close()
			return out, err
		}
		idx[id] = len(out.Groups)
		out.Groups = append(out.Groups, g)
	}
	grows.Close()
	if err := grows.Err(); err != nil {
		return out, err
	}

	mrows, err := tx.Query(ctx, `
		SELECT m.group_id, m.name, m.price_cents, m.cost_cents, m.sort, m.is_active
		FROM menu_modifiers m
		JOIN menu_modifier_groups g ON g.id = m.group_id AND g.deleted_at IS NULL
		WHERE m.deleted_at IS NULL
		ORDER BY m.sort, lower(m.name)
	`)
	if err != nil {
		return out, err
	}
	for mrows.Next() {
		var gid uuid.UUID
		var m srcModifier
		if err := mrows.Scan(&gid, &m.Name, &m.Price, &m.Cost, &m.Sort, &m.IsActive); err != nil {
			mrows.Close()
			return out, err
		}
		if i, ok := idx[gid]; ok {
			out.Groups[i].Options = append(out.Groups[i].Options, m)
		}
	}
	mrows.Close()
	if err := mrows.Err(); err != nil {
		return out, err
	}

	lrows, err := tx.Query(ctx, `
		SELECT c.name, i.name, g.name, l.sort
		FROM menu_item_modifier_groups l
		JOIN menu_items i ON i.id = l.menu_item_id AND i.deleted_at IS NULL AND i.is_active
		JOIN menu_categories c ON c.id = i.category_id AND c.deleted_at IS NULL AND c.is_active
		JOIN menu_modifier_groups g ON g.id = l.group_id AND g.deleted_at IS NULL
		UNION ALL
		SELECT c.name, '', g.name, l.sort
		FROM menu_category_modifier_groups l
		JOIN menu_categories c ON c.id = l.category_id AND c.deleted_at IS NULL AND c.is_active
		JOIN menu_modifier_groups g ON g.id = l.group_id AND g.deleted_at IS NULL
	`)
	if err != nil {
		return out, err
	}
	for lrows.Next() {
		var l srcLink
		if err := lrows.Scan(&l.Category, &l.Item, &l.Group, &l.Sort); err != nil {
			lrows.Close()
			return out, err
		}
		out.Links = append(out.Links, l)
	}
	lrows.Close()
	return out, lrows.Err()
}

// targetIDs resolves a category (and optionally item) by name in the target.
func targetIDs(ctx context.Context, tx pgx.Tx, category, item string) (catID, itemID uuid.UUID, ok bool, err error) {
	if err = tx.QueryRow(ctx,
		`SELECT id FROM menu_categories WHERE lower(name) = lower($1) AND deleted_at IS NULL`, category,
	).Scan(&catID); err != nil {
		if err == pgx.ErrNoRows {
			return catID, itemID, false, nil
		}
		return
	}
	if item == "" {
		return catID, itemID, true, nil
	}
	if err = tx.QueryRow(ctx,
		`SELECT id FROM menu_items WHERE category_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`, catID, item,
	).Scan(&itemID); err != nil {
		if err == pgx.ErrNoRows {
			return catID, itemID, false, nil
		}
		return
	}
	return catID, itemID, true, nil
}

// applyMenuExtras writes the opted-in extras into the target branch (tx is
// scoped to it). Runs after applyMenuImport, so new items already exist.
func applyMenuExtras(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, src menuExtras, o syncExtrasOpts, keepPrices bool) (extrasResult, error) {
	var res extrasResult

	// Station names → target ids (active, not deleted).
	stations := map[string]uuid.UUID{}
	if o.Stations {
		rows, err := tx.Query(ctx, `SELECT id, name FROM outlets WHERE deleted_at IS NULL AND is_active`)
		if err != nil {
			return res, err
		}
		for rows.Next() {
			var id uuid.UUID
			var name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return res, err
			}
			stations[strings.ToLower(name)] = id
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return res, err
		}
	}
	missing := map[string]bool{}

	for _, p := range src.Placements {
		if !o.Photos && !o.Stations {
			break
		}
		catID, itemID, ok, err := targetIDs(ctx, tx, p.Category, p.Item)
		if err != nil {
			return res, err
		}
		if !ok {
			continue
		}
		table, id := "menu_categories", catID
		if p.Item != "" {
			table, id = "menu_items", itemID
		}
		if o.Photos && p.Image != nil && *p.Image != "" {
			tag, err := tx.Exec(ctx, `UPDATE `+table+` SET image_url = $2 WHERE id = $1 AND image_url IS DISTINCT FROM $2`, id, *p.Image)
			if err != nil {
				return res, err
			}
			res.Photos += int(tag.RowsAffected())
		}
		if o.Stations {
			var target *uuid.UUID
			if p.Station != nil {
				sid, found := stations[strings.ToLower(*p.Station)]
				if !found {
					missing[*p.Station] = true
					continue // leave the target's routing as it is
				}
				target = &sid
			}
			tag, err := tx.Exec(ctx, `UPDATE `+table+` SET outlet_id = $2 WHERE id = $1 AND outlet_id IS DISTINCT FROM $2`, id, target)
			if err != nil {
				return res, err
			}
			res.Stations += int(tag.RowsAffected())
		}
	}
	for name := range missing {
		res.MissingStations = append(res.MissingStations, name)
	}
	sort.Strings(res.MissingStations)

	if !o.AddOns {
		return res, nil
	}
	groupIDs := map[string]uuid.UUID{}
	for _, g := range src.Groups {
		var gid uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM menu_modifier_groups WHERE lower(name) = lower($1) AND deleted_at IS NULL`, g.Name,
		).Scan(&gid)
		switch {
		case err == pgx.ErrNoRows:
			if err := tx.QueryRow(ctx, `
				INSERT INTO menu_modifier_groups (tenant_id, name, min_select, max_select, sort, is_active)
				VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
			`, tenantID, g.Name, g.Min, g.Max, g.Sort, g.IsActive).Scan(&gid); err != nil {
				return res, err
			}
			res.AddOnGroupsNew++
		case err != nil:
			return res, err
		default:
			tag, err := tx.Exec(ctx, `
				UPDATE menu_modifier_groups SET min_select = $2, max_select = $3, is_active = $4
				WHERE id = $1 AND (min_select, max_select, is_active) IS DISTINCT FROM ($2, $3, $4)
			`, gid, g.Min, g.Max, g.IsActive)
			if err != nil {
				return res, err
			}
			res.AddOnGroupsUpdate += int(tag.RowsAffected())
		}
		groupIDs[strings.ToLower(g.Name)] = gid

		for _, m := range g.Options {
			var mid uuid.UUID
			err := tx.QueryRow(ctx,
				`SELECT id FROM menu_modifiers WHERE group_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`, gid, m.Name,
			).Scan(&mid)
			switch {
			case err == pgx.ErrNoRows:
				if _, err := tx.Exec(ctx, `
					INSERT INTO menu_modifiers (tenant_id, group_id, name, price_cents, cost_cents, sort, is_active)
					VALUES ($1, $2, $3, $4, $5, $6, $7)
				`, tenantID, gid, m.Name, m.Price, m.Cost, m.Sort, m.IsActive); err != nil {
					return res, err
				}
				res.AddOnOptionsNew++
			case err != nil:
				return res, err
			default:
				tag, err := tx.Exec(ctx, `
					UPDATE menu_modifiers SET
					  price_cents = CASE WHEN $5 THEN price_cents ELSE $2 END,
					  cost_cents  = COALESCE($3, cost_cents),
					  is_active   = $4
					WHERE id = $1
					  AND ((NOT $5 AND price_cents <> $2)
					       OR ($3::bigint IS NOT NULL AND cost_cents IS DISTINCT FROM $3)
					       OR is_active <> $4)
				`, mid, m.Price, m.Cost, m.IsActive, keepPrices)
				if err != nil {
					return res, err
				}
				res.AddOnOptionsUpd += int(tag.RowsAffected())
			}
		}
	}

	for _, l := range src.Links {
		gid, ok := groupIDs[strings.ToLower(l.Group)]
		if !ok {
			continue
		}
		catID, itemID, found, err := targetIDs(ctx, tx, l.Category, l.Item)
		if err != nil {
			return res, err
		}
		if !found {
			continue
		}
		var q string
		var owner uuid.UUID
		if l.Item == "" {
			q = `INSERT INTO menu_category_modifier_groups (tenant_id, category_id, group_id, sort) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`
			owner = catID
		} else {
			q = `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`
			owner = itemID
		}
		tag, err := tx.Exec(ctx, q, tenantID, owner, gid, l.Sort)
		if err != nil {
			return res, err
		}
		res.AddOnLinks += int(tag.RowsAffected())
	}
	return res, nil
}

// changes is how many writes the extras made — used to tell a preview that
// would change nothing from one that would.
func (r extrasResult) changes() int {
	return r.Photos + r.Stations + r.AddOnGroupsNew + r.AddOnGroupsUpdate +
		r.AddOnOptionsNew + r.AddOnOptionsUpd + r.AddOnLinks
}
