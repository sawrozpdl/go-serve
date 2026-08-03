package super

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/platform/health"
)

// =========================================================================
// Usage rollup (0059)
//
// health.Compute is unit-tested exhaustively in internal/platform/health.
// What's checked HERE is the thing those tests can't reach: that the SQL
// rollup counts the right rows, in the right tenant, from a /super session
// that has no app.tenant_id set at all.
// =========================================================================

// seedClosedOrder inserts a closed order at a specific time. Money columns are
// set explicitly because the usage rollup sums (total - tax) and
// setOrderStatus-style seeding would leave them at zero.
func (sf *superFixture) seedClosedOrder(tenantID uuid.UUID, closedAt time.Time, totalCents, taxCents int64) {
	sf.t.Helper()
	var userID uuid.UUID
	sf.adminScan([]any{&userID}, `SELECT id FROM users WHERE id = $1`, sf.AdminUser)
	if _, err := adminPool.Exec(context.Background(), `
		INSERT INTO orders (tenant_id, status, opened_by_user_id, opened_at, closed_at,
		                    subtotal_cents, tax_cents, total_cents)
		VALUES ($1, 'closed', $2, $3, $3, $4, $5, $4)
	`, tenantID, userID, closedAt, totalCents, taxCents); err != nil {
		sf.t.Fatalf("seedClosedOrder: %v", err)
	}
}

func (sf *superFixture) seedShift(tenantID uuid.UUID, openedAt time.Time, closedAt *time.Time) {
	sf.t.Helper()
	// $2 is cast on both uses: without it Postgres tries to deduce one type for
	// a parameter that appears as a bare uuid column value AND inside a CASE,
	// and gives up with 42P08.
	if _, err := adminPool.Exec(context.Background(), `
		INSERT INTO shifts (tenant_id, opened_by_user_id, opened_at, opening_float_cents,
		                    closed_by_user_id, closed_at)
		VALUES ($1, $2::uuid, $3, 0,
		        CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE $2::uuid END, $4::timestamptz)
	`, tenantID, sf.AdminUser, openedAt, closedAt); err != nil {
		sf.t.Fatalf("seedShift: %v", err)
	}
}

// usageFor reads one tenant's graded usage through the handler.
func usageFor(t *testing.T, sf *superFixture, tenantID uuid.UUID) TenantUsage {
	t.Helper()
	var out struct {
		Usage TenantUsage `json:"usage"`
	}
	callSuper(t, sf, GetTenantUsage, http.MethodGet,
		"/v1/super/tenants/"+tenantID.String()+"/usage", nil,
		superParam("id", tenantID.String())).
		expectStatus(http.StatusOK).decode(&out)
	return out.Usage
}

// The rollup must see orders even though the /super session sets no
// app.tenant_id — that's the whole reason it's a SECURITY DEFINER function.
func TestUsage_CountsOrdersWithoutTenantContext(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Busy Cafe")
	now := time.Now()
	for i := 1; i <= 3; i++ {
		sf.seedClosedOrder(tenantID, now.Add(-time.Duration(i)*24*time.Hour), 1000, 130)
	}

	u := usageFor(t, sf, tenantID)
	if u.Orders7d != 3 {
		t.Errorf("orders_7d = %d, want 3", u.Orders7d)
	}
	if u.OperatingDays7d != 3 {
		t.Errorf("operating_days_7d = %d, want 3", u.OperatingDays7d)
	}
	// Net revenue basis: (total - tax) per order.
	if want := int64(3 * (1000 - 130)); u.Gross7dCents != want {
		t.Errorf("gross_7d_cents = %d, want %d (net of tax)", u.Gross7dCents, want)
	}
	if u.LastOrderClosedAt == nil {
		t.Error("last_order_closed_at should be set")
	}
}

// The single most important property: one cafe's trade must never show up in
// another's numbers.
func TestUsage_DoesNotLeakAcrossTenants(t *testing.T) {
	sf := newSuperFixture(t)
	busy, _ := sf.seedTenant("Leaky A")
	quiet, _ := sf.seedTenant("Leaky B")
	now := time.Now()
	for i := 1; i <= 5; i++ {
		sf.seedClosedOrder(busy, now.Add(-time.Duration(i)*time.Hour), 500, 0)
	}

	if got := usageFor(t, sf, busy).Orders7d; got != 5 {
		t.Errorf("busy cafe orders_7d = %d, want 5", got)
	}
	if got := usageFor(t, sf, quiet).Orders7d; got != 0 {
		t.Errorf("quiet cafe orders_7d = %d, want 0 — another tenant's orders leaked in", got)
	}
}

