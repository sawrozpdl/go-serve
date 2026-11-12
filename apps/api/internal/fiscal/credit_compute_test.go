package fiscal

import (
	"math/rand"
	"testing"
)

func vatInvoice(sub, disc int64) InvoiceTotals {
	total := sub - disc
	vat := pctInclusive(total, 1300)
	t, _ := ComputeInvoiceTotals(RegVAT, OrderTotals{SubtotalCents: sub, DiscountCents: disc, TaxCents: vat, TotalCents: total, VatMode: "inclusive", VatPct: "13"})
	return t
}

func add(a, b InvoiceTotals) InvoiceTotals {
	return InvoiceTotals{a.GrossCents + b.GrossCents, a.DiscountCents + b.DiscountCents, a.TaxableCents + b.TaxableCents,
		a.NonTaxableCents + b.NonTaxableCents, a.VATCents + b.VATCents, a.TotalCents + b.TotalCents}
}

func TestReversalCreditsTheWholeBill(t *testing.T) {
	inv := vatInvoice(113000, 11300)
	got, err := ComputeCreditTotals(CreditInput{Kind: "reversal", Invoice: inv, VatRate: "13", Reg: RegVAT})
	if err != nil || got != inv {
		t.Fatalf("reversal = %+v %v, want %+v", got, err, inv)
	}
}

func TestPartialReturnShareAndCompletion(t *testing.T) {
	// Two lines: 56,500 and 56,500 (VAT-inclusive), 10% discount on the bill.
	inv := vatInvoice(113000, 11300)
	first, err := ComputeCreditTotals(CreditInput{Kind: "sales_return", Invoice: inv, VatRate: "13", Reg: RegVAT,
		ReturnedAmount: 56500, LinesAmount: 113000})
	if err != nil {
		t.Fatal(err)
	}
	if first.TotalCents != inv.TotalCents/2 {
		t.Fatalf("half the lines should credit half the bill: %+v", first)
	}
	second, err := ComputeCreditTotals(CreditInput{Kind: "sales_return", Invoice: inv, VatRate: "13", Reg: RegVAT,
		ReturnedAmount: 56500, LinesAmount: 113000, Previous: first, Completes: true})
	if err != nil {
		t.Fatal(err)
	}
	if add(first, second) != inv {
		t.Fatalf("notes must sum to the bill exactly: %+v + %+v ≠ %+v", first, second, inv)
	}
}

func TestCreditRefusesOverCredit(t *testing.T) {
	inv := vatInvoice(10000, 0)
	if _, err := ComputeCreditTotals(CreditInput{Kind: "reversal", Invoice: inv, VatRate: "13", Reg: RegVAT, Previous: inv}); err == nil {
		t.Fatal("reversal of a fully credited bill accepted")
	}
	if _, err := ComputeCreditTotals(CreditInput{Kind: "sales_return", Invoice: inv, VatRate: "13", Reg: RegVAT,
		ReturnedAmount: 20000, LinesAmount: 10000}); err == nil {
		t.Fatal("returning more than the lines accepted")
	}
}

// Many partial returns of random carts: every note balances, never exceeds
// what is left, and the completing note lands the sum exactly on the bill.
func TestCreditProperty(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	for i := 0; i < 3000; i++ {
		n := 1 + r.Intn(6)
		lines := make([]int64, n)
		var sub int64
		for j := range lines {
			lines[j] = int64(1+r.Intn(300)) * 500
			sub += lines[j]
		}
		disc := int64(0)
		if r.Intn(2) == 0 {
			disc = r.Int63n(sub / 2)
		}
		inv := vatInvoice(sub, disc)
		var prev InvoiceTotals
		for j, l := range lines {
			got, err := ComputeCreditTotals(CreditInput{Kind: "sales_return", Invoice: inv, VatRate: "13", Reg: RegVAT,
				ReturnedAmount: l, LinesAmount: sub, Previous: prev, Completes: j == n-1})
			if err != nil {
				t.Fatalf("cart %v disc %d line %d: %v", lines, disc, j, err)
			}
			prev = add(prev, got)
		}
		if prev != inv {
			t.Fatalf("cart %v disc %d: notes %+v ≠ invoice %+v", lines, disc, prev, inv)
		}
	}
}

func TestPANCredit(t *testing.T) {
	inv := InvoiceTotals{GrossCents: 50000, DiscountCents: 5000, NonTaxableCents: 45000, TotalCents: 45000}
	got, err := ComputeCreditTotals(CreditInput{Kind: "sales_return", Invoice: inv, Reg: RegPAN, ReturnedAmount: 25000, LinesAmount: 50000})
	if err != nil || got.TotalCents != 22500 || got.VATCents != 0 || got.NonTaxableCents != 22500 || got.DiscountCents != 2500 {
		t.Fatalf("PAN credit = %+v %v", got, err)
	}
}
