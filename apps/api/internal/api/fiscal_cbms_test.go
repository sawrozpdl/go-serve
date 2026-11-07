package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms/cbmstest"
)

// withFiscalSettings installs process-wide fiscal settings (an encryption key
// and the given client) for one test and restores the previous ones after.
func withFiscalSettings(t *testing.T, client cbms.Client, mode string) {
	t.Helper()
	prev := fiscal.CurrentSettings()
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	fiscal.Configure(fiscal.Settings{EncryptionKey: key, KeyID: "test", CBMS: client, CBMSMode: mode})
	t.Cleanup(func() { fiscal.Configure(prev) })
}

type subRow struct {
	Status, LastError string
	Attempts          int
	LastCode          *int
	SyncedVia         *string
	IsRealtime        *bool
	NextAttempt       time.Time
}

func loadSub(t *testing.T, fx *fixture, invID uuid.UUID) subRow {
	t.Helper()
	var s subRow
	fx.adminScan([]any{&s.Status, &s.LastError, &s.Attempts, &s.LastCode, &s.SyncedVia, &s.IsRealtime, &s.NextAttempt}, `
		SELECT status, last_error, attempts, last_code, synced_via, is_realtime, next_attempt_at
		FROM cbms_submissions WHERE doc_type = 'invoice' AND doc_id = $1`, invID)
	return s
}

// runWorker runs one pass as the APP role (appPool), so the column grants on
// cbms_submissions are exercised exactly as in production.
func runWorker(t *testing.T, c cbms.Client) {
	t.Helper()
	w := fiscal.NewCBMSWorker(appPool, c, discardLogger())
	if _, err := w.RunOnce(context.Background()); err != nil {
		t.Fatalf("worker pass: %v", err)
	}
}

func makeDue(fx *fixture) {
	fx.adminExec(`UPDATE cbms_submissions SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = $1`, fx.Tenant)
}

func saveCBMS(t *testing.T, fx *fixture, user, pass string) {
	t.Helper()
	callHandler(t, fx, UpdateCBMSCredentials, "PUT", "/", map[string]any{
		"enabled": true, "username": user, "password": pass,
	}).expectStatus(200)
}

func TestCBMS_InvoiceQueuedAndPostedToFake(t *testing.T) {
	srv := cbmstest.New()
	defer srv.Close()
	live := cbms.NewHTTPClient(srv.URL)
	withFiscalSettings(t, live, "live")

	fx := newFiscalTenant(t, "vat")
	_, out := settle(t, fx, []int64{11300}, nil)
	inv := out.Invoice

	// Queued with the invoice, in the same transaction.
	if s := loadSub(t, fx, inv.ID); s.Status != "pending" {
		t.Fatalf("submission = %+v", s)
	}

	// No CBMS login yet: the worker parks it (not lost, no attempt spent).
	runWorker(t, live)
	if s := loadSub(t, fx, inv.ID); s.Status != "pending" || s.Attempts != 0 || s.LastError == "" {
		t.Fatalf("unconfigured café = %+v", s)
	}

	// The password is sealed, never returned.
	saveCBMS(t, fx, "Test_CBMS", "test@321")
	var dto FiscalProfileDTO
	r := callHandler(t, fx, GetFiscalProfile, "GET", "/", nil).expectStatus(200)
	r.decode(&dto)
	if !dto.CBMSEnabled || !dto.CBMSPasswordSet || bytes.Contains(r.Body, []byte("test@321")) {
		t.Fatalf("profile leaks or lacks CBMS state: %s", r.Body)
	}
	var sealed []byte
	fx.adminScan([]any{&sealed}, `SELECT cbms_password_enc FROM fiscal_profiles WHERE tenant_id = $1`, fx.Tenant)
	if bytes.Contains(sealed, []byte("test@321")) {
		t.Fatal("CBMS password stored in the clear")
	}

	// Saving the login re-queued it; the worker posts it.
	runWorker(t, live)
	s := loadSub(t, fx, inv.ID)
	if s.Status != "synced" || s.SyncedVia == nil || *s.SyncedVia != "live" || s.LastCode == nil || *s.LastCode != 200 {
		t.Fatalf("after post = %+v", s)
	}
	fy, _ := bsdate.ParseFiscalYear(inv.FiscalYear)
	if !srv.HasBill(inv.SellerPAN, fy.CBMS(), inv.Number) {
		t.Fatal("fake CBMS never received the bill")
	}
	body := srv.Bodies[len(srv.Bodies)-1]
	if body["total_sales"].(float64) != 113 || body["vat"].(float64) != 13 || body["invoice_date"] != strings.ReplaceAll(inv.BSDate, "-", ".") {
		t.Fatalf("wire body = %v", body)
	}

	// A reported submission can neither be un-reported nor deleted.
	if err := fx.appExecErr(`UPDATE cbms_submissions SET status = 'pending' WHERE doc_id = $1`, inv.ID); err == nil {
		t.Error("synced submission went back to pending")
	}
	if err := fx.appExecErr(`DELETE FROM cbms_submissions WHERE doc_id = $1`, inv.ID); err == nil {
		t.Error("submission deleted")
	}

	// The invoice view shows the status.
	var v InvoiceView
	callHandler(t, fx, GetInvoice, "GET", "/", nil, withParam("id", inv.ID.String())).expectStatus(200).decode(&v)
	if v.CBMS == nil || v.CBMS.Status != "synced" {
		t.Fatalf("invoice view cbms = %+v", v.CBMS)
	}
}

