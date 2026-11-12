package cbms_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms/cbmstest"
)

var testCreds = cbms.Credentials{Username: "Test_CBMS", Password: "test@321", SellerPAN: "999999999"}

func bill(number string) json.RawMessage {
	b, _ := json.Marshal(cbms.Bill{
		FiscalYear: "2083.084", InvoiceNumber: number, InvoiceDate: "2083.07.21",
		Sales: cbms.Sales{TotalSales: 113000, TaxableSalesVAT: 100000, VAT: 13000},
	})
	return b
}

func ret(ref, cn string) json.RawMessage {
	b, _ := json.Marshal(cbms.Return{
		FiscalYear: "2083.084", RefInvoiceNumber: ref, CreditNoteNumber: cn, CreditNoteDate: "2083.07.21",
		ReasonForReturn: "wrong order",
		Sales:           cbms.Sales{TotalSales: 113000, TaxableSalesVAT: 100000, VAT: 13000},
	})
	return b
}

func TestAmountJSON(t *testing.T) {
	b, _ := json.Marshal(struct {
		A cbms.Amount `json:"a"`
	}{113050})
	if string(b) != `{"a":1130.50}` {
		t.Fatalf("marshal = %s", b)
	}
	var back struct {
		A cbms.Amount `json:"a"`
	}
	if err := json.Unmarshal(b, &back); err != nil || back.A != 113050 {
		t.Fatalf("unmarshal = %v %v", back.A, err)
	}
}

func TestEnvelopeShape(t *testing.T) {
	b, err := json.Marshal(cbms.Envelope{Endpoint: cbms.EndpointBill, Creds: testCreds, Document: bill("1"),
		IsRealtime: true, DatetimeClient: "2026-11-07T14:35:00"})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"username", "password", "seller_pan", "buyer_pan", "fiscal_year", "buyer_name",
		"invoice_number", "invoice_date", "total_sales", "taxable_sales_vat", "vat", "excisable_amount", "excise",
		"taxable_sales_hst", "hst", "amount_for_esf", "esf", "export_sales", "tax_exempted_sales", "isrealtime", "datetimeClient"} {
		if _, ok := m[k]; !ok {
			t.Errorf("wire body missing %q", k)
		}
	}
}

func TestHTTPClientAgainstFake(t *testing.T) {
	srv := cbmstest.New()
	defer srv.Close()
	c := cbms.NewHTTPClient(srv.URL)
	ctx := context.Background()
	post := func(ep cbms.Endpoint, doc json.RawMessage, creds cbms.Credentials) (cbms.Result, error) {
		return c.Post(ctx, cbms.Envelope{Endpoint: ep, Creds: creds, Document: doc, IsRealtime: true, DatetimeClient: "2026-11-07T14:35:00"})
	}

	if r, err := post(cbms.EndpointBill, bill("7"), testCreds); err != nil || r.Code != 200 || !r.Synced(cbms.EndpointBill) {
		t.Fatalf("first post = %+v %v", r, err)
	}
	if r, _ := post(cbms.EndpointBill, bill("7"), testCreds); r.Code != 101 || !r.Synced(cbms.EndpointBill) {
		t.Fatalf("duplicate = %+v (must count as synced)", r)
	}
	bad := testCreds
	bad.Password = "nope"
	if r, _ := post(cbms.EndpointBill, bill("8"), bad); r.Code != 100 || r.Synced(cbms.EndpointBill) {
		t.Fatalf("bad creds = %+v", r)
	}
	if r, _ := post(cbms.EndpointBillReturn, ret("999", "CN-1"), testCreds); r.Code != 105 {
		t.Fatalf("return for unknown bill = %+v", r)
	}
	if r, _ := post(cbms.EndpointBillReturn, ret("7", "CN-1"), testCreds); r.Code != 200 {
		t.Fatalf("return = %+v", r)
	}
	srv.FailNext = 1
	if _, err := post(cbms.EndpointBill, bill("9"), testCreds); !errors.Is(err, cbms.ErrTransport) {
		t.Fatalf("503 should be a transport failure, got %v", err)
	}
}

func TestParseResponse(t *testing.T) {
	cases := []struct {
		status int
		body   string
		code   int
		trans  bool
	}{
		{200, "200", 200, false},
		{200, ` "101" `, 101, false},
		{400, "104", 104, false},
		{200, `{"value":200}`, 200, false},
		{200, "<html>oops</html>", 103, false},
		{502, "bad gateway", 0, true},
	}
	for _, c := range cases {
		r, err := cbms.ParseResponse(c.status, []byte(c.body))
		if c.trans {
			if !errors.Is(err, cbms.ErrTransport) {
				t.Errorf("%d %q: want transport error, got %v", c.status, c.body, err)
			}
			continue
		}
		if err != nil || r.Code != c.code {
			t.Errorf("%d %q = %+v %v, want %d", c.status, c.body, r, err, c.code)
		}
	}
}

func TestMockScenarios(t *testing.T) {
	ctx := context.Background()
	env := func(n string) cbms.Envelope {
		return cbms.Envelope{Endpoint: cbms.EndpointBill, Creds: testCreds, Document: bill(n)}
	}
	m := cbms.NewMock(cbms.ScenarioOK)
	if r, _ := m.Post(ctx, env("1")); r.Code != 200 {
		t.Fatal("ok")
	}
	if r, _ := m.Post(ctx, env("1")); r.Code != 101 {
		t.Fatal("mock must de-duplicate bills")
	}
	m.SetScenarioFor("999999999", cbms.ScenarioAuth)
	if r, _ := m.Post(ctx, env("2")); r.Code != 100 {
		t.Fatal("per-PAN auth scenario")
	}
	f := cbms.NewMock(cbms.ScenarioFlaky)
	if _, err := f.Post(ctx, env("3")); !errors.Is(err, cbms.ErrTransport) {
		t.Fatal("flaky first attempt")
	}
	if r, _ := f.Post(ctx, env("3")); r.Code != 200 {
		t.Fatal("flaky second attempt")
	}
	// The totals identity is enforced like the real server.
	badDoc, _ := json.Marshal(cbms.Bill{FiscalYear: "2083.084", InvoiceNumber: "4", InvoiceDate: "2083.07.21",
		Sales: cbms.Sales{TotalSales: 100, VAT: 13}})
	if r, _ := m.Post(ctx, cbms.Envelope{Endpoint: cbms.EndpointBill, Creds: cbms.Credentials{SellerPAN: "1"}, Document: badDoc}); r.Code != 104 {
		t.Fatalf("unbalanced totals = %d", r.Code)
	}
	if len(m.Posts()) == 0 {
		t.Fatal("posts not recorded")
	}
}
