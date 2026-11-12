package fiscal

import "fmt"

// CreditInput describes one credit note against an invoice.
type CreditInput struct {
	Kind string // "sales_return" | "reversal"
	// Invoice is the bill being credited (its totals and line amounts).
	Invoice InvoiceTotals
	VatRate string
	Reg     Registration
	// ReturnedAmount is Σ amount_cents of the lines (or part-lines) being
	// returned, as charged (VAT-inclusive for a VAT café). LinesAmount is
	// the invoice's Σ line amounts — the base the share is taken from.
	ReturnedAmount int64
	LinesAmount    int64
	// Previous is everything already credited against this invoice.
	Previous InvoiceTotals
	// Completes is true when, with this note, every line is fully returned:
	// the note then takes exactly what is left, so the notes sum to the
	// invoice to the paisa.
	Completes bool
}

// ComputeCreditTotals derives a credit note's IRD breakdown.
//
// A reversal, or the note that completes the return of every line, credits
// exactly the remainder (invoice − previous notes), field by field. Any other
// partial return credits the returned lines' share of the invoice total:
// total = round(invoice.total × returned / lines), with the invoice's
// discount shared the same way, and VAT backed out of that total the way
// CloseOrder backs it out of a bill (13/113, half-up). Every note therefore
// balances on its own and the notes can never exceed the bill.
func ComputeCreditTotals(in CreditInput) (InvoiceTotals, error) {
	rem := InvoiceTotals{
		GrossCents:      in.Invoice.GrossCents - in.Previous.GrossCents,
		DiscountCents:   in.Invoice.DiscountCents - in.Previous.DiscountCents,
		TaxableCents:    in.Invoice.TaxableCents - in.Previous.TaxableCents,
		NonTaxableCents: in.Invoice.NonTaxableCents - in.Previous.NonTaxableCents,
		VATCents:        in.Invoice.VATCents - in.Previous.VATCents,
		TotalCents:      in.Invoice.TotalCents - in.Previous.TotalCents,
	}
	if in.Kind == "reversal" || in.Completes {
		if rem.TotalCents <= 0 {
			return InvoiceTotals{}, fmt.Errorf("fiscal: nothing left to credit on this bill")
		}
		return rem, rem.Check()
	}
	if in.LinesAmount <= 0 || in.ReturnedAmount <= 0 || in.ReturnedAmount > in.LinesAmount {
		return InvoiceTotals{}, fmt.Errorf("fiscal: invalid returned amount %d of %d", in.ReturnedAmount, in.LinesAmount)
	}
	share := func(v int64) int64 { return (v*in.ReturnedAmount*2 + in.LinesAmount) / (2 * in.LinesAmount) }

	var t InvoiceTotals
	t.TotalCents = share(in.Invoice.TotalCents)
	discount := share(in.Invoice.DiscountCents)
	switch in.Reg {
	case RegVAT:
		rate := parseRateHundredths(in.VatRate)
		den := 10000 + rate
		t.VATCents = (t.TotalCents*rate*2 + den) / (2 * den)
		t.TaxableCents = t.TotalCents - t.VATCents
		t.DiscountCents = discount
		t.GrossCents = t.TaxableCents + t.DiscountCents
	case RegPAN:
		t.NonTaxableCents = t.TotalCents
		t.DiscountCents = discount
		t.GrossCents = t.TotalCents + discount
	default:
		return InvoiceTotals{}, fmt.Errorf("fiscal: no credit note for registration %q", in.Reg)
	}
	// A partial note may never reach past what is left (rounding on many
	// small returns could otherwise nibble a paisa past the bill).
	if t.TotalCents > rem.TotalCents || t.VATCents > rem.VATCents || t.TotalCents <= 0 {
		return InvoiceTotals{}, fmt.Errorf("fiscal: return exceeds what is left on the bill")
	}
	return t, t.Check()
}
