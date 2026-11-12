package api

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"io"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
)

// seedFiscalActivity: two settled bills (one partly returned), a supplier
// bill and a purchase return — enough to put a row in every register.
func seedFiscalActivity(t *testing.T, fx *fixture) {
	t.Helper()
	_, inv, _ := settleTwoLines(t, fx)
	settleTwoLines(t, fx)
	creditNote(t, fx, inv.ID, map[string]any{
		"kind": "sales_return", "reason": "cold", "refund_method": "cash",
		"lines": []map[string]any{{"line_no": 1, "qty": "1"}},
	}).expectStatus(201)
	exp := seedBankExpense(fx, "Bhatbhateni", 113000)
	var b struct {
		ID string `json:"id"`
	}
	purchaseBill(t, fx, exp, map[string]any{
		"supplier_name": "Bhatbhateni", "supplier_pan": "302222333", "supplier_bill_no": "BB-1",
		"supplier_bill_date_bs": currentBS(t), "taxable_cents": 100000, "vat_cents": 13000,
	}).expectStatus(201).decode(&b)
	callHandler(t, fx, CreatePurchaseReturn, "POST", "/", map[string]any{
		"reason": "damaged", "taxable_cents": 10000, "vat_cents": 1300,
	}, withParam("id", b.ID)).expectStatus(201)
}

func currentBS(t *testing.T) string {
	t.Helper()
	var s string
	if err := adminPool.QueryRow(context.Background(), `SELECT bs_date FROM invoices ORDER BY issued_at DESC LIMIT 1`).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func register(t *testing.T, fx *fixture, kind, query string) fiscal.Table {
	t.Helper()
	var tbl fiscal.Table
	callHandler(t, fx, GetRegister, "GET", "/", nil, withParam("kind", kind), withQuery(query)).
		expectStatus(200).decode(&tbl)
	return tbl
}

func TestRegisters_AllBuildAndReconcile(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	seedFiscalActivity(t, fx)

	for _, k := range fiscal.RegisterKinds {
		tbl := register(t, fx, k.Kind, "")
		if len(tbl.Columns) == 0 || tbl.Title == "" {
			t.Errorf("%s: empty table definition", k.Kind)
		}
	}

	mv := register(t, fx, "materialized_view", "")
	if len(mv.Rows) != 2 || len(mv.Columns) != 20 || mv.Columns[1].Label != "Bill_no" || mv.Columns[19].Label != "Transaction_Id" {
		t.Fatalf("standard view: %d rows, %d cols", len(mv.Rows), len(mv.Columns))
	}
	sales := register(t, fx, "sales_register", "")
	if sales.Totals["total"] != 226000 || sales.Totals["tax"] != 26000 {
		t.Fatalf("sales totals = %v", sales.Totals)
	}
	returns := register(t, fx, "sales_return_register", "")
	if len(returns.Rows) != 1 || returns.Totals["total"] != 56500 {
		t.Fatalf("sales returns = %+v", returns)
	}
	if rev := register(t, fx, "reverse_entry_register", ""); len(rev.Rows) != 0 {
		t.Fatal("a sales return leaked into the reverse entry register")
	}
	pur := register(t, fx, "purchase_register", "")
	if len(pur.Rows) != 1 || pur.Totals["tax"] != 13000 {
		t.Fatalf("purchases = %+v", pur.Totals)
	}
	vat := register(t, fx, "vat_summary", "")
	// Output 260.00 − returned 65.00 − (input 130.00 − purchase-return 13.00) = 78.00.
	if vat.Totals["net_vat"] != 26000-6500-(13000-1300) {
		t.Fatalf("net VAT = %d", vat.Totals["net_vat"])
	}
	if kots := register(t, fx, "order_slips", ""); len(kots.Rows) != 0 {
		t.Fatal("no KOTs were sent")
	}
}

func TestRegisters_Exports(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	seedFiscalActivity(t, fx)

	r := callHandler(t, fx, GetRegister, "GET", "/", nil, withParam("kind", "sales_register"), withQuery("format=csv")).expectStatus(200)
	// The header block has fewer fields than the data rows.
	cr := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(r.Body, []byte("\xEF\xBB\xBF"))))
	cr.FieldsPerRecord = -1
	recs, err := cr.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	last := recs[len(recs)-1]
	if last[0] != "Total" || last[4] != "2260.00" {
		t.Fatalf("csv totals row = %v", last)
	}
	if !strings.Contains(r.Hdr.Get("Content-Disposition"), "sales_register_") {
		t.Fatalf("filename = %s", r.Hdr.Get("Content-Disposition"))
	}

	x := callHandler(t, fx, GetRegister, "GET", "/", nil, withParam("kind", "materialized_view"), withQuery("format=xlsx")).expectStatus(200)
	f, err := excelize.OpenReader(bytes.NewReader(x.Body))
	if err != nil {
		t.Fatalf("xlsx: %v", err)
	}
	rows, _ := f.GetRows("Register")
	found := false
	for _, row := range rows {
		if len(row) > 1 && row[1] == "Bill_no" {
			found = true
		}
	}
	if !found {
		t.Fatal("xlsx lacks the Annex 5 header row")
	}

	xm := callHandler(t, fx, GetRegister, "GET", "/", nil, withParam("kind", "purchase_register"), withQuery("format=xml")).expectStatus(200)
	var anyDoc struct {
		XMLName xml.Name
	}
	if err := xml.Unmarshal(xm.Body, &anyDoc); err != nil || anyDoc.XMLName.Local != "register" {
		t.Fatalf("xml: %v %v", anyDoc.XMLName, err)
	}

	// Exports are audited.
	var n int
	fx.adminScan([]any{&n}, `SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND action = 'export'`, fx.Tenant)
	if n != 3 {
		t.Fatalf("export audit rows = %d", n)
	}
}

