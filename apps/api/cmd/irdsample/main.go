// Command irdsample produces the IRD sample set for a café's permit
// application (procedure 2082/2074 Annex 3; IRD office checklist items 10 and
// 11) by driving the real API, exactly as staff would:
//
//   - N settled bills (VAT-inclusive, some with a buyer PAN, cash and online),
//     each sent to the kitchen first so order slips (KOT) exist;
//   - bill 1 printed four times: TAX INVOICE, INVOICE (seller's copy),
//     Copy of Original (1), Copy of Original (2);
//   - a partial sales return and a same-day reverse entry;
//   - a supplier bill and a purchase return;
//   - every IRD register downloaded as Excel and CSV, plus documents.json.
//
// Run it against a café that is already in IRD fiscal mode, ideally with
// IRD's public CBMS test login (Test_CBMS / test@321, PAN 999999999) on a
// server in CBMS_MODE=live, so the Standard View shows Sync_with_IRD = Yes:
//
//	go run ./cmd/irdsample -api https://… -tenant ird-demo -token $TOKEN -out ./ird-samples
//
// The token is the owner's access token (from the web app's localStorage
// "cafe-auth", or POST /auth/dev-login on a dev server). Issued documents are
// permanent: run it on a demo café, never on a real one.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type client struct {
	base, token, tenant string
	http                *http.Client
}

func (c *client) do(method, path string, body any, out any) (int, []byte) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rdr)
	if err != nil {
		log.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Tenant-ID", c.tenant)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		log.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil && resp.StatusCode < 300 {
		if err := json.Unmarshal(raw, out); err != nil {
			log.Fatalf("%s %s: decode: %v", method, path, err)
		}
	}
	return resp.StatusCode, raw
}

func (c *client) must(method, path string, body any, out any) {
	if code, raw := c.do(method, path, body, out); code >= 300 {
		log.Fatalf("%s %s → %d: %s", method, path, code, raw)
	}
}

type invoice struct {
	ID         string `json:"id"`
	Number     string `json:"number"`
	FiscalYear string `json:"fiscal_year"`
	TotalCents int64  `json:"total_cents"`
	VATCents   int64  `json:"vat_cents"`
	BuyerPAN   string `json:"buyer_pan"`
	Lines      []struct {
		LineNo int `json:"line_no"`
	} `json:"lines"`
}

