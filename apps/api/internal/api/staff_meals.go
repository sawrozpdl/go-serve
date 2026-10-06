package api

import (
	"net/http"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// STAFF MEALS — what feeding the team actually costs
//
// A staff meal is food given to the team at no charge, rung up on the cafe's
// one shared staff-meals tab. It closes to status 'staff_meal', so it is absent
// from every sales figure by construction (see 0076). That makes it invisible,
// which is right for revenue and wrong for the owner: the food still left the
// shelf, and somebody is paying for it.
//
// This report is where it becomes visible again — per menu item, never per
// person. Who ate what is deliberately not recorded (0085).
//
// Value is COST — what the cafe paid for the ingredients, snapshotted onto
// each line at add-time — not menu price. Menu price would include the margin
// the cafe never charged itself and would overstate the perk by whatever the
// markup is.
//
// No expenses row is written when a meal is eaten, deliberately: the food was
// already expensed when it was bought. See the header of 0076_staff_meals.sql.
// =========================================================================

// staffMealLabel is the shared tab's name on the floor and the kitchen docket.
const staffMealLabel = "Staff meals"

// StaffMealRow is one menu item's consumption over the window.
type StaffMealRow struct {
	MenuItemName string  `json:"menu_item_name"`
	Qty          float64 `json:"qty"`
	CostCents    int64   `json:"cost_cents"`
}

// StaffMealsReport is the whole window: per-item rows plus the totals, so the
// caller never has to re-add the parts and risk disagreeing with itself.
// TotalMeals counts finished staff-meal tabs, not people.
type StaffMealsReport struct {
	From           time.Time      `json:"from"`
	To             time.Time      `json:"to"`
	Label          string         `json:"label"`
	Rows           []StaffMealRow `json:"rows"`
	TotalMeals     int            `json:"total_meals"`
	TotalCostCents int64          `json:"total_cost_cents"`
}

// GET /v1/reports/staff-meals?range=...&from=&to=
func GetStaffMeals(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"),
		r.URL.Query().Get("from"),
		r.URL.Query().Get("to"))
	if err != nil {
		writeRangeErr(w, r, err)
		return
	}
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "reports.staff_meals",
		"range", rng.Label, "from", rng.From, "to", rng.To)

	out := StaffMealsReport{From: rng.From, To: rng.To, Label: rng.Label, Rows: []StaffMealRow{}}

	// Half-open [from, to) on closed_at, matching closedOrdersInWindow — a meal
	// eaten on a boundary instant belongs to exactly one window, so per-day
	// figures sum to the range figure.
	//
	// oi.menu_item_name is the name as rung up (0080), so a renamed or deleted
	// menu item still reports under what the kitchen actually made.
	tx := appctx.Tx(r.Context())
	if err := tx.QueryRow(r.Context(), `
		SELECT COUNT(*)::int
		FROM orders
		WHERE status = 'staff_meal' AND closed_at >= $1 AND closed_at < $2
	`, rng.From, rng.To).Scan(&out.TotalMeals); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	rows, err := tx.Query(r.Context(), `
		SELECT oi.menu_item_name,
		       SUM(oi.qty)::float8                         AS qty,
		       SUM(oi.qty * oi.unit_cost_cents)::bigint    AS cost_cents
		FROM orders o
		JOIN order_items oi ON oi.order_id = o.id AND oi.voided_at IS NULL
		WHERE o.status = 'staff_meal' AND o.closed_at >= $1 AND o.closed_at < $2
		GROUP BY oi.menu_item_name
		ORDER BY cost_cents DESC, oi.menu_item_name
	`, rng.From, rng.To)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	for rows.Next() {
		var row StaffMealRow
		if err := rows.Scan(&row.MenuItemName, &row.Qty, &row.CostCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out.Rows = append(out.Rows, row)
		out.TotalCostCents += row.CostCents
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, out)
}
