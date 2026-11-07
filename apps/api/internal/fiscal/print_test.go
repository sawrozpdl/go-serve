package fiscal

import (
	"strings"
	"testing"
)

func TestInvoicePrintLabels(t *testing.T) {
	cases := []struct {
		kind  string
		n     int
		title string
		copy  string
	}{
		{"tax_invoice", 1, "TAX INVOICE", "ORIGINAL"},
		{"tax_invoice", 2, "INVOICE", "SECOND COPY"},
		{"tax_invoice", 3, "TAX INVOICE", "Copy of Original (1)"},
		{"tax_invoice", 4, "TAX INVOICE", "Copy of Original (2)"},
		{"invoice", 1, "INVOICE", "ORIGINAL"},
		{"invoice", 2, "INVOICE", "Copy of Original (1)"},
		{"invoice", 3, "INVOICE", "Copy of Original (2)"},
	}
	for _, c := range cases {
		l := InvoicePrintLabel(c.kind, c.n)
		if l.Title != c.title || l.CopyLabel != c.copy || l.CopyNo != c.n || l.TitleNE == "" {
			t.Errorf("%s #%d = %+v, want %s / %s", c.kind, c.n, l, c.title, c.copy)
		}
	}
}

func TestQRPayloadModes(t *testing.T) {
	f := QRFields{SellerPAN: "601234567", Number: "KTM-7", FiscalYear: "2083/84", BSDate: "2083-07-21",
		TotalCents: 113000, Taxable: 100000, VATCents: 13000}
	text := BuildQRPayload(f, "")
	for _, want := range []string{"Seller PAN: 601234567", "Bill No: KTM-7", "Date: 2083-07-21", "Total: 1130.00", "VAT: 130.00"} {
		if !strings.Contains(text, want) {
			t.Errorf("text payload missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "Buyer PAN") {
		t.Error("text payload shows an empty buyer PAN")
	}
	u := BuildQRPayload(f, "https://verify.example/q")
	if u != "https://verify.example/q?amt=1130.00&bill=KTM-7&date=2083-07-21&fy=2083%2F84&pan=601234567&taxable=1000.00&vat=130.00" {
		t.Errorf("url payload = %s", u)
	}
}

func TestContentHashDetectsChange(t *testing.T) {
	in := HashInput{Number: "1", Totals: InvoiceTotals{TotalCents: 100}, Lines: []HashLine{{Description: "Tea", Qty: "1.00", UnitCents: 100, AmountCents: 100}}}
	a := ContentHash(in)
	in.Lines[0].AmountCents = 101
	if ContentHash(in) == a {
		t.Fatal("hash ignores a line amount")
	}
	// Length-prefixing: moving characters between fields changes the hash.
	x := ContentHash(HashInput{BuyerName: "ab", BuyerPAN: ""})
	y := ContentHash(HashInput{BuyerName: "a", BuyerPAN: "b"})
	if x == y {
		t.Fatal("field boundaries are ambiguous")
	}
}
