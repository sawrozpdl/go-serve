package insight

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// gather.go is the ONLY file in this package that touches SQL. Detectors receive
// the finished Inputs and stay pure.
//
// # THE MONEY VOCABULARY IS COPIED, ON PURPOSE, AND GUARDED
//
// NetRevenueExpr and ClosedOrdersInWindow are verbatim copies of money.go's
// unexported netRevenueExpr and closedOrdersInWindow. They are duplicated rather
// than imported because internal/api will import THIS package for its handlers,
// so the dependency cannot run the other way. money.go remains the documented
// source of truth, and internal/api/money_insight_guard_test.go fails the build
// if the two ever diverge — which is the whole risk of a copy.
//
// Getting this right matters more than it looks: before money.go existed,
// "Sales" meant SUM(orders.total_cents) on the dashboard and SUM(qty ×
// unit_price) on profitability, and for a VAT-exclusive café the two differed by
// ~14%. A finding that quoted a different number from the screen it links to
// would destroy exactly the trust this feature exists to build.
const (
	// ClosedOrdersInWindow is the standard sales population, with `o` the orders
	// alias and $1/$2 the half-open window.
	ClosedOrdersInWindow = `o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2`
	// NetRevenueExpr is NET REVENUE — billed sales minus the VAT liability. THE
	// basis for profit, and therefore the basis every finding quotes.
	NetRevenueExpr = `COALESCE(SUM(o.total_cents - o.tax_cents), 0)::bigint`
)

const (
	// WindowDays is the period a brief examines. Thirty days rather than seven
	// because most of these signals — margin drift, coverage gaps, stale credit —
	// are too slow to read weekly, and a café's week-to-week revenue swing is
	// wide enough to drown them.
	WindowDays = 30
	// DisciplineDays is the shorter window for drawer reconciliation, which is a
	// habit rather than a trend. Matches what health grades over.
	DisciplineDays = 14
	// MaxCreditTabs / MaxBelowCostItems cap the per-café row counts so one
	// pathological café cannot produce a thousand-line brief. Anything trimmed is
	// still counted in the sentence, never silently dropped.
	MaxCreditTabs     = 25
	MaxBelowCostItems = 25
)

// Querier is the subset of pgx this package uses, so it works against a pool or
// a transaction without caring which. Both pgx.Tx and pgxpool.Pool satisfy it.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// WindowsFor builds the current and prior windows for a run, in absolute UTC
// instants ready for timestamptz comparison.
//
// Pure and separate from the SQL so the date arithmetic — the part most likely
// to be wrong, and wrong only in one timezone — is unit-testable.
//
// Both windows END at local midnight, so a brief only ever reports on COMPLETE
// days. Including the current partial day would make every morning's figures
// look like a collapse.
func WindowsFor(now time.Time, loc *time.Location, days int) (cur, prior Window) {
	local := now.In(loc)
	// Local midnight today, as an absolute instant. Same construction
	// resolveRangeFull uses to turn local day boundaries into UTC.
	end := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)

	cur = Window{From: end.AddDate(0, 0, -days), To: end}
	prior = Window{From: end.AddDate(0, 0, -2*days), To: end.AddDate(0, 0, -days)}
	return cur, prior
}