func TestCBMS_FailuresRetryWithBackoff(t *testing.T) {
	srv := cbmstest.New()
	defer srv.Close()
	live := cbms.NewHTTPClient(srv.URL)
	withFiscalSettings(t, live, "live")

	fx := newFiscalTenant(t, "vat")
	saveCBMS(t, fx, "Test_CBMS", "wrong")
	_, out := settle(t, fx, []int64{5000}, nil)

	runWorker(t, live)
	s := loadSub(t, fx, out.Invoice.ID)
	if s.Status != "pending" || s.LastCode == nil || *s.LastCode != 100 || !s.NextAttempt.After(time.Now()) {
		t.Fatalf("bad credentials = %+v", s)
	}

	saveCBMS(t, fx, "Test_CBMS", "test@321") // fixes the login, re-queues
	srv.FailNext = 1
	runWorker(t, live)
	s = loadSub(t, fx, out.Invoice.ID)
	if s.Status != "pending" || s.LastCode != nil || s.Attempts != 2 || !s.NextAttempt.After(time.Now()) {
		t.Fatalf("transport failure = %+v", s)
	}

	makeDue(fx)
	runWorker(t, live)
	if s = loadSub(t, fx, out.Invoice.ID); s.Status != "synced" {
		t.Fatalf("after recovery = %+v", s)
	}
}

func TestCBMS_RealtimeFlag(t *testing.T) {
	srv := cbmstest.New()
	defer srv.Close()
	live := cbms.NewHTTPClient(srv.URL)
	withFiscalSettings(t, live, "live")
	fx := newFiscalTenant(t, "vat")
	saveCBMS(t, fx, "Test_CBMS", "test@321")
	_, out := settle(t, fx, []int64{5000}, nil)
	// Pretend the invoice was issued an hour ago (outage): it posts late.
	fx.adminExec(`UPDATE cbms_submissions SET issued_at = now() - interval '1 hour' WHERE doc_id = $1`, out.Invoice.ID)
	runWorker(t, live)
	s := loadSub(t, fx, out.Invoice.ID)
	if s.Status != "synced" || s.IsRealtime == nil || *s.IsRealtime {
		t.Fatalf("late post must be isrealtime=false: %+v", s)
	}
	if srv.Bodies[len(srv.Bodies)-1]["isrealtime"] != false {
		t.Fatal("wire isrealtime should be false")
	}
}