// Only the last 7 days count towards orders_7d; the preceding four weeks form
// the baseline instead.
func TestUsage_WindowsSplitCurrentFromBaseline(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Windowed Cafe")
	now := time.Now()
	sf.seedClosedOrder(tenantID, now.Add(-2*24*time.Hour), 100, 0)  // this week
	sf.seedClosedOrder(tenantID, now.Add(-10*24*time.Hour), 100, 0) // baseline
	sf.seedClosedOrder(tenantID, now.Add(-30*24*time.Hour), 100, 0) // baseline
	sf.seedClosedOrder(tenantID, now.Add(-60*24*time.Hour), 100, 0) // outside both

	u := usageFor(t, sf, tenantID)
	if u.Orders7d != 1 {
		t.Errorf("orders_7d = %d, want 1", u.Orders7d)
	}
	if u.OrdersPrev28d != 2 {
		t.Errorf("orders_prev_28d = %d, want 2 (the 60-day-old order is outside the baseline)", u.OrdersPrev28d)
	}
}

// The scenario the whole feature exists for.
func TestUsage_TradingWithoutClosingShiftsIsAtRisk(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Sloppy Cafe")
	// Old enough to be graded, with an established baseline.
	sf.adminExec(`UPDATE tenants SET created_at = now() - interval '120 days' WHERE id = $1`, tenantID)
	now := time.Now()

	// Traded on 5 distinct days this week but closed a shift on only 1 of them.
	for d := 1; d <= 5; d++ {
		sf.seedClosedOrder(tenantID, now.Add(-time.Duration(d)*24*time.Hour), 1000, 0)
	}
	closed := now.Add(-24 * time.Hour)
	sf.seedShift(tenantID, closed.Add(-8*time.Hour), &closed)
	// Keep the other signals clean so shift discipline is unambiguously the cause.
	for d := 8; d <= 33; d++ {
		sf.seedClosedOrder(tenantID, now.Add(-time.Duration(d)*24*time.Hour), 1000, 0)
	}
	sf.adminExec(`UPDATE tenant_members SET last_seen_at = now() WHERE tenant_id = $1`, tenantID)

	u := usageFor(t, sf, tenantID)
	if u.OperatingDays7d != 5 || u.ShiftClosedDays7d != 1 {
		t.Fatalf("operating=%d closed=%d, want 5 and 1", u.OperatingDays7d, u.ShiftClosedDays7d)
	}
	if u.Status != health.StatusAtRisk {
		t.Errorf("status = %q, want at_risk", u.Status)
	}
	var named bool
	for _, r := range u.Reasons {
		if r == "shift_discipline" {
			named = true
		}
	}
	if !named {
		t.Errorf("reasons = %v, want shift_discipline named so the console can explain the colour", u.Reasons)
	}
}

func TestUsage_OpenShiftIsReported(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Open Shift Cafe")
	sf.seedShift(tenantID, time.Now().Add(-40*time.Hour), nil)

	u := usageFor(t, sf, tenantID)
	if u.OpenShiftSince == nil {
		t.Fatal("open_shift_since should be set for a shift that was never closed")
	}
}

// A cafe with no trade at all is dormant, not merely unhealthy.
func TestUsage_SilentCafeIsDormant(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Silent Cafe")
	sf.adminExec(`UPDATE tenants SET created_at = now() - interval '200 days' WHERE id = $1`, tenantID)

	if got := usageFor(t, sf, tenantID).Status; got != health.StatusDormant {
		t.Errorf("status = %q, want dormant", got)
	}
}

// A brand-new cafe must not be flagged just for not having a routine yet.
func TestUsage_NewCafeIsOnboarding(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Fresh Cafe")
	sf.adminExec(`UPDATE tenants SET created_at = now() - interval '3 days' WHERE id = $1`, tenantID)

	if got := usageFor(t, sf, tenantID).Status; got != health.StatusOnboarding {
		t.Errorf("status = %q, want onboarding for a 3-day-old café", got)
	}
}

