package api

// All-branches versions of the item and category reports. Same rule as the
// dashboard (business_fanout.go): each branch's own handler answers for that
// branch, and the answers are combined. Branch menus are separate rows, so
// items and categories are matched by NAME (case-insensitive) — the same key
// menu sync uses, so a synced menu lines up exactly.

import (
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

var (
	fanoutMovers        = fanoutRoute{perm: "report:read", feature: billing.FeatureAdvancedAnalytics, handler: GetMovers}
	fanoutCategoryMix   = fanoutRoute{perm: "report:read", feature: billing.FeatureAdvancedAnalytics, handler: GetCategoryMix}
	fanoutProfitability = fanoutRoute{perm: "report:read", feature: billing.FeatureProfitability, handler: GetProfitability}
)

// requestWithQuery returns a shallow copy of r whose query string has been edited.
func requestWithQuery(r *http.Request, edit func(url.Values)) *http.Request {
	q := r.URL.Query()
	edit(q)
	r2 := r.Clone(r.Context())
	u := *r.URL
	u.RawQuery = q.Encode()
	r2.URL = &u
	return r2
}

func nameKey(parts ...string) string {
	for i, p := range parts {
		parts[i] = strings.ToLower(strings.TrimSpace(p))
	}
	return strings.Join(parts, "\x00")
}

// ---------------------------------------------------------------- movers

// GetBusinessMovers — GET /v1/business/reports/movers?range=&q=&sort=&order=&limit=&offset=&branches=
//
// Each branch returns its whole list (paging is applied after merging, or a
// branch's 101st item could be the business's 3rd). category_id is a
// branch-local id, so it is not forwarded; filter by name with q instead.
func GetBusinessMovers(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		in := r.URL.Query()
		branchReq := requestWithQuery(r, func(q url.Values) {
			q.Del("category_id")
			q.Set("limit", "1000")
			q.Set("offset", "0")
		})
		biz, statuses, data, err := fanout[MoversResp](branchReq, pool, repo, fanoutMovers)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		complete, mixed := fanoutMeta(statuses)
		parts := make([]MoversResp, len(data))
		for i, d := range data {
			parts[i] = d.Data
		}
		limit := 100
		if n, e := strconv.Atoi(in.Get("limit")); e == nil && n > 0 && n <= 1000 {
			limit = n
		}
		offset := 0
		if n, e := strconv.Atoi(in.Get("offset")); e == nil && n > 0 {
			offset = n
		}
		totals := mergeMovers(parts, in.Get("sort") == "qty", strings.EqualFold(in.Get("order"), "asc"), limit, offset)
		// Per-branch rows stay complete lists only in the totals; trim them so
		// the response stays small.
		for i := range data {
			if len(data[i].Data.Rows) > 20 {
				data[i].Data.Rows = data[i].Data.Rows[:20]
			}
		}
		writeJSON(w, http.StatusOK, FanoutResponse[MoversResp]{
			Business: biz, Branches: statuses, Complete: complete, MixedTimezones: mixed,
			Totals: totals, PerBranch: data,
		})
	}
}

// mergeMovers combines branch movers lists by (item name, category name):
// quantities and revenue add, the change vs the previous period is recomputed
// from the summed figures, then the list is sorted and paged.
func mergeMovers(parts []MoversResp, byQty, asc bool, limit, offset int) MoversResp {
	out := MoversResp{Rows: []MoverRow{}}
	if len(parts) > 0 {
		f := parts[0]
		out.Range, out.From, out.To, out.PrevFrom, out.PrevTo = f.Range, f.From, f.To, f.PrevFrom, f.PrevTo
	}
	byKey := map[string]*MoverRow{}
	var order []string
	for _, p := range parts {
		for _, m := range p.Rows {
			cat := ""
			if m.CategoryName != nil {
				cat = *m.CategoryName
			}
			k := nameKey(m.Name, cat)
			acc, ok := byKey[k]
			if !ok {
				cp := MoverRow{Name: m.Name, Icon: m.Icon, CategoryName: m.CategoryName}
				acc = &cp
				byKey[k] = acc
				order = append(order, k)
			}
			acc.Qty += m.Qty
			acc.RevenueCents += m.RevenueCents
			acc.PrevQty += m.PrevQty
			acc.PrevRevenue += m.PrevRevenue
		}
	}
	rows := make([]MoverRow, 0, len(order))
	for _, k := range order {
		m := *byKey[k]
		m.DeltaPct = nil
		if m.PrevRevenue > 0 {
			d := roundTo((float64(m.RevenueCents-m.PrevRevenue)/float64(m.PrevRevenue))*100, 1)
			m.DeltaPct = &d
		}
		rows = append(rows, m)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		vi, vj := float64(rows[i].RevenueCents), float64(rows[j].RevenueCents)
		if byQty {
			vi, vj = rows[i].Qty, rows[j].Qty
		}
		if vi != vj {
			if asc {
				return vi < vj
			}
			return vi > vj
		}
		return strings.ToLower(rows[i].Name) < strings.ToLower(rows[j].Name)
	})
	out.Total = len(rows)
	if offset < len(rows) {
		end := offset + limit
		if end > len(rows) {
			end = len(rows)
		}
		out.Rows = rows[offset:end]
	}
	return out
}

// ---------------------------------------------------------- category mix

// CategoryMixResp is GetCategoryMix's response.
type CategoryMixResp struct {
	Range string           `json:"range"`
	From  time.Time        `json:"from"`
	To    time.Time        `json:"to"`
	Rows  []CategoryMixRow `json:"rows"`
}

