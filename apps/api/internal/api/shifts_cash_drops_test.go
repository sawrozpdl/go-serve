package api

import (
	"fmt"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Local fixture helpers  (domain-prefix: shft / drop)
// =========================================================================

// shftSeedBankDeposit inserts a cash_drop of kind=bank_deposit (direction out)
// directly via the admin pool. Returns the cash_drop id.
func (fx *fixture) shftSeedBankDeposit(shiftID uuid.UUID, amountCents int64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO cash_drops
		  (tenant_id, shift_id, direction, kind, amount_cents, reason, notes, recorded_by_user_id)
		VALUES ($1, $2, 'out'::cash_drop_direction, 'bank_deposit'::cash_drop_kind, $3, '', '', $4)
		RETURNING id`,
		fx.Tenant, shiftID, amountCents, fx.User)
	return id
}

// shftSeedCorrection inserts a correction cash_drop (direction configurable).
func (fx *fixture) shftSeedCorrection(shiftID uuid.UUID, direction string, amountCents int64, notes string) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id}, `
		INSERT INTO cash_drops
		  (tenant_id, shift_id, direction, kind, amount_cents, reason, notes, recorded_by_user_id)
		VALUES ($1, $2, $3::cash_drop_direction, 'correction'::cash_drop_kind, $4, '', $5, $6)
		RETURNING id`,
		fx.Tenant, shiftID, direction, amountCents, notes, fx.User)
	return id
}

// shftSeedExpenseLinkedDrop inserts a cash_drop whose expense_id is set, so
// DeleteCashDrop returns expense_linked.
func (fx *fixture) shftSeedExpenseLinkedDrop(shiftID uuid.UUID, amountCents int64) uuid.UUID {
	fx.t.Helper()
	// Insert a minimal expense row with paid_from=drawer so the FK constraint
	// (expenses.shift_id → shifts.id) is satisfied.
	var expID uuid.UUID
	fx.adminScan([]any{&expID}, `
		INSERT INTO expenses
		  (tenant_id, vendor, amount_cents, recorded_by_user_id, paid_from, shift_id)
		VALUES ($1, 'test-vendor', $2, $3, 'drawer'::expense_source, $4)
		RETURNING id`,
		fx.Tenant, amountCents, fx.User, shiftID)

	var dropID uuid.UUID
	fx.adminScan([]any{&dropID}, `
		INSERT INTO cash_drops
		  (tenant_id, shift_id, direction, kind, amount_cents, reason, notes,
		   expense_id, recorded_by_user_id)
		VALUES ($1, $2, 'out'::cash_drop_direction, 'expense'::cash_drop_kind,
		        $3, '', '', $4, $5)
		RETURNING id`,
		fx.Tenant, shiftID, amountCents, expID, fx.User)
	return dropID
}

// shftSeedTransferLinkedDrop inserts a cash_drop of kind=transfer (direction
// out) directly, so DeleteCashDrop returns transfer_linked.
func (fx *fixture) shftSeedTransferLinkedDrop(shiftID uuid.UUID, amountCents int64) uuid.UUID {
	fx.t.Helper()
	var dropID uuid.UUID
	fx.adminScan([]any{&dropID}, `
		INSERT INTO cash_drops
		  (tenant_id, shift_id, direction, kind, amount_cents, reason, notes, recorded_by_user_id)
		VALUES ($1, $2, 'out'::cash_drop_direction, 'transfer'::cash_drop_kind, $3, '', '', $4)
		RETURNING id`,
		fx.Tenant, shiftID, amountCents, fx.User)
	return dropID
}

// shftDropCount returns the number of cash_drops rows scoped to the fixture tenant.
func (fx *fixture) shftDropCount() int {
	fx.t.Helper()
	return fx.countRows("cash_drops")
}

// shftAccountTransferCount returns account_transfers rows for the fixture tenant.
func (fx *fixture) shftAccountTransferCount() int {
	fx.t.Helper()
	return fx.countRows("account_transfers")
}

// shftOpenOrder creates a minimal open order with one item so a cash payment
// can be recorded against it and pinned to a shift.
func (fx *fixture) shftOpenOrder(priceCents int64) uuid.UUID {
	fx.t.Helper()
	cat := fx.seedCategory(fmt.Sprintf("cat-%s", uuid.NewString()[:6]))
	item := fx.seedMenuItem(cat, "item", priceCents)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 1, priceCents)
	return order
}

// =========================================================================
// GetCurrentShift
// =========================================================================

func TestGetCurrentShift_NoOpenShift(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, GetCurrentShift, "GET", "/", nil).
		expectStatus(200)
	// Handler writes null when no shift is open.
	if string(r.Body) != "null\n" && string(r.Body) != "null" {
		t.Fatalf("expected null body, got %q", string(r.Body))
	}
}

func TestGetCurrentShift_WithOpenShift(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(5000)

	r := callHandler(t, fx, GetCurrentShift, "GET", "/", nil).
		expectStatus(200)

	var s Shift
	r.decode(&s)
	if s.ID != shiftID {
		t.Fatalf("id = %s, want %s", s.ID, shiftID)
	}
	if s.OpeningFloatCents != 5000 {
		t.Fatalf("opening_float_cents = %d, want 5000", s.OpeningFloatCents)
	}
	if s.ClosedAt != nil {
		t.Fatalf("closed_at should be nil for open shift")
	}
}

func TestGetCurrentShift_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.seedOpenShift(1000)

	// fx2 should see no open shift even though fx1 has one.
	r := callHandler(t, fx2, GetCurrentShift, "GET", "/", nil).
		expectStatus(200)
	if string(r.Body) != "null\n" && string(r.Body) != "null" {
		t.Fatalf("expected null body for other tenant, got %q", string(r.Body))
	}
}

func TestGetCurrentShift_LiveCashTotals(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000) // float = 1000

	// Seed a cash payment (in) and a correction drop out.
	order := fx.shftOpenOrder(5000)
	fx.seedPayment(order, "cash", 3000, ptrUUID(shiftID))         // cashIn = 3000
	fx.shftSeedCorrection(shiftID, "out", 500, "test correction") // dropsOut = 500

	r := callHandler(t, fx, GetCurrentShift, "GET", "/", nil).
		expectStatus(200)
	var s Shift
	r.decode(&s)

	// expected = 1000 + 3000 + 0 - 500 = 3500
	if s.LiveExpectedCashCents != 3500 {
		t.Fatalf("live_expected_cash_cents = %d, want 3500", s.LiveExpectedCashCents)
	}
	if s.LiveCashInCents != 3000 {
		t.Fatalf("live_cash_in_cents = %d, want 3000", s.LiveCashInCents)
	}
	if s.LiveCashOutCents != 500 {
		t.Fatalf("live_cash_out_cents = %d, want 500", s.LiveCashOutCents)
	}
	// live_cash_count = cashIn - dropsOut = 3000 - 500 = 2500
	if s.LiveCashCount != 2500 {
		t.Fatalf("live_cash_count_cents = %d, want 2500", s.LiveCashCount)
	}
}

// =========================================================================
// OpenShift
// =========================================================================

func TestOpenShift_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, OpenShift, "POST", "/", "{not json").
		expectErr(400, "bad_request")
}

func TestOpenShift_NegativeFloat(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, OpenShift, "POST", "/",
		map[string]any{"opening_float_cents": -1}).
		expectErr(400, "bad_request")
}

func TestOpenShift_ZeroFloat(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, OpenShift, "POST", "/",
		map[string]any{"opening_float_cents": 0}).
		expectStatus(201)
	var s Shift
	r.decode(&s)
	if s.OpeningFloatCents != 0 {
		t.Fatalf("opening_float_cents = %d, want 0", s.OpeningFloatCents)
	}
	if s.ID == uuid.Nil {
		t.Fatal("id should not be nil")
	}
}

func TestOpenShift_Success(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, OpenShift, "POST", "/",
		map[string]any{"opening_float_cents": 10000, "notes": "morning shift"}).
		expectStatus(201)

	var s Shift
	r.decode(&s)
	if s.OpeningFloatCents != 10000 {
		t.Fatalf("opening_float_cents = %d, want 10000", s.OpeningFloatCents)
	}
	if s.Notes != "morning shift" {
		t.Fatalf("notes = %q, want 'morning shift'", s.Notes)
	}
	if s.ClosedAt != nil {
		t.Fatal("closed_at should be nil on open shift")
	}
	if s.OpenedByUserID != fx.User {
		t.Fatalf("opened_by_user_id = %s, want %s", s.OpenedByUserID, fx.User)
	}
	// opener email should be populated
	if s.OpenedByEmail == nil || *s.OpenedByEmail == "" {
		t.Fatal("opened_by_email should be set")
	}
}

func TestOpenShift_ConflictWhenAlreadyOpen(t *testing.T) {
	fx := newTenant(t)
	fx.seedOpenShift(1000) // first shift open

	callHandler(t, fx, OpenShift, "POST", "/",
		map[string]any{"opening_float_cents": 2000}).
		expectErr(409, "shift_already_open")
}

func TestOpenShift_CanOpenAfterClose(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000)
	fx.closeShift(shiftID)

	// Now a new shift can be opened.
	callHandler(t, fx, OpenShift, "POST", "/",
		map[string]any{"opening_float_cents": 500}).
		expectStatus(201)
}

// =========================================================================
// CloseShift
// =========================================================================

func TestCloseShift_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CloseShift(nil), "POST", "/", map[string]any{"closing_count_cents": 0},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestCloseShift_BadJSON(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000)
	callHandler(t, fx, CloseShift(nil), "POST", "/", "{bad json",
		withParam("id", shiftID.String())).
		expectErr(400, "bad_request")
}

func TestCloseShift_NegativeCount(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000)
	callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": -1},
		withParam("id", shiftID.String())).
		expectErr(400, "bad_request")
}

func TestCloseShift_NotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 0},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestCloseShift_AlreadyClosed(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000)
	fx.closeShift(shiftID)

	callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 1000},
		withParam("id", shiftID.String())).
		expectErr(409, "already_closed")
}

func TestCloseShift_ZeroCountSuccess(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	r := callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 0},
		withParam("id", shiftID.String())).
		expectStatus(200)
	var s Shift
	r.decode(&s)
	if s.ClosedAt == nil {
		t.Fatal("closed_at should be set after close")
	}
	if s.ClosedByUserID == nil || *s.ClosedByUserID != fx.User {
		t.Fatal("closed_by_user_id mismatch")
	}
}

// TestCloseShift_ReconciliationMath is the core math test.
//
//	float=1000, cashPayments=5000, dropsIn=2000 (correction in), dropsOut=3000 (bank_deposit out)
//	expected = 1000 + 5000 + 2000 - 3000 = 5000
//	closingCount = 4800
//	variance = 4800 - 5000 = -200
func TestCloseShift_ReconciliationMath(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000) // float = 1000

	// 2 cash payments totalling 5000
	order1 := fx.shftOpenOrder(2000)
	order2 := fx.shftOpenOrder(3000)
	fx.seedPayment(order1, "cash", 2000, ptrUUID(shiftID))
	fx.seedPayment(order2, "cash", 3000, ptrUUID(shiftID))

	// drop in: correction +2000
	fx.shftSeedCorrection(shiftID, "in", 2000, "extra cash found")
	// drop out: bank_deposit -3000
	fx.shftSeedBankDeposit(shiftID, 3000)

	r := callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 4800},
		withParam("id", shiftID.String())).
		expectStatus(200)

	var s Shift
	r.decode(&s)

	if s.ExpectedCashCents == nil {
		t.Fatal("expected_cash_cents should be set")
	}
	if *s.ExpectedCashCents != 5000 {
		t.Fatalf("expected_cash_cents = %d, want 5000", *s.ExpectedCashCents)
	}
	if s.VarianceCents == nil {
		t.Fatal("variance_cents should be set")
	}
	if *s.VarianceCents != -200 {
		t.Fatalf("variance_cents = %d, want -200", *s.VarianceCents)
	}
	if s.ClosingCountCents == nil || *s.ClosingCountCents != 4800 {
		t.Fatal("closing_count_cents should be 4800")
	}
}

// TestCloseShift_ReconciliationNoDrops: simple case — float + cash only.
func TestCloseShift_ReconciliationNoDrops(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(500) // float=500
	order := fx.shftOpenOrder(1000)
	fx.seedPayment(order, "cash", 1000, ptrUUID(shiftID))
	// expected = 500 + 1000 = 1500, count = 1500, variance = 0

	r := callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 1500},
		withParam("id", shiftID.String())).
		expectStatus(200)

	var s Shift
	r.decode(&s)
	if s.ExpectedCashCents == nil || *s.ExpectedCashCents != 1500 {
		t.Fatalf("expected_cash_cents = %v, want 1500", s.ExpectedCashCents)
	}
	if s.VarianceCents == nil || *s.VarianceCents != 0 {
		t.Fatalf("variance_cents = %v, want 0", s.VarianceCents)
	}
}

// TestCloseShift_NotesAppended: if the open shift had notes and a close note is
// supplied, they are concatenated with a newline.
func TestCloseShift_NotesAppended(t *testing.T) {
	fx := newTenant(t)
	// Seed a shift with existing notes via admin pool.
	var shiftID uuid.UUID
	fx.adminScan([]any{&shiftID}, `
		INSERT INTO shifts (tenant_id, opened_by_user_id, opening_float_cents, notes)
		VALUES ($1, $2, 0, 'open note') RETURNING id`,
		fx.Tenant, fx.User)

	r := callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 0, "notes": "close note"},
		withParam("id", shiftID.String())).
		expectStatus(200)

	var s Shift
	r.decode(&s)
	want := "open note\nclose note"
	if s.Notes != want {
		t.Fatalf("notes = %q, want %q", s.Notes, want)
	}
}

// TestCloseShift_NotesEmptyCloseLeavesPristine: empty close notes should not
// overwrite existing open notes.
func TestCloseShift_NotesEmptyCloseLeavesPristine(t *testing.T) {
	fx := newTenant(t)
	var shiftID uuid.UUID
	fx.adminScan([]any{&shiftID}, `
		INSERT INTO shifts (tenant_id, opened_by_user_id, opening_float_cents, notes)
		VALUES ($1, $2, 0, 'open note') RETURNING id`,
		fx.Tenant, fx.User)

	r := callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 0, "notes": ""},
		withParam("id", shiftID.String())).
		expectStatus(200)

	var s Shift
	r.decode(&s)
	if s.Notes != "open note" {
		t.Fatalf("notes = %q, want 'open note'", s.Notes)
	}
}

// TestCloseShift_OnlinePaymentsExcludedFromExpected: online/other payments do
// not count toward expected cash.
func TestCloseShift_OnlinePaymentsExcludedFromExpected(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)

	order := fx.shftOpenOrder(5000)
	fx.seedPayment(order, "other", 5000, ptrUUID(shiftID)) // online, not cash

	// No cash payments — expected = 0 + 0 + 0 - 0 = 0
	r := callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 0},
		withParam("id", shiftID.String())).
		expectStatus(200)

	var s Shift
	r.decode(&s)
	if s.ExpectedCashCents == nil || *s.ExpectedCashCents != 0 {
		t.Fatalf("expected_cash_cents = %v, want 0", s.ExpectedCashCents)
	}
}

// TestCloseShift_LiveExpectedAfterClose: a closed shift populates
// LiveExpectedCashCents from the persisted expected_cash_cents.
func TestCloseShift_LiveExpectedAfterClose(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000)
	order := fx.shftOpenOrder(4000)
	fx.seedPayment(order, "cash", 4000, ptrUUID(shiftID))
	// expected = 1000 + 4000 = 5000

	r := callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 4900},
		withParam("id", shiftID.String())).
		expectStatus(200)

	var s Shift
	r.decode(&s)
	if s.LiveExpectedCashCents != 5000 {
		t.Fatalf("live_expected_cash_cents = %d, want 5000", s.LiveExpectedCashCents)
	}
}

// =========================================================================
// ListShifts
// =========================================================================

func TestListShifts_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListShifts, "GET", "/", nil).
		expectStatus(200).json()
	shifts, _ := r["shifts"].([]any)
	if len(shifts) != 0 {
		t.Fatalf("shifts = %d, want 0", len(shifts))
	}
}

func TestListShifts_ReturnsMostRecentFirst(t *testing.T) {
	fx := newTenant(t)
	s1 := fx.seedOpenShift(100)
	// close first shift so second can be opened.
	fx.adminExec(`UPDATE shifts SET closed_at = now() - interval '1 hour',
	               closing_count_cents = 0, expected_cash_cents = 100, variance_cents = -100
	               WHERE id = $1`, s1)
	s2 := fx.seedOpenShift(200)

	r := callHandler(t, fx, ListShifts, "GET", "/", nil).
		expectStatus(200).json()
	shifts, _ := r["shifts"].([]any)
	if len(shifts) != 2 {
		t.Fatalf("shifts = %d, want 2", len(shifts))
	}
	// Most recent (s2) should come first.
	first := shifts[0].(map[string]any)
	if first["id"] != s2.String() {
		t.Fatalf("first shift id = %s, want most recent %s", first["id"], s2)
	}
}

func TestListShifts_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	fx1.seedOpenShift(1000)

	r := callHandler(t, fx2, ListShifts, "GET", "/", nil).
		expectStatus(200).json()
	shifts, _ := r["shifts"].([]any)
	if len(shifts) != 0 {
		t.Fatalf("shifts = %d for other tenant, want 0", len(shifts))
	}
}

func TestListShifts_ClosedShiftHasExpectedAndVariance(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(1000)
	order := fx.shftOpenOrder(2000)
	fx.seedPayment(order, "cash", 2000, ptrUUID(shiftID))

	callHandler(t, fx, CloseShift(nil), "POST", "/",
		map[string]any{"closing_count_cents": 3100},
		withParam("id", shiftID.String())).
		expectStatus(200)

	r := callHandler(t, fx, ListShifts, "GET", "/", nil).
		expectStatus(200).json()
	shifts, _ := r["shifts"].([]any)
	if len(shifts) != 1 {
		t.Fatalf("shifts = %d, want 1", len(shifts))
	}
	s := shifts[0].(map[string]any)
	// expected_cash_cents stored as integer — JSON float64
	if s["expected_cash_cents"] == nil {
		t.Fatal("expected_cash_cents should be set on closed shift in list")
	}
	if s["variance_cents"] == nil {
		t.Fatal("variance_cents should be set on closed shift in list")
	}
	// expected=3000, count=3100, variance=100
	if int64(s["expected_cash_cents"].(float64)) != 3000 {
		t.Fatalf("expected_cash_cents = %v, want 3000", s["expected_cash_cents"])
	}
	if int64(s["variance_cents"].(float64)) != 100 {
		t.Fatalf("variance_cents = %v, want 100", s["variance_cents"])
	}
}

// =========================================================================
// ListShiftPayments
// =========================================================================

func TestListShiftPayments_BadID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListShiftPayments, "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestListShiftPayments_UnknownShiftReturnsEmpty(t *testing.T) {
	fx := newTenant(t)
	// A random unknown UUID simply returns empty — no 404 in this handler.
	r := callHandler(t, fx, ListShiftPayments, "GET", "/", nil,
		withParam("id", uuid.NewString())).
		expectStatus(200).json()
	payments, _ := r["payments"].([]any)
	if len(payments) != 0 {
		t.Fatalf("payments = %d, want 0", len(payments))
	}
}

func TestListShiftPayments_Empty(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	r := callHandler(t, fx, ListShiftPayments, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200).json()
	payments, _ := r["payments"].([]any)
	if len(payments) != 0 {
		t.Fatalf("payments = %d, want 0", len(payments))
	}
}

func TestListShiftPayments_WithCashAndOnline(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)

	order1 := fx.shftOpenOrder(1000)
	order2 := fx.shftOpenOrder(2000)
	fx.seedPayment(order1, "cash", 1000, ptrUUID(shiftID))
	fx.seedPayment(order2, "other", 2000, ptrUUID(shiftID))

	r := callHandler(t, fx, ListShiftPayments, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200).json()
	payments, _ := r["payments"].([]any)
	if len(payments) != 2 {
		t.Fatalf("payments = %d, want 2", len(payments))
	}
}

func TestListShiftPayments_HouseTabExcluded(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	tab := fx.seedHouseTab("Staff", true)

	order := fx.seedOpenOrder(nil)
	// Insert house_tab payment directly to bypass RecordPayment checks.
	fx.adminExec(`
		INSERT INTO payments (tenant_id, order_id, shift_id, method, amount_cents,
		                      house_tab_id, recorded_by_user_id)
		VALUES ($1, $2, $3, 'house_tab'::payment_method, 500, $4, $5)`,
		fx.Tenant, order, shiftID, tab, fx.User)

	r := callHandler(t, fx, ListShiftPayments, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200).json()
	payments, _ := r["payments"].([]any)
	// house_tab is excluded
	if len(payments) != 0 {
		t.Fatalf("payments = %d, want 0 (house_tab excluded)", len(payments))
	}
}

func TestListShiftPayments_FieldsPresent(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	order := fx.shftOpenOrder(1500)
	fx.seedPayment(order, "cash", 1500, ptrUUID(shiftID))

	r := callHandler(t, fx, ListShiftPayments, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200)
	var body struct {
		Payments []ShiftPayment `json:"payments"`
	}
	r.decode(&body)
	if len(body.Payments) != 1 {
		t.Fatalf("payments = %d, want 1", len(body.Payments))
	}
	p := body.Payments[0]
	if p.ID == uuid.Nil {
		t.Fatal("id should not be nil")
	}
	if p.AmountCents != 1500 {
		t.Fatalf("amount_cents = %d, want 1500", p.AmountCents)
	}
	if p.Method != "cash" {
		t.Fatalf("method = %q, want cash", p.Method)
	}
	if p.OrderID != order {
		t.Fatalf("order_id = %s, want %s", p.OrderID, order)
	}
}

func TestListShiftPayments_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	shiftID := fx1.seedOpenShift(0)
	order := fx1.shftOpenOrder(1000)
	fx1.seedPayment(order, "cash", 1000, ptrUUID(shiftID))

	// fx2 queries fx1's shift id — should see empty (RLS).
	r := callHandler(t, fx2, ListShiftPayments, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200).json()
	payments, _ := r["payments"].([]any)
	if len(payments) != 0 {
		t.Fatalf("payments = %d for other tenant, want 0", len(payments))
	}
}

// =========================================================================
// ListCashDrops
// =========================================================================

func TestListCashDrops_BadShiftID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListCashDrops, "GET", "/", nil,
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestListCashDrops_Empty(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	r := callHandler(t, fx, ListCashDrops, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200).json()
	drops, _ := r["cash_drops"].([]any)
	if len(drops) != 0 {
		t.Fatalf("cash_drops = %d, want 0", len(drops))
	}
}

func TestListCashDrops_WithRows(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	fx.shftSeedBankDeposit(shiftID, 1000)
	fx.shftSeedCorrection(shiftID, "in", 500, "found extra")

	r := callHandler(t, fx, ListCashDrops, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200).json()
	drops, _ := r["cash_drops"].([]any)
	if len(drops) != 2 {
		t.Fatalf("cash_drops = %d, want 2", len(drops))
	}
}

func TestListCashDrops_FieldsPresent(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	fx.shftSeedBankDeposit(shiftID, 2000)

	r := callHandler(t, fx, ListCashDrops, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200)
	var body struct {
		CashDrops []CashDrop `json:"cash_drops"`
	}
	r.decode(&body)
	if len(body.CashDrops) != 1 {
		t.Fatalf("cash_drops = %d, want 1", len(body.CashDrops))
	}
	d := body.CashDrops[0]
	if d.ID == uuid.Nil {
		t.Fatal("id should not be nil")
	}
	if d.AmountCents != 2000 {
		t.Fatalf("amount_cents = %d, want 2000", d.AmountCents)
	}
	if d.Kind != "bank_deposit" {
		t.Fatalf("kind = %q, want bank_deposit", d.Kind)
	}
	if d.Direction != "out" {
		t.Fatalf("direction = %q, want out", d.Direction)
	}
	if d.ShiftID != shiftID {
		t.Fatalf("shift_id = %s, want %s", d.ShiftID, shiftID)
	}
	if d.RecordedByEmail == nil || *d.RecordedByEmail == "" {
		t.Fatal("recorded_by_email should be set")
	}
}

func TestListCashDrops_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	shiftID := fx1.seedOpenShift(0)
	fx1.shftSeedBankDeposit(shiftID, 500)

	// fx2 queries fx1's shift — should see empty.
	r := callHandler(t, fx2, ListCashDrops, "GET", "/", nil,
		withParam("id", shiftID.String())).
		expectStatus(200).json()
	drops, _ := r["cash_drops"].([]any)
	if len(drops) != 0 {
		t.Fatalf("cash_drops = %d for other tenant, want 0", len(drops))
	}
}

// =========================================================================
// CreateCashDrop
// =========================================================================

func TestCreateCashDrop_BadShiftID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "bank_deposit", "amount_cents": 100},
		withParam("id", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestCreateCashDrop_BadJSON(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	callHandler(t, fx, CreateCashDrop, "POST", "/", "{bad json",
		withParam("id", shiftID.String())).
		expectErr(400, "bad_request")
}

func TestCreateCashDrop_ZeroAmount(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "bank_deposit", "amount_cents": 0},
		withParam("id", shiftID.String())).
		expectErr(400, "bad_request")
}

func TestCreateCashDrop_NegativeAmount(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "bank_deposit", "amount_cents": -50},
		withParam("id", shiftID.String())).
		expectErr(400, "bad_request")
}

func TestCreateCashDrop_InvalidKind(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	for _, kind := range []string{"owner_draw", "paid_out", "paid_in", "petty_change", "expense", "transfer", "other", "bogus"} {
		callHandler(t, fx, CreateCashDrop, "POST", "/",
			map[string]any{"kind": kind, "amount_cents": 100},
			withParam("id", shiftID.String())).
			expectErr(400, "bad_request")
	}
}

func TestCreateCashDrop_CorrectionRequiresNotes(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	// Missing notes.
	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "correction", "amount_cents": 100, "direction": "in"},
		withParam("id", shiftID.String())).
		expectErr(400, "bad_request")
	// Blank notes.
	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "correction", "amount_cents": 100, "direction": "in", "notes": "   "},
		withParam("id", shiftID.String())).
		expectErr(400, "bad_request")
}

func TestCreateCashDrop_CorrectionInvalidDirection(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "correction", "amount_cents": 100, "notes": "ok", "direction": "sideways"},
		withParam("id", shiftID.String())).
		expectErr(400, "bad_request")
}

func TestCreateCashDrop_ShiftNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "bank_deposit", "amount_cents": 100},
		withParam("id", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestCreateCashDrop_ShiftClosed(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	fx.closeShift(shiftID)

	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "bank_deposit", "amount_cents": 500},
		withParam("id", shiftID.String())).
		expectErr(409, "shift_closed")
}

func TestCreateCashDrop_BankDepositSuccess(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)

	r := callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "bank_deposit", "amount_cents": 2500, "reason": "ref-001"},
		withParam("id", shiftID.String())).
		expectStatus(201)

	var d CashDrop
	r.decode(&d)
	if d.Kind != "bank_deposit" {
		t.Fatalf("kind = %q, want bank_deposit", d.Kind)
	}
	if d.Direction != "out" {
		t.Fatalf("direction = %q, want out (inferred)", d.Direction)
	}
	if d.AmountCents != 2500 {
		t.Fatalf("amount_cents = %d, want 2500", d.AmountCents)
	}
	if d.ShiftID != shiftID {
		t.Fatalf("shift_id mismatch")
	}
	if fx.shftDropCount() != 1 {
		t.Fatalf("cash_drops count = %d, want 1", fx.shftDropCount())
	}
	// Paired account_transfer should be created.
	if fx.shftAccountTransferCount() != 1 {
		t.Fatalf("account_transfers count = %d, want 1", fx.shftAccountTransferCount())
	}
}

func TestCreateCashDrop_CorrectionInSuccess(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)

	r := callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "correction", "amount_cents": 300, "direction": "in", "notes": "found extra"},
		withParam("id", shiftID.String())).
		expectStatus(201)

	var d CashDrop
	r.decode(&d)
	if d.Kind != "correction" {
		t.Fatalf("kind = %q, want correction", d.Kind)
	}
	if d.Direction != "in" {
		t.Fatalf("direction = %q, want in", d.Direction)
	}
	// No paired account_transfer for corrections.
	if fx.shftAccountTransferCount() != 0 {
		t.Fatalf("account_transfers count = %d, want 0 for correction", fx.shftAccountTransferCount())
	}
}

func TestCreateCashDrop_CorrectionOutSuccess(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)

	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "correction", "amount_cents": 100, "direction": "out", "notes": "petty cash error"},
		withParam("id", shiftID.String())).
		expectStatus(201)

	if fx.shftDropCount() != 1 {
		t.Fatalf("cash_drops count = %d, want 1", fx.shftDropCount())
	}
}

// TestCreateCashDrop_BankDepositDirectionIgnored: direction field is ignored
// for bank_deposit — it is always forced to "out".
func TestCreateCashDrop_BankDepositDirectionIgnored(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)

	// Even supplying direction="in" must be overridden to "out" by directionForKind.
	r := callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "bank_deposit", "amount_cents": 100, "direction": "in"},
		withParam("id", shiftID.String())).
		expectStatus(201)

	var d CashDrop
	r.decode(&d)
	if d.Direction != "out" {
		t.Fatalf("direction = %q, want out (forced by kind)", d.Direction)
	}
}

// =========================================================================
// DeleteCashDrop
// =========================================================================

func TestDeleteCashDrop_BadShiftID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": "bad", "dropId": uuid.NewString()})).
		expectErr(400, "bad_request")
}

func TestDeleteCashDrop_BadDropID(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": shiftID.String(), "dropId": "bad"})).
		expectErr(400, "bad_request")
}

func TestDeleteCashDrop_NotFound(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": shiftID.String(), "dropId": uuid.NewString()})).
		expectErr(404, "not_found")
}

func TestDeleteCashDrop_WrongShiftID(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	dropID := fx.shftSeedBankDeposit(shiftID, 500)

	// Querying with a mismatched shift id returns not_found.
	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": uuid.NewString(), "dropId": dropID.String()})).
		expectErr(404, "not_found")
}

func TestDeleteCashDrop_ShiftClosed(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	dropID := fx.shftSeedBankDeposit(shiftID, 500)
	fx.closeShift(shiftID)

	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": shiftID.String(), "dropId": dropID.String()})).
		expectErr(409, "shift_closed")
}

func TestDeleteCashDrop_ExpenseLinked(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	dropID := fx.shftSeedExpenseLinkedDrop(shiftID, 300)

	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": shiftID.String(), "dropId": dropID.String()})).
		expectErr(409, "expense_linked")
}

func TestDeleteCashDrop_TransferLinked(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	dropID := fx.shftSeedTransferLinkedDrop(shiftID, 200)

	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": shiftID.String(), "dropId": dropID.String()})).
		expectErr(409, "transfer_linked")
}

func TestDeleteCashDrop_OwnerCashLinked(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(10000)
	owner := fx.finSeedOwner("Alice", 100)

	// A withdrawal writes an owner_draw cash_drop paired with an
	// owner_cash_entries row (cash_drop_id FK, ON DELETE RESTRICT).
	callHandler(t, fx, CreateOwnerCashWithdrawal(testHub()), "POST", "/",
		map[string]any{"owner_id": owner, "amount_cents": 3000}).expectStatus(201)

	var dropID uuid.UUID
	fx.adminScan([]any{&dropID},
		`SELECT id FROM cash_drops WHERE tenant_id = $1 AND kind = 'owner_draw' LIMIT 1`,
		fx.Tenant)

	// Deleting the drawer-side row directly must be refused (not a 500 FK error).
	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": shiftID.String(), "dropId": dropID.String()})).
		expectErr(409, "owner_cash_linked")

	// Both the drop and its owner_cash_entry must survive.
	if n := fx.countRows("cash_drops"); n != 1 {
		t.Fatalf("cash_drops = %d, want 1 (delete refused)", n)
	}
	if n := fx.countRows("owner_cash_entries"); n != 1 {
		t.Fatalf("owner_cash_entries = %d, want 1 (delete refused)", n)
	}
}

func TestDeleteCashDrop_CorrectionSuccess(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)
	dropID := fx.shftSeedCorrection(shiftID, "in", 400, "test")

	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": shiftID.String(), "dropId": dropID.String()})).
		expectStatus(204)

	if fx.shftDropCount() != 0 {
		t.Fatalf("cash_drops count = %d, want 0 after delete", fx.shftDropCount())
	}
}

func TestDeleteCashDrop_BankDepositCascadesTransfer(t *testing.T) {
	fx := newTenant(t)
	shiftID := fx.seedOpenShift(0)

	// Create bank deposit via the handler so the paired transfer is created.
	callHandler(t, fx, CreateCashDrop, "POST", "/",
		map[string]any{"kind": "bank_deposit", "amount_cents": 1000},
		withParam("id", shiftID.String())).
		expectStatus(201)

	if fx.shftDropCount() != 1 {
		t.Fatalf("setup: cash_drops count = %d, want 1", fx.shftDropCount())
	}
	if fx.shftAccountTransferCount() != 1 {
		t.Fatalf("setup: account_transfers count = %d, want 1", fx.shftAccountTransferCount())
	}

	// Retrieve the drop id via admin.
	var dropID uuid.UUID
	fx.adminScan([]any{&dropID},
		`SELECT id FROM cash_drops WHERE tenant_id = $1 AND kind = 'bank_deposit' LIMIT 1`,
		fx.Tenant)

	callHandler(t, fx, DeleteCashDrop, "DELETE", "/", nil,
		withParams(map[string]string{"id": shiftID.String(), "dropId": dropID.String()})).
		expectStatus(204)

	if fx.shftDropCount() != 0 {
		t.Fatalf("cash_drops count = %d, want 0", fx.shftDropCount())
	}
	// Paired transfer should also be deleted.
	if fx.shftAccountTransferCount() != 0 {
		t.Fatalf("account_transfers count = %d, want 0 after cascaded delete", fx.shftAccountTransferCount())
	}
}
