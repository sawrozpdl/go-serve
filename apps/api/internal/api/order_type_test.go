package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Order type (0081)
//
// The design claim being guarded here is that order_type is DATA, not a
// synonym for "has no table". Every test below is a case the derived version
// would get wrong — which is why the derived version was not built.
// =========================================================================

func (fx *fixture) orderType(id uuid.UUID) string {
	fx.t.Helper()
	var s string
	fx.adminScan([]any{&s}, `SELECT order_type FROM orders WHERE id = $1`, id)
	return s
}

func TestOpenOrder_DefaultsTypeFromTable(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	table := fx.seedTable("T1")

	// A client that has never heard of order_type must keep producing correct
	// rows: this is exactly the meaning the product carried implicitly before
	// the column existed.
	var seated Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": table.String()}).
		expectStatus(201).decode(&seated)
	if seated.OrderType != OrderTypeDineIn {
		t.Fatalf("seated order_type = %q, want dine_in", seated.OrderType)
	}

	var loose Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/", map[string]any{}).
		expectStatus(201).decode(&loose)
	if loose.OrderType != OrderTypeTakeaway {
		t.Fatalf("table-less order_type = %q, want takeaway", loose.OrderType)
	}
}

func TestOpenOrder_ExplicitDelivery(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	// Delivery is the case a derived column cannot express at all: no table,
	// and emphatically not a takeaway.
	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"order_type": "delivery"}).
		expectStatus(201).decode(&o)
	if o.OrderType != OrderTypeDelivery {
		t.Fatalf("order_type = %q, want delivery", o.OrderType)
	}
	if got := fx.orderType(o.ID); got != OrderTypeDelivery {
		t.Fatalf("persisted order_type = %q, want delivery", got)
	}
}

func TestOpenOrder_RejectsUnknownType(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	before := fx.countRows("orders")
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"order_type": "dinein"}).
		expectErr(400, "bad_order_type")
	// A 4xx still COMMITS in this codebase, so "was it rejected" and "was
	// nothing written" are two different questions.
	if after := fx.countRows("orders"); after != before {
		t.Fatalf("a rejected order_type still wrote a row: %d -> %d", before, after)
	}
}

func TestOpenOrder_StaffMealIsAlwaysDineIn(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"staff_id": staff.String()}).
		expectStatus(201).decode(&o)
	if o.OrderType != OrderTypeDineIn {
		t.Fatalf("staff meal order_type = %q, want dine_in", o.OrderType)
	}

	// Asking for a takeaway staff meal is refused rather than silently
	// corrected — quietly overriding the caller would hide a client bug.
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"staff_id": staff.String(), "order_type": "takeaway"}).
		expectErr(400, "bad_order_type")
}

func TestOrderType_StaffMealConstraintIsEnforcedByTheDatabase(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")
	id := openStaffMeal(t, fx, staff, 20000, 6000, 1)

	// Not the handler's rule — the table's. A future code path that forgets
	// the check still cannot label a staff meal as a takeaway.
	if _, err := adminPool.Exec(context.Background(),
		`UPDATE orders SET order_type = 'takeaway' WHERE id = $1`, id); err == nil {
		t.Fatal("expected orders_staff_meal_is_dine_in to reject a takeaway staff meal")
	}
}

func TestSetOrderType_FlipsAnOpenTabWithoutTouchingItsTable(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	table := fx.seedTable("T1")

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": table.String()}).
		expectStatus(201).decode(&o)

	callHandler(t, fx, SetOrderType(testHub()), "POST", "/",
		map[string]any{"order_type": "takeaway"}, withParam("id", o.ID.String())).
		expectStatus(200)

	if got := fx.orderType(o.ID); got != OrderTypeTakeaway {
		t.Fatalf("order_type = %q, want takeaway", got)
	}
	// The guests are still sitting there while the food is boxed. Taking the
	// table away from them is what a derived column would have done.
	var stillSeated *uuid.UUID
	fx.adminScan([]any{&stillSeated},
		`SELECT service_table_id FROM orders WHERE id = $1`, o.ID)
	if stillSeated == nil || *stillSeated != table {
		t.Fatalf("service_table_id changed when the type did: %v", stillSeated)
	}
	if got := fx.tableStatus(table); got != "occupied" {
		t.Fatalf("table status = %q, want occupied", got)
	}
}