// GetBusinessCategoryMix — GET /v1/business/reports/category-mix?range=&branches=
func GetBusinessCategoryMix(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		biz, statuses, data, err := fanout[CategoryMixResp](r, pool, repo, fanoutCategoryMix)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		complete, mixed := fanoutMeta(statuses)
		parts := make([]CategoryMixResp, len(data))
		for i, d := range data {
			parts[i] = d.Data
		}
		writeJSON(w, http.StatusOK, FanoutResponse[CategoryMixResp]{
			Business: biz, Branches: statuses, Complete: complete, MixedTimezones: mixed,
			Totals: mergeCategoryMix(parts), PerBranch: data,
		})
	}
}

// mergeCategoryMix adds categories with the same name and recomputes each
// one's share of the combined total. Revenue here is BILLED sales allocated
// per category, so the combined donut still totals the combined Sales card.
func mergeCategoryMix(parts []CategoryMixResp) CategoryMixResp {
	out := CategoryMixResp{Rows: []CategoryMixRow{}}
	if len(parts) > 0 {
		out.Range, out.From, out.To = parts[0].Range, parts[0].From, parts[0].To
	}
	byKey := map[string]*CategoryMixRow{}
	var order []string
	var total int64
	for _, p := range parts {
		for _, c := range p.Rows {
			k := nameKey(c.Name)
			acc, ok := byKey[k]
			if !ok {
				cp := CategoryMixRow{Name: c.Name, Color: c.Color, Icon: c.Icon}
				acc = &cp
				byKey[k] = acc
				order = append(order, k)
			}
			acc.Qty += c.Qty
			acc.RevenueCents += c.RevenueCents
			total += c.RevenueCents
		}
	}
	for _, k := range order {
		c := *byKey[k]
		if total > 0 {
			c.SharePct = math.Round(float64(c.RevenueCents)/float64(total)*10000) / 100
		}
		out.Rows = append(out.Rows, c)
	}
	sort.SliceStable(out.Rows, func(i, j int) bool {
		if out.Rows[i].RevenueCents != out.Rows[j].RevenueCents {
			return out.Rows[i].RevenueCents > out.Rows[j].RevenueCents
		}
		return strings.ToLower(out.Rows[i].Name) < strings.ToLower(out.Rows[j].Name)
	})
	return out
}

// --------------------------------------------------------- profitability

// GetBusinessProfitability — GET /v1/business/reports/profitability?range=&from=&to=&branches=
func GetBusinessProfitability(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		biz, statuses, data, err := fanout[ProfitReport](r, pool, repo, fanoutProfitability)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		complete, mixed := fanoutMeta(statuses)
		parts := make([]ProfitReport, len(data))
		for i, d := range data {
			parts[i] = d.Data
		}
		writeJSON(w, http.StatusOK, FanoutResponse[ProfitReport]{
			Business: biz, Branches: statuses, Complete: complete, MixedTimezones: mixed,
			Totals: mergeProfit(parts), PerBranch: data,
		})
	}
}

// mergeProfit adds branch P&Ls. Categories with the same name are combined;
// gross profit and margin are recomputed from the summed money, never
// averaged. Net profit is net revenue − expenses − transfer fees on the sums,
// which equals the sum of the branches' net profits by construction.
func mergeProfit(parts []ProfitReport) ProfitReport {
	out := ProfitReport{Categories: []ProfitRow{}}
	if len(parts) > 0 {
		out.Range, out.From, out.To, out.Timezone = parts[0].Range, parts[0].From, parts[0].To, parts[0].Timezone
	}
	byKey := map[string]*ProfitRow{}
	var order []string
	for _, p := range parts {
		out.BilledSalesCents += p.BilledSalesCents
		out.VatCents += p.VatCents
		out.UnallocatedCogsCents += p.UnallocatedCogsCents
		out.TotalExpensesCents += p.TotalExpensesCents
		out.TransferFeesCents += p.TransferFeesCents
		for _, c := range p.Categories {
			k := nameKey(c.Name)
			acc, ok := byKey[k]
			if !ok {
				acc = &ProfitRow{Name: c.Name}
				byKey[k] = acc
				order = append(order, k)
			}
			acc.NetRevenueCents += c.NetRevenueCents
			acc.ItemSalesCents += c.ItemSalesCents
			acc.DirectCogsCents += c.DirectCogsCents
			acc.AllocatedCogsCents += c.AllocatedCogsCents
		}
	}
	for _, k := range order {
		c := *byKey[k]
		c.CogsCents = c.DirectCogsCents + c.AllocatedCogsCents
		c.GrossProfitCents = c.NetRevenueCents - c.CogsCents
		c.MarginPct = marginPct(c.NetRevenueCents, c.GrossProfitCents)
		out.Categories = append(out.Categories, c)
		out.Totals.NetRevenueCents += c.NetRevenueCents
		out.Totals.ItemSalesCents += c.ItemSalesCents
		out.Totals.DirectCogsCents += c.DirectCogsCents
		out.Totals.AllocatedCogsCents += c.AllocatedCogsCents
		out.Totals.CogsCents += c.CogsCents
	}
	sort.SliceStable(out.Categories, func(i, j int) bool {
		if out.Categories[i].NetRevenueCents != out.Categories[j].NetRevenueCents {
			return out.Categories[i].NetRevenueCents > out.Categories[j].NetRevenueCents
		}
		return strings.ToLower(out.Categories[i].Name) < strings.ToLower(out.Categories[j].Name)
	})
	out.Totals.Name = "All categories"
	out.Totals.GrossProfitCents = out.Totals.NetRevenueCents - out.Totals.CogsCents
	out.Totals.MarginPct = marginPct(out.Totals.NetRevenueCents, out.Totals.GrossProfitCents)
	out.NetProfitCents = out.Totals.NetRevenueCents - out.TotalExpensesCents - out.TransferFeesCents
	return out
}
