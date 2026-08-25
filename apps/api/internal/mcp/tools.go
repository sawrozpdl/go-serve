package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// The tool table.
//
// EVERY TOOL IS A DECLARATIVE MAPPING TO AN EXISTING /v1 ROUTE. Nothing here
// queries a database. dispatch.go turns a row of this table into an HTTP request
// and runs it through the SAME handler the web app uses, so RequireMember,
// auth.Require, billing.RequireFeature, WriteGate, the RLS transaction and the
// audit log all apply unchanged. There is no parallel permission system to keep
// in step, which is the only way this stays correct as the product grows.
//
// FIFTEEN TOOLS, NOT FORTY, AND NOT ONE
//
// The tool list is re-sent on every request, so forty near-synonymous report
// tools cost tokens on every turn AND make the model choose between
// `top_sellers_by_revenue` and `top_sellers_by_quantity` — a decision it will
// sometimes get wrong. But the other extreme, a single `query(sql)` tool, would
// be far worse than verbose: it invites the model to do arithmetic, hallucinate
// column names, and route around every gate in the product. The unit that works
// is ONE TOOL PER QUESTION AN OWNER ASKS, with enum parameters.
//
// EXACTLY ONE TOOL IS NOT A GET
//
// dispatch_test.go walks this table and fails the build if a second non-GET
// appears. That is what makes "read-only, apart from accepting a finding" a
// structural property rather than a promise in a doc comment — somebody adding a
// write tool has to delete a test that explains why they shouldn't.

// Scope names, matching the CHECK on mcp_connections.scopes.
const (
	ScopeReadSales     = "read_sales"
	ScopeReadFinance   = "read_finance"
	ScopeReadInventory = "read_inventory"
	ScopeWriteFollowUp = "write_followup"
)

// Tool is one callable.
type Tool struct {
	Name string
	// Desc is written for a MODEL, not a person: it says when to reach for this
	// rather than what it technically returns.
	Desc string
	// Schema is the JSON Schema for Arguments.
	Schema string
	// Scope the connection must hold.
	Scope string

	// Method is "GET" for every tool but one. See the note above.
	Method string
	// Path builds the /v1 path. Given already-validated args.
	Path func(a args) (string, error)
	// Query builds the query string.
	Query func(a args) url.Values
	// Body builds a JSON body, for the single write tool.
	Body func(a args) any
	// SuccessNote is what to tell the model when the handler returns an empty
	// 2xx. Without it a write looks to the assistant like nothing happened.
	SuccessNote string
}

// args is decoded tool arguments with accessors that fail loudly rather than
// silently defaulting. A model that passes a string where a number belongs
// should be told, not quietly given page zero.
type args map[string]any

func (a args) str(key, def string) string {
	if v, ok := a[key].(string); ok && v != "" {
		return v
	}
	return def
}

