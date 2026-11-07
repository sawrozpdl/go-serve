package fiscal

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Money formats paisa as rupees with two decimals: 113050 → "1130.50".
// Plain ASCII, no grouping: used in QR payloads and CBMS, not for display.
func Money(cents int64) string {
	neg := cents < 0
	if neg {
		cents = -cents
	}
	s := fmt.Sprintf("%d.%02d", cents/100, cents%100)
	if neg {
		s = "-" + s
	}
	return s
}

// QRFields is what the dynamic QR on every invoice must carry (procedure
// 2082 §6.2(ङ)): seller PAN, bill number and date, buyer PAN when known, and
// the total and tax.
type QRFields struct {
	SellerPAN  string
	Number     string
	FiscalYear string
	BSDate     string
	BuyerPAN   string
	TotalCents int64
	Taxable    int64
	VATCents   int64
}

// BuildQRPayload renders the QR content.
//
// Until IRD publishes an online verification URL (open question Q10) the
// payload is labelled plain text: any phone camera shows every field offline,
// which is what §6.2(ङ) requires of an offline scan. When verifyBaseURL is
// set the same fields become query parameters on that URL, so an online scan
// opens IRD's verifier and an offline scan still shows the fields in the URL.
// The payload is frozen on the invoice at issue; reprints reuse it verbatim.
func BuildQRPayload(f QRFields, verifyBaseURL string) string {
	if verifyBaseURL != "" {
		q := url.Values{}
		q.Set("pan", f.SellerPAN)
		q.Set("bill", f.Number)
		q.Set("fy", f.FiscalYear)
		q.Set("date", f.BSDate)
		if f.BuyerPAN != "" {
			q.Set("bpan", f.BuyerPAN)
		}
		q.Set("amt", Money(f.TotalCents))
		q.Set("taxable", Money(f.Taxable))
		q.Set("vat", Money(f.VATCents))
		sep := "?"
		if strings.Contains(verifyBaseURL, "?") {
			sep = "&"
		}
		return verifyBaseURL + sep + q.Encode()
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Seller PAN: %s\n", f.SellerPAN)
	fmt.Fprintf(&b, "Bill No: %s\n", f.Number)
	fmt.Fprintf(&b, "Fiscal Year: %s\n", f.FiscalYear)
	fmt.Fprintf(&b, "Date: %s\n", f.BSDate)
	if f.BuyerPAN != "" {
		fmt.Fprintf(&b, "Buyer PAN: %s\n", f.BuyerPAN)
	}
	fmt.Fprintf(&b, "Total: %s\n", Money(f.TotalCents))
	fmt.Fprintf(&b, "Taxable: %s\n", Money(f.Taxable))
	fmt.Fprintf(&b, "VAT: %s", Money(f.VATCents))
	return b.String()
}

// HashLine is the slice of an invoice line that the content hash covers.
type HashLine struct {
	Description string
	Qty         string // numeric(6,2) text, e.g. "1.50"
	UnitCents   int64
	AmountCents int64
}

// HashInput is everything printed on an invoice that must never change.
type HashInput struct {
	TenantID   string
	OrderID    string
	Kind       string
	FiscalYear string
	Number     string
	IssuedAt   time.Time
	BSDate     string
	SellerPAN  string
	SellerName string
	BuyerName  string
	BuyerPAN   string
	Totals     InvoiceTotals
	VatRate    string
	Payment    string
	IssuedBy   string
	Lines      []HashLine
}

// ContentHash is the sha256 of a canonical, line-oriented rendering of the
// invoice. It is stored at issue; recomputing it from the stored row and
// comparing proves the row was not altered (docs/ird/submission data-integrity
// document). Fields are length-prefixed so no value can impersonate a
// delimiter.
func ContentHash(in HashInput) string {
	h := sha256.New()
	w := func(k, v string) {
		fmt.Fprintf(h, "%s=%d:%s\n", k, len(v), v)
	}
	w("v", "1")
	w("tenant", in.TenantID)
	w("order", in.OrderID)
	w("kind", in.Kind)
	w("fy", in.FiscalYear)
	w("number", in.Number)
	w("issued_at", in.IssuedAt.UTC().Format(time.RFC3339Nano))
	w("bs_date", in.BSDate)
	w("seller_pan", in.SellerPAN)
	w("seller_name", in.SellerName)
	w("buyer_name", in.BuyerName)
	w("buyer_pan", in.BuyerPAN)
	t := in.Totals
	for _, kv := range [][2]any{
		{"gross", t.GrossCents}, {"discount", t.DiscountCents}, {"taxable", t.TaxableCents},
		{"non_taxable", t.NonTaxableCents}, {"vat", t.VATCents}, {"total", t.TotalCents},
	} {
		w(kv[0].(string), strconv.FormatInt(kv[1].(int64), 10))
	}
	w("vat_rate", in.VatRate)
	w("payment", in.Payment)
	w("issued_by", in.IssuedBy)
	for i, l := range in.Lines {
		p := "line" + strconv.Itoa(i+1) + "."
		w(p+"desc", l.Description)
		w(p+"qty", l.Qty)
		w(p+"unit", strconv.FormatInt(l.UnitCents, 10))
		w(p+"amount", strconv.FormatInt(l.AmountCents, 10))
	}
	return hex.EncodeToString(h.Sum(nil))
}