func main() {
	api := flag.String("api", "http://localhost:8081", "API base URL")
	tenant := flag.String("tenant", "", "café slug (must be in IRD fiscal mode)")
	token := flag.String("token", os.Getenv("IRDSAMPLE_TOKEN"), "owner access token (or IRDSAMPLE_TOKEN)")
	out := flag.String("out", "ird-samples", "output directory")
	bills := flag.Int("bills", 10, "number of bills to issue")
	flag.Parse()
	if *tenant == "" || *token == "" {
		flag.Usage()
		os.Exit(2)
	}
	c := &client{base: strings.TrimRight(*api, "/"), token: *token, tenant: *tenant, http: &http.Client{Timeout: 60 * time.Second}}
	if err := os.MkdirAll(filepath.Join(*out, "registers"), 0o755); err != nil {
		log.Fatal(err)
	}

	var me struct {
		Fiscal *struct {
			FiscalMode bool   `json:"fiscal_mode"`
			PAN        string `json:"pan"`
		} `json:"fiscal"`
	}
	c.must("GET", "/v1/me", nil, &me)
	if me.Fiscal == nil || !me.Fiscal.FiscalMode {
		log.Fatalf("café %s is not in IRD fiscal mode — switch it on in Settings → Tax & IRD first", *tenant)
	}
	log.Printf("café %s, PAN %s", *tenant, me.Fiscal.PAN)

	// Menu.
	var rawItems json.RawMessage
	c.must("GET", "/v1/menu/items", nil, &rawItems)
	type item struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		PriceCents int64  `json:"price_cents"`
		IsActive   *bool  `json:"is_active"`
	}
	var items []item
	if err := json.Unmarshal(rawItems, &items); err != nil {
		var wrapped struct {
			Items []item `json:"items"`
		}
		_ = json.Unmarshal(rawItems, &wrapped)
		items = wrapped.Items
	}
	var menu []item
	for _, it := range items {
		if it.PriceCents > 0 && (it.IsActive == nil || *it.IsActive) {
			menu = append(menu, it)
		}
	}
	if len(menu) == 0 {
		log.Fatal("the café has no priced menu items")
	}

	// Shift (cash and online need one).
	if code, raw := c.do("GET", "/v1/shifts/current", nil, nil); code != 200 || strings.TrimSpace(string(raw)) == "null" {
		c.must("POST", "/v1/shifts/open", map[string]any{"opening_float_cents": 500000}, nil)
	}

	var issued []invoice
	for i := 0; i < *bills; i++ {
		var order struct {
			ID string `json:"id"`
		}
		c.must("POST", "/v1/orders", map[string]any{"order_type": "dine_in"}, &order)
		var lines []map[string]any
		for j := 0; j <= i%3; j++ {
			it := menu[(i+j)%len(menu)]
			lines = append(lines, map[string]any{"menu_item_id": it.ID, "qty": 1 + (i+j)%2})
		}
		c.must("POST", "/v1/orders/"+order.ID+"/items", map[string]any{"items": lines}, nil)
		c.must("POST", "/v1/orders/"+order.ID+"/send-to-kitchen", nil, nil)
		var q struct {
			TotalCents int64 `json:"total_cents"`
		}
		c.must("GET", "/v1/orders/"+order.ID+"/quote", nil, &q)
		method, ref := "cash", ""
		if i%3 == 1 {
			method, ref = "online", fmt.Sprintf("FONEPAY-%06d", 100000+i)
		}
		c.must("POST", "/v1/orders/"+order.ID+"/payments",
			map[string]any{"method": method, "amount_cents": q.TotalCents, "reference_no": ref}, nil)
		body := map[string]any{}
		if i%4 == 2 {
			body["buyer"] = map[string]any{"name": "Sample Traders Pvt. Ltd.", "pan": "600000000", "address": "Kathmandu"}
		}
		var closed struct {
			Invoice *invoice `json:"invoice"`
		}
		c.must("POST", "/v1/orders/"+order.ID+"/close", body, &closed)
		if closed.Invoice == nil {
			log.Fatal("close returned no invoice")
		}
		issued = append(issued, *closed.Invoice)
		log.Printf("issued %s FY %s  %0.2f (VAT %0.2f)", closed.Invoice.Number, closed.Invoice.FiscalYear,
			float64(closed.Invoice.TotalCents)/100, float64(closed.Invoice.VATCents)/100)
	}

	// Bill 1, printed four times (checklist 11(क)(ख)).
	for n := 1; n <= 4; n++ {
		var pr json.RawMessage
		c.must("POST", "/v1/invoices/"+issued[0].ID+"/print", map[string]any{"device": "irdsample"}, &pr)
		writeFile(*out, fmt.Sprintf("print-%d-bill-%s.json", n, issued[0].Number), pr)
	}

	// Corrections (checklist 11(घ)(ङ)).
	var corrections []json.RawMessage
	if len(issued) >= 2 {
		var cn json.RawMessage
		c.must("POST", "/v1/invoices/"+issued[1].ID+"/credit-notes", map[string]any{
			"kind": "sales_return", "reason": "Guest returned one item", "refund_method": "cash",
			"lines": []map[string]any{{"line_no": issued[1].Lines[0].LineNo, "qty": "1"}},
		}, &cn)
		corrections = append(corrections, cn)
	}
	{
		var re json.RawMessage
		c.must("POST", "/v1/invoices/"+issued[len(issued)-1].ID+"/credit-notes", map[string]any{
			"kind": "reversal", "reason": "Billed to the wrong table", "refund_method": "cash",
		}, &re)
		corrections = append(corrections, re)
	}
	for i, cn := range corrections {
		var meta struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(cn, &meta)
		var pr json.RawMessage
		c.must("POST", "/v1/credit-notes/"+meta.ID+"/print", nil, &pr)
		writeFile(*out, fmt.Sprintf("credit-note-%d.json", i+1), pr)
	}

	// Purchase side.
	var exp struct {
		ID string `json:"id"`
	}
	c.must("POST", "/v1/expenses", map[string]any{
		"vendor": "Sample Supplier Pvt. Ltd.", "amount_cents": 113000, "payment_method": "bank",
		"paid_from": "bank", "reference_no": "SS-1001",
	}, &exp)
	var today struct {
		CurrentFY string `json:"current_fiscal_year"`
	}
	c.must("GET", "/v1/fiscal/registers", nil, &today)
	var sales struct {
		Rows [][]any `json:"rows"`
	}
	c.must("GET", "/v1/fiscal/registers/sales_register", nil, &sales)
	billDate := fmt.Sprint(sales.Rows[len(sales.Rows)-1][0])
	var pb struct {
		ID string `json:"id"`
	}
	c.must("POST", "/v1/expenses/"+exp.ID+"/purchase-bill", map[string]any{
		"supplier_name": "Sample Supplier Pvt. Ltd.", "supplier_pan": "600000001", "supplier_bill_no": "SS-1001",
		"supplier_bill_date_bs": billDate, "taxable_cents": 100000, "vat_cents": 13000,
	}, &pb)
	c.must("POST", "/v1/purchase-bills/"+pb.ID+"/returns", map[string]any{
		"reason": "Damaged goods returned", "supplier_note_no": "DN-1", "taxable_cents": 10000, "vat_cents": 1300,
	}, nil)

	// Give the CBMS worker time to post.
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		var st struct {
			Rows [][]any `json:"rows"`
		}
		c.must("GET", "/v1/fiscal/registers/cbms_status", nil, &st)
		pending := 0
		for _, r := range st.Rows {
			if fmt.Sprint(r[3]) == "pending" {
				pending++
			}
		}
		if pending == 0 {
			break
		}
		log.Printf("waiting for CBMS: %d pending", pending)
		time.Sleep(5 * time.Second)
	}

	// Every register, Excel and CSV.
	var list struct {
		Registers []struct {
			Kind string `json:"kind"`
		} `json:"registers"`
	}
	c.must("GET", "/v1/fiscal/registers", nil, &list)
	for _, r := range list.Registers {
		for _, f := range []string{"xlsx", "csv"} {
			code, raw := c.do("GET", "/v1/fiscal/registers/"+r.Kind+"?format="+f, nil, nil)
			if code != 200 {
				log.Fatalf("register %s.%s → %d", r.Kind, f, code)
			}
			writeFile(filepath.Join(*out, "registers"), r.Kind+"."+f, raw)
		}
	}

	summary, _ := json.MarshalIndent(map[string]any{
		"tenant": *tenant, "pan": me.Fiscal.PAN, "fiscal_year": today.CurrentFY,
		"generated_at": time.Now().Format(time.RFC3339), "invoices": issued, "corrections": corrections,
	}, "", "  ")
	writeFile(*out, "documents.json", summary)
	writeFile(*out, "README.md", fmt.Appendf(nil, `# IRD sample set — %s (PAN %s)

Generated %s by apps/api/cmd/irdsample.

- %d bills (%s … %s), each sent to the kitchen first (KOT log), cash and online, some with a buyer PAN.
- Bill %s printed four times: print-1 … print-4 (TAX INVOICE, INVOICE, Copy of Original (1), (2)).
- A sales return and a reverse entry (credit-note-*.json); a supplier bill and a purchase return.
- registers/: every IRD register as Excel and CSV (Standard View, Sales Book, returns, reverse entries,
  Purchase Book, VAT summary, above Rs 1 lakh, KOT log, print log, CBMS status, audit trail).

For the paper set, print from the web app: History → the bill → Print invoice (prints are counted —
these four are done; further prints read Copy of Original (3) …), Reports → IRD registers → PDF.
`, *tenant, me.Fiscal.PAN, time.Now().Format("2006-01-02 15:04"), len(issued), issued[0].Number,
		issued[len(issued)-1].Number, issued[0].Number))
	log.Printf("sample set written to %s", *out)
}

func writeFile(dir, name string, data []byte) {
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		log.Fatal(err)
	}
}
