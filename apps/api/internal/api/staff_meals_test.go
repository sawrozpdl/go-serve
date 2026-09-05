package api

import (
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Staff meals (0076)
//
// The whole design rests on one claim: a staff meal is invisible to every
// money figure. These tests are what make that claim checkable — the failure
// mode being guarded against is silent, since a staff meal counted as revenue
// looks exactly like a slightly better week.
// =========================================================================

func (fx *fixture) seedStaff(name string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO staff (tenant_id, full_name) VALUES ($1, $2) RETURNING id`,
		fx.Tenant, name)
	return id
}

// openStaffMeal rings up one item on a staff meal and closes it, returning the
// order id. Costs are set on the menu item so the report has something to sum.
func openStaffMeal(t *testing.T, fx *fixture, staffID uuid.UUID, priceCents, costCents int64, qty int) uuid.UUID {
	t.Helper()
	cat := fx.seedCategory("Food-" + uuid.NewString()[:8])
	item := fx.seedMenuItem(cat, "Momo-"+uuid.NewString()[:8], priceCents)
	fx.adminExec(`UPDATE menu_items SET cost_cents = $2 WHERE id = $1`, item, costCents)

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"staff_id": staffID.String()}).
		expectStatus(201).decode(&o)

	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []map[string]any{{"menu_item_id": item.String(), "qty": qty}}},
		withParam("id", o.ID.String())).
		expectStatus(201)

	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil,
		withParam("id", o.ID.String())).
		expectStatus(200)
	return o.ID
}

func TestStaffMeal_ClosesToItsOwnStatusWithNoMoney(t *testing.T) {
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")
	id := openStaffMeal(t, fx, staff, 20000, 6000, 2)

	var status string
	var total, subtotal, discount int64
	fx.adminScan([]any{&status, &total, &subtotal, &discount},
		`SELECT status::text, total_cents, subtotal_cents, discount_cents FROM orders WHERE id = $1`, id)
	if status != "staff_meal" {
		t.Fatalf("status = %q, want staff_meal", status)
	}
	// Zero across the board — not "priced then fully discounted", which would
	// have inflated the discount figure instead of the sales one.
	if total != 0 || subtotal != 0 || discount != 0 {
		t.Fatalf("money columns = subtotal %d, discount %d, total %d; want all zero",
			subtotal, discount, total)
	}
}

// The load-bearing test. A staff meal must not appear in ANY sales figure —
// which it cannot, since every one of them keys off status = 'closed'.
func TestStaffMeal_IsAbsentFromSalesFigures(t *testing.T) {
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")
	openStaffMeal(t, fx, staff, 20000, 6000, 2)

	var closedOrders, netRevenue int64
	fx.adminScan([]any{&closedOrders},
		`SELECT COUNT(*) FROM orders WHERE tenant_id = $1 AND status = 'closed'`, fx.Tenant)
	if closedOrders != 0 {
		t.Fatalf("closed orders = %d, want 0 — a staff meal must never be one", closedOrders)
	}
	fx.adminScan([]any{&netRevenue},
		`SELECT COALESCE(SUM(total_cents - tax_cents), 0)::bigint
		   FROM orders WHERE tenant_id = $1 AND status = 'closed'`, fx.Tenant)
	if netRevenue != 0 {
		t.Fatalf("net revenue = %d, want 0", netRevenue)
	}

	// And no payment row was invented to balance it.
	if n := fx.countRows("payments"); n != 0 {
		t.Fatalf("payments = %d, want 0 — nobody paid for a staff meal", n)
	}
}

func TestStaffMeal_StillDepletesStock(t *testing.T) {
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Cold Coffee", 15000)
	inv := fx.invSeedItem("Milk", "retail", "ml")
	fx.invSeedMenuItemLink(item, inv, "100")
	fx.invSeedMovement(inv, "1000", "purchase")

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"staff_id": staff.String()}).expectStatus(201).decode(&o)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []map[string]any{{"menu_item_id": item.String(), "qty": 2}}},
		withParam("id", o.ID.String())).expectStatus(201)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil,
		withParam("id", o.ID.String())).expectStatus(200)

	// The milk left the shelf whether or not anyone paid for it.
	got := fx.invQtyOnHand(inv)
	if got != "800.000" {
		t.Fatalf("qty_on_hand = %s, want 800.000 (1000 − 2×100)", got)
	}
}

func TestStaffMeal_ReportValuesAtCostNotPrice(t *testing.T) {
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")
	openStaffMeal(t, fx, staff, 20000, 6000, 2) // price 200.00, cost 60.00, qty 2

	r := callHandler(t, fx, GetStaffMeals, "GET", "/", nil, withQuery("range=30d")).
		expectStatus(200)
	var rep StaffMealsReport
	r.decode(&rep)

	if len(rep.Rows) != 1 {
		t.Fatalf("rows = %d, want 1; %+v", len(rep.Rows), rep.Rows)
	}
	row := rep.Rows[0]
	if row.StaffName != "Bikash" {
		t.Fatalf("staff_name = %q, want Bikash", row.StaffName)
	}
	// 2 × 6000 = 12000 at cost. At menu price it would read 40000 — the margin
	// the cafe never charged itself.
	if row.CostCents != 12000 {
		t.Fatalf("cost_cents = %d, want 12000 (cost, not the 40000 menu price)", row.CostCents)
	}
	if row.Meals != 1 {
		t.Fatalf("meals = %d, want 1", row.Meals)
	}
	if rep.TotalCostCents != 12000 {
		t.Fatalf("total_cost_cents = %d, want 12000", rep.TotalCostCents)
	}
}

func TestStaffMeal_TakesNoPayment(t *testing.T) {
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Momo", 20000)
	fx.seedOpenShift(100000)

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"staff_id": staff.String()}).expectStatus(201).decode(&o)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []map[string]any{{"menu_item_id": item.String(), "qty": 1}}},
		withParam("id", o.ID.String())).expectStatus(201)

	// Refused at the source, not left to fail confusingly at close.
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 20000},
		withParam("id", o.ID.String())).
		expectErr(409, "staff_meal_not_payable")
}

// Freeing the table is half the reason the feature exists.
func TestStaffMeal_CannotOccupyATable(t *testing.T) {
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")
	table := fx.seedTable("T1")

	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"staff_id": staff.String(), "service_table_id": table.String()}).
		expectErr(400, "bad_request")
}

func TestStaffMeal_UnknownStaffRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"staff_id": uuid.NewString()}).
		expectErr(400, "unknown_staff")
}

// A normal order is untouched by any of this.
func TestStaffMeal_NormalOrderStillClosesAsASale(t *testing.T) {
	fx := newTenant(t)
	// No VAT or service charge, so the amount paid below is the whole total.
	fx.adminExec(`UPDATE tenants SET vat_pct = 0, service_charge_pct = 0 WHERE id = $1`, fx.Tenant)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Momo", 20000)
	table := fx.seedTable("T1")
	fx.seedOpenShift(100000)

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": table.String()}).expectStatus(201).decode(&o)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []map[string]any{{"menu_item_id": item.String(), "qty": 1}}},
		withParam("id", o.ID.String())).expectStatus(201)
	callHandler(t, fx, RecordPayment(testHub()), "POST", "/",
		map[string]any{"method": "cash", "amount_cents": 20000},
		withParam("id", o.ID.String())).expectStatus(201)
	callHandler(t, fx, CloseOrder(testHub()), "POST", "/", nil,
		withParam("id", o.ID.String())).expectStatus(200)

	var status string
	var total int64
	fx.adminScan([]any{&status, &total},
		`SELECT status::text, total_cents FROM orders WHERE id = $1`, o.ID)
	if status != "closed" || total != 20000 {
		t.Fatalf("status = %q total = %d; want closed / 20000", status, total)
	}
}
