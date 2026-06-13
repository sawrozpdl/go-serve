package api

// Integration tests for the 0033 staff additions:
//   - salary (amount + cadence) + weekly schedule on CreateStaff / UpdateStaff
//   - optional team-member link (user_id) with active-member validation
//   - the staff_pay ledger: ListStaffPay / CreateStaffPay / DeleteStaffPay

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// staffSeedPay inserts a staff_pay row directly via the admin pool.
func (fx *fixture) staffSeedPay(staffID uuid.UUID, paidOn string, amount float64) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO staff_pay (tenant_id, staff_id, paid_on, amount)
		 VALUES ($1, $2, $3::date, $4) RETURNING id`,
		fx.Tenant, staffID, paidOn, amount)
	return id
}

// =========================================================================
// Salary + schedule on CreateStaff / UpdateStaff
// =========================================================================

func TestCreateStaff_SalaryAndSchedulePersisted(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateStaff, "POST", "/", map[string]any{
		"full_name":      "Salaried Sam",
		"salary_amount":  25000.50,
		"salary_cadence": "monthly",
		"schedule": map[string]any{
			"1": map[string]any{"start": "09:00", "end": "17:00"},
			"2": map[string]any{"start": "09:00", "end": "17:00"},
		},
	}).expectStatus(201)

	var s Staff
	r.decode(&s)
	if s.SalaryAmount == nil || *s.SalaryAmount != 25000.50 {
		t.Fatalf("salary_amount = %v, want 25000.50", s.SalaryAmount)
	}
	if s.SalaryCadence != "monthly" {
		t.Fatalf("salary_cadence = %q, want monthly", s.SalaryCadence)
	}
	var days map[string]map[string]string
	if err := json.Unmarshal(s.Schedule, &days); err != nil {
		t.Fatalf("schedule unmarshal: %v (raw %s)", err, s.Schedule)
	}
	if len(days) != 2 || days["1"]["start"] != "09:00" || days["1"]["end"] != "17:00" {
		t.Fatalf("schedule = %s, want 2 weekday ranges", s.Schedule)
	}
}

func TestCreateStaff_DefaultCadenceMonthly(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "No Cadence"}).expectStatus(201)
	var s Staff
	r.decode(&s)
	if s.SalaryCadence != "monthly" {
		t.Fatalf("salary_cadence = %q, want monthly (default)", s.SalaryCadence)
	}
	if s.SalaryAmount != nil {
		t.Fatalf("salary_amount = %v, want nil", *s.SalaryAmount)
	}
}

func TestCreateStaff_InvalidCadenceRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateStaff, "POST", "/",
		map[string]any{"full_name": "Bad Cadence", "salary_cadence": "yearly"}).
		expectErr(400, "bad_request")
}

func TestCreateStaff_InvalidScheduleTimeRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateStaff, "POST", "/", map[string]any{
		"full_name": "Bad Time",
		"schedule":  map[string]any{"1": map[string]any{"start": "9am", "end": "17:00"}},
	}).expectErr(400, "bad_request")
}

func TestCreateStaff_ScheduleStartAfterEndRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateStaff, "POST", "/", map[string]any{
		"full_name": "Reversed",
		"schedule":  map[string]any{"3": map[string]any{"start": "18:00", "end": "09:00"}},
	}).expectErr(400, "bad_request")
}

func TestCreateStaff_InvalidScheduleDayKeyRejected(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateStaff, "POST", "/", map[string]any{
		"full_name": "Bad Day",
		"schedule":  map[string]any{"7": map[string]any{"start": "09:00", "end": "17:00"}},
	}).expectErr(400, "bad_request")
}

func TestUpdateStaff_SalaryAndScheduleUpdated(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Update Me", "active")
	r := callHandler(t, fx, UpdateStaff, "PATCH", "/", map[string]any{
		"salary_amount":  40000,
		"salary_cadence": "hourly",
		"schedule":       map[string]any{"0": map[string]any{"start": "07:00", "end": "18:00"}},
		"ended_on":       "2026-06-01",
	}, withParam("id", id.String())).expectStatus(200)

	var s Staff
	r.decode(&s)
	if s.SalaryAmount == nil || *s.SalaryAmount != 40000 {
		t.Fatalf("salary_amount = %v, want 40000", s.SalaryAmount)
	}
	if s.SalaryCadence != "hourly" {
		t.Fatalf("salary_cadence = %q, want hourly", s.SalaryCadence)
	}
	if s.EndedOn == nil || *s.EndedOn != "2026-06-01" {
		t.Fatalf("ended_on = %v, want 2026-06-01", s.EndedOn)
	}
}

func TestUpdateStaff_InvalidScheduleRejected(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Worker", "active")
	callHandler(t, fx, UpdateStaff, "PATCH", "/", map[string]any{
		"schedule": map[string]any{"1": map[string]any{"start": "10:00", "end": "10:00"}},
	}, withParam("id", id.String())).expectErr(400, "bad_request")
}

// =========================================================================
// Team-member link (user_id)
// =========================================================================

func TestUpdateStaff_LinkActiveMember(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Linkable", "active")
	memberID := fx.addUser("Waiter Wendy")

	r := callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"user_id": memberID.String()},
		withParam("id", id.String())).expectStatus(200)
	var s Staff
	r.decode(&s)
	if s.UserID == nil || *s.UserID != memberID {
		t.Fatalf("user_id = %v, want %v", s.UserID, memberID)
	}
}

func TestUpdateStaff_LinkUnknownUserRejected(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Linkable", "active")
	callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"user_id": uuid.NewString()},
		withParam("id", id.String())).expectErr(400, "bad_request")
}

func TestUpdateStaff_ClearUserUnlinks(t *testing.T) {
	fx := newTenant(t)
	memberID := fx.addUser("Linked Larry")
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO staff (tenant_id, full_name, user_id) VALUES ($1, 'Already Linked', $2) RETURNING id`,
		fx.Tenant, memberID)

	r := callHandler(t, fx, UpdateStaff, "PATCH", "/",
		map[string]any{"clear_user_id": true},
		withParam("id", id.String())).expectStatus(200)
	var s Staff
	r.decode(&s)
	if s.UserID != nil {
		t.Fatalf("user_id = %v after clear, want nil", *s.UserID)
	}
}

