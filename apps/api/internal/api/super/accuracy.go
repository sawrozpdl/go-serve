package super

import (
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// GET /super/accuracy-check[?tenant_id=...]
//
// Runs the money invariants against LIVE rows and reports every violation.
//
// The test suite proves the handlers agree with each other; this proves the data
// still satisfies what they assume — on production, at any time, without
// shipping a binary. Read-only: the work is done by platform_accuracy_check()
// (migration 0056), a STABLE SECURITY DEFINER function, because /super carries
// no tenant context and RLS would otherwise hide every row.
//
// Each violation names the row, describes it in words, and carries a signed
// delta so the size of the problem is visible rather than just its existence.
// =========================================================================

type AccuracyViolation struct {
	TenantID  uuid.UUID `json:"tenant_id"`
	Slug      string    `json:"slug"`
	CheckKey  string    `json:"check_key"`
	Entity    string    `json:"entity"`
	EntityID  uuid.UUID `json:"entity_id"`
	Detail    string    `json:"detail"`
	DeltaCent int64     `json:"delta_cents"`
}

// AccuracyCheckSummary counts violations per check so a caller can see the shape
// of the problem before reading 500 rows.
type AccuracyCheckSummary struct {
	CheckKey   string `json:"check_key"`
	Count      int    `json:"count"`
	TotalDelta int64  `json:"total_delta_cents"`
	// What the check means, so a report is readable without the migration open.
	Means string `json:"means"`
}

// checkMeanings keeps the operator-facing explanation next to the key. Anything
// missing here still reports; it just has no prose.
var checkMeanings = map[string]string{
	"order_arithmetic": "A closed order's stored total doesn't equal subtotal − discount " +
		"+ service charge (+ VAT when added on top). The receipt doesn't add up.",
	"payments_vs_total": "A closed order's recorded payments don't equal its total. The " +
		"close guard proved they did at close time, so something changed afterwards.",
	"post_close_void": "A line was voided AFTER its order closed. The order's totals are " +
		"frozen, so they no longer match the lines behind them.",
	"credit_without_tab": "A credit charge with no credit account attached: a receivable " +
		"that belongs to nobody, invisible on the Credit page.",
	"negative_tab": "A credit account has been collected past its balance.",
	"cash_without_shift": "Cash taken outside any shift. It is in the cash ledger but can " +
		"never appear in a drawer count.",
	"reversal_incomplete": "A reversed credit collection with no recorded actor.",
	"shift_expected_cash": "A closed shift's stamped expected cash no longer matches a " +
		"recomputation from its own rows — the signed-off reconciliation has drifted.",
	"drawer_expense_unlinked": "An expense marked paid from the drawer with no matching " +
		"drawer movement, so the till never recorded the money leaving.",
	"addon_price_fold": "An order line's unit price doesn't equal its own price plus its " +
		"add-ons. Add-on money is folded into unit_price_cents so every report stays " +
		"correct without knowing add-ons exist; a mismatch means the line is charging " +
		"the wrong amount or an add-on was changed without re-folding.",
	"addon_cost_fold": "An order line's unit cost doesn't equal its own cost plus its " +
		"add-ons' costs, so this line's COGS — and any margin computed from it — is wrong.",
}

type AccuracyCheckResp struct {
	// Healthy is true when nothing at all was flagged.
	Healthy    bool                   `json:"healthy"`
	Scope      string                 `json:"scope"` // "all tenants" or a slug
	Summary    []AccuracyCheckSummary `json:"summary"`
	Violations []AccuracyViolation    `json:"violations"`
	// Truncated reports that the violation list was capped (the summary counts
	// are complete regardless).
	Truncated bool `json:"truncated"`
}

// maxViolationRows caps the response body. The summary still counts everything,
// so a tenant with thousands of bad rows reports honestly instead of timing out
// a browser.
const maxViolationRows = 500

func AccuracyCheck(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	tx := appctx.Tx(r.Context())

	var tenantPtr *uuid.UUID
	scope := "all tenants"
	if raw := strings.TrimSpace(r.URL.Query().Get("tenant_id")); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid tenant_id")
			return
		}
		tenantPtr = &id
		scope = id.String()
	}
	log.InfoContext(r.Context(), "super.accuracy_check", "scope", scope)

	// Two functions, one result set. platform_accuracy_check_addons (0062) lives
	// separately so it doesn't have to duplicate the 120-line UNION in 0056, but
	// it returns the identical shape and applies the same is_platform_admin
	// gating, so UNIONing here keeps every caller (this endpoint, the e2e
	// harness's assertClean) covering both.
	rows, err := tx.Query(r.Context(), `
		SELECT tenant_id, slug, check_key, entity, entity_id, detail, delta_cents
		FROM platform_accuracy_check($1)
		UNION ALL
		SELECT tenant_id, slug, check_key, entity, entity_id, detail, delta_cents
		FROM platform_accuracy_check_addons($1)
		ORDER BY 3, 1, 5
	`, tenantPtr)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := AccuracyCheckResp{
		Scope:      scope,
		Summary:    []AccuracyCheckSummary{},
		Violations: []AccuracyViolation{},
	}
	counts := map[string]*AccuracyCheckSummary{}
	order := []string{}
	for rows.Next() {
		var v AccuracyViolation
		if err := rows.Scan(&v.TenantID, &v.Slug, &v.CheckKey, &v.Entity,
			&v.EntityID, &v.Detail, &v.DeltaCent); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		s, seen := counts[v.CheckKey]
		if !seen {
			s = &AccuracyCheckSummary{CheckKey: v.CheckKey, Means: checkMeanings[v.CheckKey]}
			counts[v.CheckKey] = s
			order = append(order, v.CheckKey)
		}
		s.Count++
		s.TotalDelta += v.DeltaCent

		if len(out.Violations) < maxViolationRows {
			out.Violations = append(out.Violations, v)
		} else {
			out.Truncated = true
		}
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	for _, k := range order {
		out.Summary = append(out.Summary, *counts[k])
	}
	out.Healthy = len(out.Violations) == 0 && !out.Truncated

	if !out.Healthy {
		// Worth a log line even though the caller sees the body: an operator
		// running this and then closing the tab shouldn't be the only record.
		log.WarnContext(r.Context(), "super.accuracy_check.violations",
			"scope", scope, "checks", len(out.Summary), "rows", len(out.Violations))
	}
	writeJSON(w, http.StatusOK, out)
}