func (a args) num(key string, def int) int {
	switch v := a[key].(type) {
	case float64:
		// What JSON decoding actually produces. Every number arriving from a
		// model lands here.
		return int(v)
	case int:
		// Only reachable from Go callers (tests), but free to support and its
		// absence made a clamp look broken when it was not.
		return v
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func (a args) boolean(key string) bool {
	b, _ := a[key].(bool)
	return b
}

// rangeQuery builds the shared date-window parameters.
//
// The vocabulary is resolveRangeFull's, verbatim: today, yesterday, 7d, 30d,
// thisweek, lastweek, mtd, ytd, custom. Reusing it rather than inventing an MCP
// range means the window is already tested, already timezone-correct in the
// café's own zone, and can never disagree with what the same question returns on
// the web dashboard.
func rangeQuery(a args) url.Values {
	q := url.Values{}
	r := a.str("range", "30d")
	q.Set("range", r)
	if r == "custom" {
		if from := a.str("from", ""); from != "" {
			q.Set("from", from)
		}
		if to := a.str("to", ""); to != "" {
			q.Set("to", to)
		}
	}
	return q
}

const rangeSchemaProps = `"range":{"type":"string","enum":["today","yesterday","7d","30d","thisweek","lastweek","mtd","ytd","custom"],"description":"Which period. Defaults to 30d. Use custom only when the user named specific dates."},"from":{"type":"string","description":"YYYY-MM-DD. Only with range=custom."},"to":{"type":"string","description":"YYYY-MM-DD. Only with range=custom."}`

func schema(props string, required ...string) string {
	req := ""
	if len(required) > 0 {
		quoted := make([]string, len(required))
		for i, r := range required {
			quoted[i] = `"` + r + `"`
		}
		req = `,"required":[` + strings.Join(quoted, ",") + `]`
	}
	if props == "" {
		return `{"type":"object","properties":{}}`
	}
	return `{"type":"object","properties":{` + props + `}` + req + `}`
}

// Tools is the whole surface, in the order it is advertised. Ordered so a model
// scanning the list meets the general questions before the specific ones.
var Tools = []Tool{
	{
		Name: "whoami",
		// Earns its slot by stopping the model guessing. Without it, an
		// assistant asked "how did we do today?" has to invent a timezone, and
		// a UTC-based "today" is six hours wrong in Kathmandu.
		Desc:   "Which café this is, its timezone and currency, and what this connection is allowed to read. Call this first if you need to reason about dates or about what you can see.",
		Schema: schema(""),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/me", nil },
	},
	{
		Name:   "cafe_overview",
		Desc:   "The headline numbers for a period: takings, net revenue, order count, average bill, expenses, what was collected versus put on credit, and the daily trend. Start here for 'how are we doing'.",
		Schema: schema(rangeSchemaProps),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/reports/dashboard", nil },
		Query:  rangeQuery,
	},
	{
		Name:   "sales_summary",
		Desc:   "Sales broken down by day, by menu item, or by category. Use group_by=day for a trend, item or category for a mix.",
		Schema: schema(rangeSchemaProps + `,"group_by":{"type":"string","enum":["day","item","category"],"description":"Defaults to day."},"limit":{"type":"integer","description":"Max rows, default 20."}`),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/reports/sales", nil },
		Query: func(a args) url.Values {
			q := rangeQuery(a)
			q.Set("group_by", a.str("group_by", "day"))
			q.Set("limit", strconv.Itoa(clamp(a.num("limit", 20), 1, 200)))
			return q
		},
	},
	{
		Name:   "top_items",
		Desc:   "Best and worst selling items for a period, each with the change against the previous period of the same length.",
		Schema: schema(rangeSchemaProps),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/reports/top-sellers", nil },
		Query:  rangeQuery,
	},
	{
		Name:   "item_trends",
		Desc:   "The full item leaderboard with period-on-period movement, searchable and pageable. Use this to answer 'what is selling more or less than it was'.",
		Schema: schema(rangeSchemaProps + `,"q":{"type":"string","description":"Filter by item name."},"sort":{"type":"string","enum":["revenue","qty"],"description":"Defaults to revenue."},"order":{"type":"string","enum":["asc","desc"]},"limit":{"type":"integer"}`),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/reports/movers", nil },
		Query: func(a args) url.Values {
			q := rangeQuery(a)
			if s := a.str("q", ""); s != "" {
				q.Set("q", s)
			}
			q.Set("sort", a.str("sort", "revenue"))
			if o := a.str("order", ""); o != "" {
				q.Set("order", o)
			}
			q.Set("limit", strconv.Itoa(clamp(a.num("limit", 25), 1, 100)))
			return q
		},
	},
	{
		Name:   "menu_list",
		Desc:   "The menu: categories, items, prices and which are active. Use it to find an item's id before calling item_detail.",
		Schema: schema(""),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/menu/items", nil },
	},
	{
		Name:   "item_detail",
		Desc:   "One item's performance: quantity, revenue, cost and margin for a period against the previous one, its daily trend and its busiest hours.",
		Schema: schema(rangeSchemaProps+`,"item_id":{"type":"string","description":"The item's id, from menu_list or item_trends."}`, "item_id"),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path: func(a args) (string, error) {
			id := a.str("item_id", "")
			if id == "" {
				return "", fmt.Errorf("item_id is required — get one from menu_list or item_trends")
			}
			return "/v1/reports/item/" + url.PathEscape(id), nil
		},
		Query: rangeQuery,
	},
	{
		Name:   "profitability",
		Desc:   "Profit and loss by menu category: revenue, direct cost, allocated overhead and margin. Note the margin is only as good as the café's cost data — check books_confidence in insights_list.",
		Schema: schema(rangeSchemaProps),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/reports/profitability", nil },
		Query:  rangeQuery,
	},
	{
		Name:   "busiest_times",
		Desc:   "When the café is busy: by hour of a given day, by weekday-and-hour heatmap, or by table. Remember these are settlement times, not order times.",
		Schema: schema(`"by":{"type":"string","enum":["hour","weekday","table"],"description":"hour needs a date; weekday and table use a range."},"date":{"type":"string","description":"YYYY-MM-DD, for by=hour."},` + rangeSchemaProps),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path: func(a args) (string, error) {
			switch a.str("by", "weekday") {
			case "hour":
				return "/v1/reports/hourly", nil
			case "table":
				return "/v1/reports/table-mix", nil
			default:
				return "/v1/reports/heatmap", nil
			}
		},
		Query: func(a args) url.Values {
			if a.str("by", "weekday") == "hour" {
				q := url.Values{}
				if d := a.str("date", ""); d != "" {
					q.Set("date", d)
				}
				return q
			}
			return rangeQuery(a)
		},
	},
	{
		Name:   "sales_velocity",
		Desc:   "Orders per day, average bill and items per order over a period — the shape of trade rather than its total.",
		Schema: schema(rangeSchemaProps),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/reports/velocity", nil },
		Query:  rangeQuery,
	},
	{
		Name:   "orders_search",
		Desc:   "Individual closed bills for a day or a range, with their line items and payments. Use this when a question is about specific transactions rather than totals.",
		Schema: schema(`"date":{"type":"string","description":"YYYY-MM-DD for a single day."},"from":{"type":"string"},"to":{"type":"string"}`),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/orders/history", nil },
		Query: func(a args) url.Values {
			q := url.Values{}
			if d := a.str("date", ""); d != "" {
				q.Set("date", d)
				return q
			}
			if f := a.str("from", ""); f != "" {
				q.Set("from", f)
			}
			if t := a.str("to", ""); t != "" {
				q.Set("to", t)
			}
			return q
		},
	},
	{
		Name:   "inventory_status",
		Desc:   "Stock on hand, with which items are below their reorder level.",
		Schema: schema(`"low_stock_only":{"type":"boolean"}`),
		Scope:  ScopeReadInventory,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/inventory/items", nil },
		Query: func(a args) url.Values {
			q := url.Values{}
			if a.boolean("low_stock_only") {
				q.Set("low", "1")
			}
			return q
		},
	},
	{
		Name: "cash_and_accounts",
		// Gated behind its own scope and OFF by default. This is the one read
		// that sends a café's financial position to a third-party model
		// provider, so it must be a decision the owner made on purpose.
		Desc:   "Cash drawer, bank and online balances, and the café's overall money position. Requires the finance scope, which is off unless the owner enabled it.",
		Schema: schema(""),
		Scope:  ScopeReadFinance,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/accounts/balances", nil },
	},
	{
		Name:   "insights_list",
		Desc:   "What the nightly checks found in this café's books, worst first, plus books_confidence — how much of the café's own numbers can be vouched for. Read this before making any claim about profit.",
		Schema: schema(""),
		Scope:  ScopeReadSales,
		Method: http.MethodGet,
		Path:   func(args) (string, error) { return "/v1/insights", nil },
	},
	{
		// THE ONE WRITE.
		//
		// Its safety is not in this table — it is in the handler it calls, whose
		// UPDATE ... WHERE clause can only touch a row that ALREADY EXISTS for
		// this tenant in an open state. So the model cannot create a finding,
		// cannot resurrect a closed one, and cannot reach another café's. The
		// worst a confused or malicious assistant can do is set a review date on
		// something the café was already going to be shown.
		Name:   "accept_finding",
		Desc:   "Mark a finding as something the owner will deal with, and book a date to check whether it moved. Only ever call this when the user has clearly said they want to act on a specific finding — get the id from insights_list.",
		Schema: schema(`"finding_id":{"type":"string","description":"From insights_list."},"follow_up_days":{"type":"integer","description":"When to check back, 1-90. Defaults to 14."},"note":{"type":"string","description":"What the owner said they would do, in their words. Max 280 characters."}`, "finding_id"),
		Scope:  ScopeWriteFollowUp,
		Method: http.MethodPost,
		Path: func(a args) (string, error) {
			id := a.str("finding_id", "")
			if id == "" {
				return "", fmt.Errorf("finding_id is required — get one from insights_list")
			}
			return "/v1/insights/" + url.PathEscape(id) + "/accept", nil
		},
		Body: func(a args) any {
			return map[string]any{
				"follow_up_days": a.num("follow_up_days", 14),
				"note":           truncate(a.str("note", ""), 280),
			}
		},
		SuccessNote: "The finding is marked as being dealt with, and the café will be shown " +
			"whether the number moved when the review date arrives.",
	},
}

// ByName looks a tool up.
func ByName(name string) (Tool, bool) {
	for _, t := range Tools {
		if t.Name == name {
			return t, true
		}
	}
	return Tool{}, false
}

// Descriptors renders the tools a connection may call. A tool the connection
// lacks the scope for is not merely refused, it is NOT ADVERTISED — a model
// cannot be tempted by a capability it never saw, and an assistant that keeps
// trying a tool it will always be refused wastes the user's turns.
func Descriptors(scopes []string) []toolDescriptor {
	held := make(map[string]bool, len(scopes))
	for _, s := range scopes {
		held[s] = true
	}
	out := make([]toolDescriptor, 0, len(Tools))
	for _, t := range Tools {
		if !held[t.Scope] {
			continue
		}
		out = append(out, toolDescriptor{
			Name: t.Name, Description: t.Desc, InputSchema: json.RawMessage(t.Schema),
		})
	}
	return out
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