// =========================================================================
// Pay ledger
// =========================================================================

func TestListStaffPay_Empty(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("No Pay", "active")
	r := callHandler(t, fx, ListStaffPay, "GET", "/", nil,
		withParam("id", id.String())).expectStatus(200).json()
	pay, _ := r["pay"].([]any)
	if len(pay) != 0 {
		t.Fatalf("pay = %d, want 0", len(pay))
	}
}

func TestListStaffPay_StaffNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, ListStaffPay, "GET", "/", nil,
		withParam("id", uuid.NewString())).expectErr(404, "not_found")
}

func TestCreateStaffPay_Success(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Paid Pat", "active")
	r := callHandler(t, fx, CreateStaffPay, "POST", "/", map[string]any{
		"paid_on":      "2026-05-31",
		"amount":       30000,
		"period_label": "May 2026",
		"note":         "on time",
	}, withParam("id", id.String())).expectStatus(201)

	var p StaffPay
	r.decode(&p)
	if p.Amount != 30000 {
		t.Fatalf("amount = %v, want 30000", p.Amount)
	}
	if p.PaidOn != "2026-05-31" {
		t.Fatalf("paid_on = %q, want 2026-05-31", p.PaidOn)
	}
	if p.PeriodLabel != "May 2026" {
		t.Fatalf("period_label = %q", p.PeriodLabel)
	}
	if p.StaffID != id {
		t.Fatalf("staff_id = %v, want %v", p.StaffID, id)
	}
}

func TestCreateStaffPay_NonPositiveAmountRejected(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Worker", "active")
	callHandler(t, fx, CreateStaffPay, "POST", "/",
		map[string]any{"paid_on": "2026-05-31", "amount": 0},
		withParam("id", id.String())).expectErr(400, "bad_request")
}

func TestCreateStaffPay_MissingPaidOnRejected(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Worker", "active")
	callHandler(t, fx, CreateStaffPay, "POST", "/",
		map[string]any{"amount": 100},
		withParam("id", id.String())).expectErr(400, "bad_request")
}

func TestCreateStaffPay_StaffNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, CreateStaffPay, "POST", "/",
		map[string]any{"paid_on": "2026-05-31", "amount": 100},
		withParam("id", uuid.NewString())).expectErr(404, "not_found")
}

func TestListStaffPay_ReturnsRecordsNewestFirst(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("History", "active")
	fx.staffSeedPay(id, "2026-04-30", 100)
	fx.staffSeedPay(id, "2026-05-31", 200)

	r := callHandler(t, fx, ListStaffPay, "GET", "/", nil,
		withParam("id", id.String())).expectStatus(200).json()
	pay, _ := r["pay"].([]any)
	if len(pay) != 2 {
		t.Fatalf("pay = %d, want 2", len(pay))
	}
	first := pay[0].(map[string]any)["paid_on"].(string)
	if first != "2026-05-31" {
		t.Fatalf("first paid_on = %q, want 2026-05-31 (newest first)", first)
	}
}

func TestDeleteStaffPay_SoftDeletes(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Pay Owner", "active")
	payID := fx.staffSeedPay(id, "2026-05-31", 500)

	callHandler(t, fx, DeleteStaffPay, "DELETE", "/", nil,
		withParams(map[string]string{"id": id.String(), "payId": payID.String()})).
		expectStatus(204)

	var deleted bool
	fx.adminScan([]any{&deleted}, `SELECT deleted_at IS NOT NULL FROM staff_pay WHERE id = $1`, payID)
	if !deleted {
		t.Fatal("deleted_at still NULL after DeleteStaffPay")
	}
}

func TestDeleteStaffPay_NotFound(t *testing.T) {
	fx := newTenant(t)
	id := fx.staffSeedMember("Worker", "active")
	callHandler(t, fx, DeleteStaffPay, "DELETE", "/", nil,
		withParams(map[string]string{"id": id.String(), "payId": uuid.NewString()})).
		expectErr(404, "not_found")
}

func TestStaffPay_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	id := fx1.staffSeedMember("FX1 Staff", "active")
	fx1.staffSeedPay(id, "2026-05-31", 700)

	// fx2 must not see fx1's staff (RLS): list 404s on the staff existence check.
	callHandler(t, fx2, ListStaffPay, "GET", "/", nil,
		withParam("id", id.String())).expectErr(404, "not_found")
}
