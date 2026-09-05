package api

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// STAFF MEALS — what feeding the team actually costs
//
// A staff meal is food taken by a member of staff at no charge. It closes to
// status 'staff_meal', so it is absent from every sales figure by construction
// (see 0076). That makes it invisible, which is right for revenue and wrong for
// the owner: the food still left the shelf, and somebody is paying for it.
//
// This report is where it becomes visible again. Value is COST — what the cafe
// paid for the ingredients, snapshotted onto each line at add-time — not menu
// price. Menu price would include the margin the cafe never charged itself and
// would overstate the perk by whatever the markup is.
//
// No expenses row is written when a meal is eaten, deliberately: the food was
// already expensed when it was bought. See the header of 0076_staff_meals.sql.
// =========================================================================

// StaffMealRow is one staff member's consumption over the window.
type StaffMealRow struct {
	StaffID   *uuid.UUID `json:"staff_id"`
	StaffName string     `json:"staff_name"`
	Meals     int        `json:"meals"`
	Items     float64    `json:"items"`
	CostCents int64      `json:"cost_cents"`
}

// StaffMealsReport is the whole window: per-person rows plus the total, so the
// caller never has to re-add the parts and risk disagreeing with itself.
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
		writeErr(w, http.StatusBadRequest, "bad_range", err.Error())
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
	// staff_id is nullable (ON DELETE SET NULL): a departed staff member's
	// meals still happened and still cost money, so they are reported under a
	// placeholder rather than dropped.
	rows, err := appctx.Tx(r.Context()).Query(r.Context(), `
		SELECT o.staff_id,
		       COALESCE(sf.full_name, '(removed staff)') AS staff_name,
		       COUNT(DISTINCT o.id)::int                 AS meals,
		       COALESCE(SUM(oi.qty), 0)::float8          AS items,
		       COALESCE(SUM(oi.qty * oi.unit_cost_cents), 0)::bigint AS cost_cents
		FROM orders o
		LEFT JOIN staff sf ON sf.id = o.staff_id
		LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.voided_at IS NULL
		WHERE o.status = 'staff_meal' AND o.closed_at >= $1 AND o.closed_at < $2
		GROUP BY o.staff_id, sf.full_name
		ORDER BY cost_cents DESC, staff_name
	`, rng.From, rng.To)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	for rows.Next() {
		var row StaffMealRow
		if err := rows.Scan(&row.StaffID, &row.StaffName, &row.Meals, &row.Items, &row.CostCents); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out.Rows = append(out.Rows, row)
		out.TotalMeals += row.Meals
		out.TotalCostCents += row.CostCents
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, out)
}