// Gather loads one café's snapshot. It must be called inside a transaction whose
// app.tenant_id GUC is set: every table it reads is confined by its own RLS
// policy, so the tenant scoping is the database's job and there is not a single
// `tenant_id = $n` in any query below.
func Gather(ctx context.Context, q Querier, now time.Time, tz string) (Inputs, error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	cur, prior := WindowsFor(now, loc, WindowDays)
	in := Inputs{Loc: loc, Window: cur, Prior: prior}

	// --- sales totals, both windows in one pass over the same index ---------
	if err := q.QueryRow(ctx, `
		SELECT
		  COALESCE(SUM(o.total_cents - o.tax_cents) FILTER (WHERE o.closed_at >= $1), 0)::bigint,
		  COALESCE(COUNT(*)                          FILTER (WHERE o.closed_at >= $1), 0)::int,
		  COALESCE(SUM(o.total_cents - o.tax_cents) FILTER (WHERE o.closed_at <  $1), 0)::bigint,
		  COALESCE(COUNT(*)                          FILTER (WHERE o.closed_at <  $1), 0)::int
		FROM orders o
		WHERE o.status = 'closed' AND o.closed_at >= $3 AND o.closed_at < $2
	`, cur.From, cur.To, prior.From).Scan(
		&in.Window.RevenueCents, &in.Window.OrderCount,
		&in.Prior.RevenueCents, &in.Prior.OrderCount,
	); err != nil {
		return in, err
	}

	// --- cost coverage + line count ----------------------------------------
	// The ratio is computed on the menu-item basis (qty × unit_price), which is
	// legitimate for a SHARE even though money.go forbids it for totals. The
	// detector converts that share back onto net revenue before quoting money.
	if err := q.QueryRow(ctx, `
		SELECT
		  COALESCE(SUM(oi.qty * oi.unit_price_cents) FILTER (WHERE oi.unit_cost_cents > 0), 0)::bigint,
		  COALESCE(SUM(oi.qty * oi.unit_price_cents), 0)::bigint,
		  COUNT(*)::int
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE `+ClosedOrdersInWindow+` AND oi.voided_at IS NULL
	`, cur.From, cur.To).Scan(
		&in.CostCoverage.KnownCents, &in.CostCoverage.TotalCents, &in.Window.LineCount,
	); err != nil {
		return in, err
	}

	// --- expense allocation coverage ---------------------------------------
	if err := q.QueryRow(ctx, `
		SELECT
		  COALESCE(SUM(e.amount_cents) FILTER (
		    WHERE EXISTS (SELECT 1 FROM expense_allocations ea WHERE ea.expense_id = e.id)), 0)::bigint,
		  COALESCE(SUM(e.amount_cents), 0)::bigint
		FROM expenses e
		WHERE e.deleted_at IS NULL AND e.paid_at >= $1 AND e.paid_at < $2
	`, cur.From, cur.To).Scan(&in.ExpenseCoverage.KnownCents, &in.ExpenseCoverage.TotalCents); err != nil {
		return in, err
	}

	// --- drawer discipline --------------------------------------------------
	discFrom := cur.To.AddDate(0, 0, -DisciplineDays)
	if err := q.QueryRow(ctx, `
		SELECT
		  (SELECT COUNT(DISTINCT (o.closed_at AT TIME ZONE $3)::date) FROM orders o
		   WHERE o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2)::int,
		  (SELECT COUNT(DISTINCT (s.closed_at AT TIME ZONE $3)::date) FROM shifts s
		   WHERE s.closed_at >= $1 AND s.closed_at < $2)::int,
		  (SELECT MIN(s.opened_at) FROM shifts s WHERE s.closed_at IS NULL)
	`, discFrom, cur.To, tz).Scan(
		&in.Close.TradingDays, &in.Close.ShiftCloseDays, &in.Close.OpenShiftSince,
	); err != nil {
		return in, err
	}

	// --- who was working ----------------------------------------------------
	if err := q.QueryRow(ctx, `
		SELECT COUNT(DISTINCT o.opened_by_user_id)::int
		FROM orders o WHERE `+ClosedOrdersInWindow+`
	`, cur.From, cur.To).Scan(&in.ActiveStaff); err != nil {
		return in, err
	}

	// --- acts that reduce takings ------------------------------------------
	// Three near-identical shapes; one helper rather than three copies, because
	// the per-actor rollup is the part that would drift.
	var errAct error
	in.Voids, errAct = gatherAct(ctx, q, `
		SELECT oi.voided_by_user_id, COALESCE(u.name, ''),
		       COUNT(*)::int, COALESCE(SUM(oi.qty * oi.unit_price_cents), 0)::bigint
		FROM order_items oi
		LEFT JOIN users u ON u.id = oi.voided_by_user_id
		WHERE oi.voided_at >= $1 AND oi.voided_at < $2
		GROUP BY 1, 2`, cur.From, cur.To)
	if errAct != nil {
		return in, errAct
	}
	in.Discounts, errAct = gatherAct(ctx, q, `
		SELECT oa.applied_by_user_id, COALESCE(u.name, ''),
		       COUNT(*)::int, COALESCE(SUM(oa.amount_cents), 0)::bigint
		FROM order_adjustments oa
		LEFT JOIN users u ON u.id = oa.applied_by_user_id
		WHERE oa.type = 'discount' AND oa.created_at >= $1 AND oa.created_at < $2
		GROUP BY 1, 2`, cur.From, cur.To)
	if errAct != nil {
		return in, errAct
	}
	// payment_voids only exists from migration 0067, so this is empty for every
	// café until the first payment is retracted after that deploy. That is
	// correct: before it, the act left no trace at all.
	in.Retractions, errAct = gatherAct(ctx, q, `
		SELECT pv.voided_by_user_id, COALESCE(u.name, ''),
		       COUNT(*)::int, COALESCE(SUM(pv.amount_cents), 0)::bigint
		FROM payment_voids pv
		LEFT JOIN users u ON u.id = pv.voided_by_user_id
		WHERE pv.voided_at >= $1 AND pv.voided_at < $2
		GROUP BY 1, 2`, cur.From, cur.To)
	if errAct != nil {
		return in, errAct
	}

	if in.Categories, err = gatherCategories(ctx, q, cur, prior); err != nil {
		return in, err
	}
	if in.BelowCost, err = gatherBelowCost(ctx, q, cur); err != nil {
		return in, err
	}
	if in.Credit, err = gatherCredit(ctx, q, now); err != nil {
		return in, err
	}
	if in.DeadItems, err = gatherDeadItems(ctx, q, cur); err != nil {
		return in, err
	}
	if in.Shifts, err = gatherShifts(ctx, q, discFrom, cur.To); err != nil {
		return in, err
	}
	if in.Integrity, err = gatherIntegrity(ctx, q); err != nil {
		return in, err
	}
	return in, nil
}

