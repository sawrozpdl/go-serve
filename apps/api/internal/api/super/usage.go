package super

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/platform/health"
)

// TenantUsage is the graded usage verdict for one cafe, plus the raw numbers
// behind it so the console never has to show a bare colour.
type TenantUsage struct {
	TenantID uuid.UUID `json:"tenant_id"`

	Status  health.Status         `json:"status"`
	Reasons []string              `json:"reasons"`
	Signals []health.SignalResult `json:"signals"`

	LastOrderClosedAt *time.Time      `json:"last_order_closed_at,omitempty"`
	Orders7d          int             `json:"orders_7d"`
	OrdersPrev28d     int             `json:"orders_prev_28d"`
	Gross7dCents      int64           `json:"gross_7d_cents"`
	LastShiftClosedAt *time.Time      `json:"last_shift_closed_at,omitempty"`
	OpenShiftSince    *time.Time      `json:"open_shift_since,omitempty"`
	OperatingDays7d   int             `json:"operating_days_7d"`
	ShiftClosedDays7d int             `json:"shift_closed_days_7d"`
	ActiveMembers7d   int             `json:"active_members_7d"`
	MenuItemCount     int             `json:"menu_item_count"`
	Adoption          health.Adoption `json:"adoption"`
}

// loadUsage runs the rollup and grades every row. Passing uuid.Nil loads all
// tenants; the tenant ages come from a companion query because the SQL function
// deliberately doesn't know about grading.
func loadUsage(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) ([]TenantUsage, error) {
	var arg any
	if tenantID != uuid.Nil {
		arg = tenantID
	}

	// Ages in one shot rather than per row — the alternative is an N+1 across
	// several thousand tenants.
	ages := map[uuid.UUID]int{}
	rows, err := tx.Query(ctx, `
		SELECT id, GREATEST(0, EXTRACT(day FROM now() - created_at)::int)
		FROM tenants WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id = $1)
	`, arg)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id uuid.UUID
		var age int
		if err := rows.Scan(&id, &age); err != nil {
			rows.Close()
			return nil, err
		}
		ages[id] = age
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = tx.Query(ctx, `SELECT * FROM platform_tenant_usage($1)`, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	now := time.Now()
	out := []TenantUsage{}
	for rows.Next() {
		var u TenantUsage
		var adoption health.Adoption
		if err := rows.Scan(
			&u.TenantID, &u.LastOrderClosedAt, &u.Orders7d, &u.OrdersPrev28d, &u.Gross7dCents,
			&u.LastShiftClosedAt, &u.OpenShiftSince, &u.OperatingDays7d, &u.ShiftClosedDays7d,
			&u.ActiveMembers7d, &u.MenuItemCount, &adoption,
		); err != nil {
			return nil, err
		}
		u.Adoption = adoption
		graded := health.Compute(now, health.Signals{
			TenantAgeDays:     ages[u.TenantID],
			LastOrderClosedAt: u.LastOrderClosedAt,
			Orders7d:          u.Orders7d,
			OrdersPrev28d:     u.OrdersPrev28d,
			OperatingDays7d:   u.OperatingDays7d,
			ShiftClosedDays7d: u.ShiftClosedDays7d,
			OpenShiftSince:    u.OpenShiftSince,
			ActiveMembers7d:   u.ActiveMembers7d,
			MenuItemCount:     u.MenuItemCount,
			Adoption:          adoption,
		})
		u.Status, u.Reasons, u.Signals = graded.Status, graded.Reasons, graded.Signals
		if u.Reasons == nil {
			u.Reasons = []string{}
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ListUsage — GET /v1/super/usage. Every cafe's usage verdict, plus a tally
// the console renders as filter chips.
func ListUsage(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	usage, err := loadUsage(r.Context(), tx, uuid.Nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	byStatus := map[health.Status]int{}
	for _, u := range usage {
		byStatus[u.Status]++
	}
	writeJSON(w, http.StatusOK, map[string]any{"usage": usage, "by_status": byStatus})
}

// ShiftLogEntry is one row of a cafe's recent shift history — the evidence
// behind a red shift_discipline signal.
type ShiftLogEntry struct {
	ID            uuid.UUID  `json:"id"`
	OpenedAt      time.Time  `json:"opened_at"`
	ClosedAt      *time.Time `json:"closed_at,omitempty"`
	ClosedByName  *string    `json:"closed_by_name,omitempty"`
	VarianceCents *int64     `json:"variance_cents,omitempty"`
}

// DailyPoint is one day of the sparkline, from the nightly snapshot.
type DailyPoint struct {
	Day        string `json:"day"`
	Orders     int    `json:"orders"`
	GrossCents int64  `json:"gross_cents"`
	Status     string `json:"status"`
}

// GetTenantUsage — GET /v1/super/tenants/{id}/usage. The detail view: the
// graded verdict, a 28-day trend from the snapshots, and the raw shift log so
// a bad grade is immediately explainable.
func GetTenantUsage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())

	usage, err := loadUsage(r.Context(), tx, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if len(usage) == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such tenant")
		return
	}

	// Trend comes from the nightly snapshot, not a live scan: it's the only
	// place the historical STATUS is recorded, and re-deriving 28 days of
	// grading on every page view would be wasteful.
	rows, err := tx.Query(r.Context(), `
		SELECT to_char(day, 'YYYY-MM-DD'), orders, gross_cents, status
		FROM tenant_health_daily
		WHERE tenant_id = $1 AND day >= (CURRENT_DATE - 27)
		ORDER BY day
	`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	trend := []DailyPoint{}
	for rows.Next() {
		var p DailyPoint
		if err := rows.Scan(&p.Day, &p.Orders, &p.GrossCents, &p.Status); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		trend = append(trend, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// The raw evidence behind the shift_discipline grade. shifts is FORCE-RLS
	// and /super sets no tenant context, so this goes through its own
	// self-gated DEFINER function (0059).
	log, err := loadShiftLog(r.Context(), tx, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"usage": usage[0], "trend": trend, "shifts": log,
	})
}

func loadShiftLog(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) ([]ShiftLogEntry, error) {
	rows, err := tx.Query(ctx, `SELECT * FROM platform_tenant_shift_log($1, 14)`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ShiftLogEntry{}
	for rows.Next() {
		var e ShiftLogEntry
		if err := rows.Scan(&e.ID, &e.OpenedAt, &e.ClosedAt, &e.ClosedByName, &e.VarianceCents); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
