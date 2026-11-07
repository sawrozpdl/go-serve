package api

import (
	"sort"
	"sync"
	"testing"
)

func TestPrintInvoice_LabelSequence(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, out := settle(t, fx, []int64{11300}, nil)
	id := out.Invoice.ID.String()

	want := []struct{ title, copy string }{
		{"TAX INVOICE", "ORIGINAL"},
		{"INVOICE", "SECOND COPY"},
		{"TAX INVOICE", "Copy of Original (1)"},
		{"TAX INVOICE", "Copy of Original (2)"},
	}
	for i, w := range want {
		var pr PrintResponse
		callHandler(t, fx, PrintInvoice, "POST", "/", map[string]any{"device": "Counter"}, withParam("id", id)).
			expectStatus(200).decode(&pr)
		if pr.CopyNo != i+1 || pr.Title != w.title || pr.CopyLabel != w.copy || pr.Invoice == nil {
			t.Fatalf("print %d = %+v, want %s / %s", i+1, pr.PrintLabel, w.title, w.copy)
		}
	}

	var v InvoiceView
	callHandler(t, fx, GetOrderInvoice, "GET", "/", nil, withParam("id", out.Invoice.OrderID.String())).
		expectStatus(200).decode(&v)
	if len(v.Prints) != 4 || v.Prints[0].Device != "Counter" || v.Prints[3].CopyNo != 4 {
		t.Fatalf("print history = %+v", v.Prints)
	}
	if err := fx.appExecErr(`DELETE FROM print_log WHERE doc_id = $1`, out.Invoice.ID); err == nil {
		t.Fatal("print log rows are deletable")
	}
	if err := fx.appExecErr(`UPDATE print_log SET copy_no = 9 WHERE doc_id = $1`, out.Invoice.ID); err == nil {
		t.Fatal("print log rows are editable")
	}
}

func TestPrintInvoice_PANLabels(t *testing.T) {
	fx := newFiscalTenant(t, "pan")
	_, out := settle(t, fx, []int64{5000}, nil)
	var p1, p2 PrintResponse
	callHandler(t, fx, PrintInvoice, "POST", "/", nil, withParam("id", out.Invoice.ID.String())).expectStatus(200).decode(&p1)
	callHandler(t, fx, PrintInvoice, "POST", "/", nil, withParam("id", out.Invoice.ID.String())).expectStatus(200).decode(&p2)
	if p1.Title != "INVOICE" || p1.CopyLabel != "ORIGINAL" || p2.CopyLabel != "Copy of Original (1)" {
		t.Fatalf("PAN labels = %+v / %+v", p1.PrintLabel, p2.PrintLabel)
	}
}

// Two devices printing at once never both get the original.
func TestPrintInvoice_ConcurrentPrintsGetDistinctCopies(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	_, out := settle(t, fx, []int64{11300}, nil)
	const n = 6
	copies := make([]int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var pr PrintResponse
			r := callHandler(t, fx, PrintInvoice, "POST", "/", nil, withParam("id", out.Invoice.ID.String()))
			if r.Code == 200 {
				r.decode(&pr)
				copies[i] = pr.CopyNo
			}
		}(i)
	}
	wg.Wait()
	sort.Ints(copies)
	for i, c := range copies {
		if c != i+1 {
			t.Fatalf("copy numbers = %v, want 1..%d", copies, n)
		}
	}
}

func TestHistory_CarriesInvoice(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	order, out := settle(t, fx, []int64{11300}, nil)
	body := callHandler(t, fx, GetOrderHistory, "GET", "/", nil).expectStatus(200).json()
	orders, _ := body["orders"].([]any)
	found := false
	for _, o := range orders {
		m := o.(map[string]any)
		if m["id"] == order.String() {
			inv, _ := m["invoice"].(map[string]any)
			if inv == nil || inv["number"] != out.Invoice.Number {
				t.Fatalf("history invoice = %v", m["invoice"])
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("settled order missing from history: %v", body)
	}
}