func TestSetOrderType_RejectsAClosedServe(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Momo", 10000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, 10000)
	// Close it directly: CloseOrder wants the bill paid first, and paying it is
	// not what this test is about.
	fx.closeOrderWithTotals(order)

	callHandler(t, fx, SetOrderType(testHub()), "POST", "/",
		map[string]any{"order_type": "delivery"}, withParam("id", order.String())).
		expectErr(409, "order_not_open")
}

func TestSetOrderType_RejectsAStaffMeal(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	staff := fx.seedStaff("Bikash")

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"staff_id": staff.String()}).
		expectStatus(201).decode(&o)

	callHandler(t, fx, SetOrderType(testHub()), "POST", "/",
		map[string]any{"order_type": "takeaway"}, withParam("id", o.ID.String())).
		expectErr(409, "staff_meal")
}

func TestSetOrderType_RejectsUnknownValue(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	order := fx.seedOpenOrder(nil)

	callHandler(t, fx, SetOrderType(testHub()), "POST", "/",
		map[string]any{"order_type": "eat-in"}, withParam("id", order.String())).
		expectErr(400, "bad_order_type")
}

func TestMoveOrder_PreservesOrderType(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	table := fx.seedTable("T1")

	// THE regression the "derive it from service_table_id" design would have
	// broken. A delivery order parked on a table while it waits for the rider
	// must still be a delivery; detaching it again must not make it a takeaway.
	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"order_type": "delivery"}).
		expectStatus(201).decode(&o)

	callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": table.String()}, withParam("id", o.ID.String())).
		expectStatus(200)
	if got := fx.orderType(o.ID); got != OrderTypeDelivery {
		t.Fatalf("after moving onto a table, order_type = %q, want delivery", got)
	}

	callHandler(t, fx, MoveOrder(testHub()), "POST", "/",
		map[string]any{"service_table_id": nil}, withParam("id", o.ID.String())).
		expectStatus(200)
	if got := fx.orderType(o.ID); got != OrderTypeDelivery {
		t.Fatalf("after detaching, order_type = %q, want delivery", got)
	}
}

func TestOrderType_ReachesKitchenAndHistory(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	cat := fx.seedCategory("Food")
	item := fx.seedMenuItem(cat, "Momo", 10000)

	var o Order
	callHandler(t, fx, OpenOrder(testHub()), "POST", "/",
		map[string]any{"order_type": "takeaway"}).
		expectStatus(201).decode(&o)
	callHandler(t, fx, AddOrderItems(testHub()), "POST", "/",
		map[string]any{"items": []map[string]any{{"menu_item_id": item.String(), "qty": 1}}},
		withParam("id", o.ID.String())).expectStatus(201)
	callHandler(t, fx, SendOrderToKitchen(testHub()), "POST", "/", nil,
		withParam("id", o.ID.String())).expectStatus(200)

	// The cook is the person who most needs to know, so the ticket carries it.
	var tickets struct {
		Tickets []KitchenTicket `json:"tickets"`
	}
	callHandler(t, fx, ListKitchenTickets, "GET", "/v1/kitchen/tickets", nil).
		expectStatus(200).decode(&tickets)
	if len(tickets.Tickets) == 0 {
		t.Fatal("no kitchen tickets")
	}
	if tickets.Tickets[0].OrderType != OrderTypeTakeaway {
		t.Fatalf("kitchen ticket order_type = %q, want takeaway", tickets.Tickets[0].OrderType)
	}
}