func TestCBMS_MockNeverCountsAsReported(t *testing.T) {
	mock := cbms.NewMock(cbms.ScenarioOK)
	withFiscalSettings(t, mock, "mock")
	fx := newFiscalTenant(t, "vat")
	saveCBMS(t, fx, "Test_CBMS", "x")
	_, out := settle(t, fx, []int64{5000}, nil)
	runWorker(t, mock)
	s := loadSub(t, fx, out.Invoice.ID)
	if s.Status != "synced" || s.SyncedVia == nil || *s.SyncedVia != "mock" {
		t.Fatalf("mock sync = %+v", s)
	}
	var dto FiscalProfileDTO
	callHandler(t, fx, GetFiscalProfile, "GET", "/", nil).expectStatus(200).decode(&dto)
	if dto.CBMSCounts.Synced != 0 {
		t.Fatalf("mock syncs counted as reported to IRD: %+v", dto.CBMSCounts)
	}
	// Going live re-queues everything the mock "synced".
	var n int
	fx.adminScan([]any{&n}, `SELECT cbms_requeue_mock_synced()`)
	if s = loadSub(t, fx, out.Invoice.ID); s.Status != "pending" || n < 1 {
		t.Fatalf("after requeue (%d) = %+v", n, s)
	}
}

func TestCBMS_ConnectionTest(t *testing.T) {
	srv := cbmstest.New()
	defer srv.Close()
	withFiscalSettings(t, cbms.NewHTTPClient(srv.URL), "live")
	fx := newFiscalTenant(t, "vat")

	var res fiscal.ConnectionResult
	callHandler(t, fx, TestCBMSConnection, "POST", "/", nil).expectStatus(200).decode(&res)
	if res.OK {
		t.Fatal("no credentials but test passed")
	}
	saveCBMS(t, fx, "Test_CBMS", "test@321")
	callHandler(t, fx, TestCBMSConnection, "POST", "/", nil).expectStatus(200).decode(&res)
	if !res.OK || res.Code != 105 {
		t.Fatalf("valid login = %+v", res)
	}
	saveCBMS(t, fx, "Test_CBMS", "nope")
	callHandler(t, fx, TestCBMSConnection, "POST", "/", nil).expectStatus(200).decode(&res)
	if res.OK || res.Code != 100 {
		t.Fatalf("wrong login = %+v", res)
	}
}

func TestCBMS_ReturnWaitsForItsBill(t *testing.T) {
	srv := cbmstest.New()
	defer srv.Close()
	live := cbms.NewHTTPClient(srv.URL)
	withFiscalSettings(t, live, "live")
	fx := newFiscalTenant(t, "vat")
	_, inv, _ := settleTwoLines(t, fx)
	var re fiscal.CreditNote
	creditNote(t, fx, inv.ID, map[string]any{"kind": "reversal", "reason": "wrong table", "refund_method": "cash"}).
		expectStatus(201).decode(&re)

	// The bill fails in transport, so the return reaches CBMS first: 105.
	srv.FailNext = 1
	saveCBMS(t, fx, "Test_CBMS", "test@321")
	runWorker(t, live)
	var st, msg string
	fx.adminScan([]any{&st, &msg}, `SELECT status, last_error FROM cbms_submissions WHERE doc_id = $1`, re.ID)
	if st != "pending" || msg == "" {
		t.Fatalf("return before its bill = %s %q", st, msg)
	}
	makeDue(fx)
	runWorker(t, live) // bill now posts
	makeDue(fx)
	runWorker(t, live) // and the return after it
	fx.adminScan([]any{&st, &msg}, `SELECT status, last_error FROM cbms_submissions WHERE doc_id = $1`, re.ID)
	if st != "synced" {
		t.Fatalf("return = %s %q", st, msg)
	}
	last := srv.Bodies[len(srv.Bodies)-1]
	if last["credit_note_number"] != re.Number || last["ref_invoice_number"] != inv.Number || last["reason_for_return"] != "wrong table" {
		t.Fatalf("return body = %v", last)
	}
}