func TestAuditChain_DetectsTampering(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	seedFiscalActivity(t, fx)
	var res AuditChainResult
	callHandler(t, fx, VerifyAuditChain, "GET", "/", nil).expectStatus(200).decode(&res)
	if !res.OK || res.RowsChecked < 5 {
		t.Fatalf("fresh chain = %+v", res)
	}
	// The app role cannot change the log at all…
	if err := fx.appExecErr(`UPDATE audit_log SET summary = 'x' WHERE tenant_id = current_tenant_id()`); err == nil {
		t.Fatal("app role edited the audit log")
	}
	// …and an owner-level edit is detected.
	fx.adminExec(`UPDATE audit_log SET summary = 'nothing to see' WHERE tenant_id = $1 AND chain_seq = 3`, fx.Tenant)
	callHandler(t, fx, VerifyAuditChain, "GET", "/", nil).expectStatus(200).decode(&res)
	if res.OK || res.FirstBadSeq == nil || *res.FirstBadSeq != 3 {
		t.Fatalf("tampered chain = %+v", res)
	}
}

func TestRecordsArchive(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	seedFiscalActivity(t, fx)
	r := callHandler(t, fx, ExportFiscalRecords, "GET", "/", nil).expectStatus(200)
	zr, err := zip.NewReader(bytes.NewReader(r.Body), int64(len(r.Body)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	var manifest struct {
		PAN   string `json:"pan"`
		Files []struct {
			Name   string `json:"name"`
			Rows   int    `json:"rows"`
			SHA256 string `json:"sha256"`
		} `json:"files"`
	}
	sums := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		data, _ := io.ReadAll(rc)
		rc.Close()
		if f.Name == "manifest.json" {
			if err := json.Unmarshal(data, &manifest); err != nil {
				t.Fatal(err)
			}
			continue
		}
		s := sha256.Sum256(data)
		sums[f.Name] = hex.EncodeToString(s[:])
		if bytes.Contains(data, []byte("cbms_password_enc")) {
			t.Fatalf("%s leaks the CBMS password column", f.Name)
		}
	}
	if manifest.PAN == "" || len(manifest.Files) < 20 {
		t.Fatalf("manifest = %+v", manifest)
	}
	for _, f := range manifest.Files {
		if sums[f.Name] != f.SHA256 {
			t.Fatalf("%s: manifest sha mismatch", f.Name)
		}
		if f.Name == "tables/invoices.csv" && f.Rows != 2 {
			t.Fatalf("invoices rows = %d", f.Rows)
		}
	}
}
