package fiscal

import (
	"fmt"
)

// OrderTotals are the money columns CloseOrder stamps on an order (paisa).
// The invoice is derived FROM them, never recomputed independently, so the
// invariant invoice.total == orders.total holds by construction (and the
// invoices_issue_guard trigger checks it anyway).
type OrderTotals struct {
	SubtotalCents      int64  // Σ qty × unit price, as charged (VAT-inclusive for a VAT café)
	DiscountCents      int64  // as charged
	ServiceChargeCents int64  // always 0 for a fiscal café (0089)
	TaxCents           int64  // VAT
	TotalCents         int64  // what was paid
	VatMode            string // none | inclusive | exclusive
	VatPct             string // e.g. "13.00"
}

// InvoiceTotals are the IRD figures printed on the bill and reported in the
// Standard View (Annex 5) and to CBMS.
type InvoiceTotals struct {
	GrossCents      int64 // Amount: before discount, excluding VAT
	DiscountCents   int64 // Discount, excluding VAT
	TaxableCents    int64 // VAT-taxable value
	NonTaxableCents int64 // outside VAT: a PAN-only café's sales
	VATCents        int64
	TotalCents      int64
}

// Check verifies the identities the invoices table enforces.
func (t InvoiceTotals) Check() error {
	if t.GrossCents < 0 || t.DiscountCents < 0 || t.TaxableCents < 0 || t.NonTaxableCents < 0 || t.VATCents < 0 || t.TotalCents < 0 {
		return fmt.Errorf("fiscal: negative invoice amount %+v", t)
	}
	if t.GrossCents-t.DiscountCents != t.TaxableCents+t.NonTaxableCents {
		return fmt.Errorf("fiscal: gross − discount ≠ taxable + non-taxable %+v", t)
	}
	if t.TotalCents != t.TaxableCents+t.NonTaxableCents+t.VATCents {
		return fmt.Errorf("fiscal: total ≠ taxable + non-taxable + vat %+v", t)
	}
	return nil
}

// ComputeInvoiceTotals derives the IRD breakdown from an order's stamped
// totals.
//
// VAT café (VAT-inclusive menu prices, Rule 14ख): the VAT CloseOrder extracted
// is kept to the paisa; taxable = total − VAT. The discount is shown excluding
// VAT (Annex 5 columns are all ex-VAT), rounded half-up, and Amount is then
// taxable + that discount — so gross − discount = taxable exactly and no
// rounding difference can ever unbalance the row.
//
// PAN-only café: no VAT exists; the whole sale is non-taxable and Amount /
// Discount are the charged figures.
func ComputeInvoiceTotals(reg Registration, o OrderTotals) (InvoiceTotals, error) {
	if o.ServiceChargeCents != 0 {
		return InvoiceTotals{}, fmt.Errorf("fiscal: service charge on a fiscal bill (%d)", o.ServiceChargeCents)
	}
	var t InvoiceTotals
	switch reg {
	case RegVAT:
		if o.VatMode != "inclusive" {
			return InvoiceTotals{}, fmt.Errorf("fiscal: VAT café with vat_mode %q", o.VatMode)
		}
		rate := parseRateHundredths(o.VatPct)
		if rate <= 0 {
			return InvoiceTotals{}, fmt.Errorf("fiscal: VAT café with rate %q", o.VatPct)
		}
		t.TotalCents = o.TotalCents
		t.VATCents = o.TaxCents
		t.TaxableCents = o.TotalCents - o.TaxCents
		if o.DiscountCents > 0 {
			t.DiscountCents = exVAT(o.DiscountCents, rate)
		}
		t.GrossCents = t.TaxableCents + t.DiscountCents
	case RegPAN:
		if o.TaxCents != 0 || o.VatMode != "none" {
			return InvoiceTotals{}, fmt.Errorf("fiscal: PAN-only café charged VAT (%d, %q)", o.TaxCents, o.VatMode)
		}
		t.TotalCents = o.TotalCents
		t.NonTaxableCents = o.TotalCents
		t.DiscountCents = o.DiscountCents
		t.GrossCents = o.TotalCents + o.DiscountCents
	default:
		return InvoiceTotals{}, fmt.Errorf("fiscal: no invoice for registration %q", reg)
	}
	return t, t.Check()
}

// exVAT returns the VAT-exclusive part of a VAT-inclusive amount, half-up:
// amount × 100 / (100 + rate), with rate in hundredths of a percent.
func exVAT(amount, rateHundredths int64) int64 {
	den := 10000 + rateHundredths
	return (amount*10000*2 + den) / (2 * den)
}

// parseRateHundredths reads "13", "13.0" or "13.00" as 1300.
func parseRateHundredths(s string) int64 {
	var whole, frac int64
	var fracDigits int
	seenDot := false
	for _, c := range s {
		switch {
		case c == '.' && !seenDot:
			seenDot = true
		case c >= '0' && c <= '9':
			if seenDot {
				if fracDigits < 2 {
					frac = frac*10 + int64(c-'0')
					fracDigits++
				}
			} else {
				whole = whole*10 + int64(c-'0')
			}
		default:
			return -1
		}
	}
	for fracDigits < 2 {
		frac *= 10
		fracDigits++
	}
	return whole*100 + frac
}