// The engagement signal depends on tenant_members.last_seen_at, which is
// stamped by the auth.Heartbeat middleware.
func TestUsage_ActiveMembersFromLastSeen(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Team Cafe")
	other, _ := sf.seedUser("teammate")
	sf.adminExec(
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active'), ($1, $3, 'active')`,
		tenantID, sf.AdminUser, other)

	if got := usageFor(t, sf, tenantID).ActiveMembers7d; got != 0 {
		t.Errorf("active_members_7d = %d, want 0 before anyone is seen", got)
	}

	sf.adminExec(`UPDATE tenant_members SET last_seen_at = now() WHERE tenant_id = $1 AND user_id = $2`,
		tenantID, sf.AdminUser)
	if got := usageFor(t, sf, tenantID).ActiveMembers7d; got != 1 {
		t.Errorf("active_members_7d = %d, want 1", got)
	}

	// A stale stamp must not count.
	sf.adminExec(`UPDATE tenant_members SET last_seen_at = now() - interval '30 days'
	              WHERE tenant_id = $1 AND user_id = $2`, tenantID, other)
	if got := usageFor(t, sf, tenantID).ActiveMembers7d; got != 1 {
		t.Errorf("active_members_7d = %d, want 1 — a 30-day-old sighting is not recent activity", got)
	}
}

func TestUsage_AdoptionChecklist(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Adopting Cafe")

	u := usageFor(t, sf, tenantID)
	if u.Adoption.Credit || u.Adoption.Inventory || u.Adoption.Expenses {
		t.Errorf("a fresh café should have adopted nothing, got %+v", u.Adoption)
	}

	sf.adminExec(`INSERT INTO house_tabs (tenant_id, name) VALUES ($1, 'Regulars')`, tenantID)
	if !usageFor(t, sf, tenantID).Adoption.Credit {
		t.Error("credit should register once a house tab exists")
	}
}

func TestUsage_ListCoversEveryTenantAndTallies(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Listed Cafe")

	var out struct {
		Usage    []TenantUsage         `json:"usage"`
		ByStatus map[health.Status]int `json:"by_status"`
	}
	callSuper(t, sf, ListUsage, http.MethodGet, "/v1/super/usage", nil).
		expectStatus(http.StatusOK).decode(&out)

	var found bool
	for _, u := range out.Usage {
		if u.TenantID == tenantID {
			found = true
		}
	}
	if !found {
		t.Error("the list should include every non-deleted tenant")
	}
	total := 0
	for _, n := range out.ByStatus {
		total += n
	}
	if total != len(out.Usage) {
		t.Errorf("by_status sums to %d but there are %d rows", total, len(out.Usage))
	}
}

func TestUsage_MissingTenantIs404(t *testing.T) {
	sf := newSuperFixture(t)
	missing := uuid.New()
	callSuper(t, sf, GetTenantUsage, http.MethodGet,
		"/v1/super/tenants/"+missing.String()+"/usage", nil, superParam("id", missing.String())).
		expectErr(http.StatusNotFound, "not_found")
}

// The shift log is the evidence behind a red grade, so it must actually return
// the shifts — through its own DEFINER function, with no tenant context.
func TestUsage_ShiftLogReturnsRecentShifts(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Logged Cafe")
	now := time.Now()
	closed := now.Add(-24 * time.Hour)
	sf.seedShift(tenantID, closed.Add(-8*time.Hour), &closed)
	sf.seedShift(tenantID, now.Add(-2*time.Hour), nil)
	// Outside the 14-day window.
	old := now.Add(-40 * 24 * time.Hour)
	sf.seedShift(tenantID, old, &old)

	var out struct {
		Shifts []ShiftLogEntry `json:"shifts"`
	}
	callSuper(t, sf, GetTenantUsage, http.MethodGet,
		"/v1/super/tenants/"+tenantID.String()+"/usage", nil, superParam("id", tenantID.String())).
		expectStatus(http.StatusOK).decode(&out)

	if len(out.Shifts) != 2 {
		t.Fatalf("shift log has %d entries, want 2 (the 40-day-old one is outside the window)", len(out.Shifts))
	}
	if out.Shifts[0].ClosedAt != nil {
		t.Error("the newest shift is the open one, so its closed_at should be null")
	}
}