// gatherAct rolls up one countable act plus its per-actor split. The query must
// select (actor_id, actor_name, count, value) grouped by actor.
func gatherAct(ctx context.Context, q Querier, sql string, args ...any) (ActSummary, error) {
	var out ActSummary
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			uid  *uuid.UUID
			name string
			n    int
			v    int64
		)
		if err := rows.Scan(&uid, &name, &n, &v); err != nil {
			return out, err
		}
		out.Count += n
		out.ValueCents += v
		// A null actor (a legacy row, or a user since hard-deleted) still counts
		// toward the total but cannot be attributed to anybody.
		if uid == nil {
			continue
		}
		if name == "" {
			name = "a former team member"
		}
		out.Actors = append(out.Actors, ActorStat{UserID: *uid, Name: name, Count: n, ValueCents: v})
	}
	return out, rows.Err()
}

func gatherCategories(ctx context.Context, q Querier, cur, prior Window) ([]CategoryMargin, error) {
	rows, err := q.Query(ctx, `
		SELECT mc.id, mc.name,
		  COALESCE(SUM(oi.qty * oi.unit_price_cents) FILTER (WHERE o.closed_at >= $1), 0)::bigint,
		  COALESCE(SUM(oi.qty * oi.unit_cost_cents)  FILTER (WHERE o.closed_at >= $1), 0)::bigint,
		  COALESCE(SUM(oi.qty * oi.unit_price_cents) FILTER (WHERE o.closed_at <  $1), 0)::bigint,
		  COALESCE(SUM(oi.qty * oi.unit_cost_cents)  FILTER (WHERE o.closed_at <  $1), 0)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		JOIN menu_categories mc ON mc.id = mi.category_id
		WHERE o.status = 'closed' AND o.closed_at >= $3 AND o.closed_at < $2
		  AND oi.voided_at IS NULL
		GROUP BY mc.id, mc.name
	`, cur.From, cur.To, prior.From)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CategoryMargin
	for rows.Next() {
		var c CategoryMargin
		if err := rows.Scan(&c.ID, &c.Name, &c.RevenueCents, &c.CostCents,
			&c.PriorRevenueCents, &c.PriorCostCents); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func gatherBelowCost(ctx context.Context, q Querier, cur Window) ([]ItemMargin, error) {
	// Grouped by the PRICE AND COST AS SOLD, not by the item's current row: the
	// line snapshots what it actually charged and cost at the time, and a price
	// that has since been corrected must not make history look wrong.
	rows, err := q.Query(ctx, `
		SELECT oi.menu_item_id, MAX(mi.name),
		       oi.unit_price_cents, oi.unit_cost_cents,
		       SUM(oi.qty)::float8,
		       (SUM(oi.qty * (oi.unit_cost_cents - oi.unit_price_cents)))::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		WHERE `+ClosedOrdersInWindow+`
		  AND oi.voided_at IS NULL
		  AND oi.unit_cost_cents > 0
		  AND oi.unit_cost_cents >= oi.unit_price_cents
		GROUP BY oi.menu_item_id, oi.unit_price_cents, oi.unit_cost_cents
		ORDER BY 6 DESC
		LIMIT `+itoa(MaxBelowCostItems), cur.From, cur.To)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ItemMargin
	for rows.Next() {
		var it ItemMargin
		if err := rows.Scan(&it.ID, &it.Name, &it.PriceCents, &it.CostCents, &it.Qty, &it.LostCents); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func gatherCredit(ctx context.Context, q Querier, now time.Time) ([]CreditTab, error) {
	rows, err := q.Query(ctx, `
		SELECT ht.id, ht.name,
		  (COALESCE((SELECT SUM(p.amount_cents) FROM payments p
		             WHERE p.house_tab_id = ht.id AND p.method = 'house_tab'), 0)
		   - COALESCE((SELECT SUM(s.amount_cents) FROM house_tab_settlements s
		               WHERE s.house_tab_id = ht.id AND s.reversed_at IS NULL), 0))::bigint,
		  (SELECT MAX(s.recorded_at) FROM house_tab_settlements s
		   WHERE s.house_tab_id = ht.id AND s.reversed_at IS NULL)
		FROM house_tabs ht
		WHERE ht.deleted_at IS NULL
		ORDER BY 3 DESC
		LIMIT `+itoa(MaxCreditTabs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CreditTab
	for rows.Next() {
		var (
			t        CreditTab
			lastPaid *time.Time
		)
		if err := rows.Scan(&t.ID, &t.Name, &t.BalanceCents, &lastPaid); err != nil {
			return nil, err
		}
		if lastPaid != nil {
			d := int(now.Sub(*lastPaid).Hours() / 24)
			if d < 0 {
				d = 0
			}
			t.DaysSincePayment = &d
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func gatherDeadItems(ctx context.Context, q Querier, cur Window) ([]DeadItem, error) {
	rows, err := q.Query(ctx, `
		SELECT mi.id, mi.name,
		       EXISTS (SELECT 1 FROM order_items oi WHERE oi.menu_item_id = mi.id)
		FROM menu_items mi
		WHERE mi.is_active AND mi.deleted_at IS NULL
		  AND NOT EXISTS (
		    SELECT 1 FROM order_items oi
		    JOIN orders o ON o.id = oi.order_id
		    WHERE oi.menu_item_id = mi.id AND `+ClosedOrdersInWindow+`
		  )
		ORDER BY mi.name
	`, cur.From, cur.To)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeadItem
	for rows.Next() {
		var d DeadItem
		if err := rows.Scan(&d.ID, &d.Name, &d.EverSold); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func gatherShifts(ctx context.Context, q Querier, from, to time.Time) ([]ShiftVariance, error) {
	rows, err := q.Query(ctx, `
		SELECT s.id, s.closed_at, COALESCE(s.variance_cents, 0)::bigint
		FROM shifts s
		WHERE s.closed_at >= $1 AND s.closed_at < $2
		ORDER BY s.closed_at DESC
	`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ShiftVariance
	for rows.Next() {
		var s ShiftVariance
		if err := rows.Scan(&s.ID, &s.Day, &s.Diff); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func gatherIntegrity(ctx context.Context, q Querier) ([]IntegrityViolation, error) {
	rows, err := q.Query(ctx, `
		SELECT check_key, entity, entity_id, delta_cents, COALESCE(occurred_at, now())
		FROM tenant_integrity_check()
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IntegrityViolation
	for rows.Next() {
		var v IntegrityViolation
		if err := rows.Scan(&v.CheckKey, &v.Entity, &v.EntityID, &v.DeltaCents, &v.OccurredAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// itoa avoids pulling strconv in for two LIMIT clauses built from constants.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
