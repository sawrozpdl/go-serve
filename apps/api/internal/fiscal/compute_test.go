package fiscal

import (
	"math/rand"
	"testing"
)

// pctInclusive mirrors api.pctInclusive (payments.go): the VAT inside a
// VAT-inclusive gross, half-up. Duplicated here so the property test drives
// ComputeInvoiceTotals with exactly what CloseOrder stamps.
func pctInclusive(gross int64, rateHundredths int64) int64 {
	den := 10000 + rateHundredths
	return (gross*rateHundredths*2 + den) / (2 * den)
}

func TestComputeVATInclusiveExample(t *testing.T) {
	// Menu Rs 1,130 incl. VAT, Rs 113 discount → Rs 1,017 paid, VAT 117.00.
	sub, disc := int64(113000), int64(11300)
	total := sub - disc
	vat := pctInclusive(total, 1300)
	got, err := ComputeInvoiceTotals(RegVAT, OrderTotals{
		SubtotalCents: sub, DiscountCents: disc, TaxCents: vat, TotalCents: total,
		VatMode: "inclusive", VatPct: "13.00",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := InvoiceTotals{GrossCents: 100000, DiscountCents: 10000, TaxableCents: 90000, VATCents: 11700, TotalCents: 101700}
	if got != want {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestComputePAN(t *testing.T) {
	got, err := ComputeInvoiceTotals(RegPAN, OrderTotals{
		SubtotalCents: 50000, DiscountCents: 5000, TotalCents: 45000, VatMode: "none", VatPct: "13",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := InvoiceTotals{GrossCents: 50000, DiscountCents: 5000, NonTaxableCents: 45000, TotalCents: 45000}
	if got != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
}

func TestComputeRefusesIllegalInputs(t *testing.T) {
	cases := []struct {
		reg Registration
		o   OrderTotals
	}{
		{RegVAT, OrderTotals{TotalCents: 100, VatMode: "exclusive", VatPct: "13"}},
		{RegVAT, OrderTotals{TotalCents: 100, ServiceChargeCents: 10, VatMode: "inclusive", VatPct: "13"}},
		{RegVAT, OrderTotals{TotalCents: 100, VatMode: "inclusive", VatPct: "0"}},
		{RegPAN, OrderTotals{TotalCents: 113, TaxCents: 13, VatMode: "inclusive", VatPct: "13"}},
		{RegNone, OrderTotals{TotalCents: 100, VatMode: "none"}},
	}
	for i, c := range cases {
		if _, err := ComputeInvoiceTotals(c.reg, c.o); err == nil {
			t.Errorf("case %d accepted: %+v", i, c)
		}
	}
}

// Random carts and discounts: the IRD breakdown always balances and always
// repeats the stamped total and VAT to the paisa.
func TestComputeProperty(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for i := 0; i < 20000; i++ {
		sub := int64(r.Intn(5_000_000)) + 1
		disc := int64(0)
		if r.Intn(3) > 0 {
			disc = int64(r.Int63n(sub + 1))
		}
		total := sub - disc
		vat := pctInclusive(total, 1300)
		got, err := ComputeInvoiceTotals(RegVAT, OrderTotals{
			SubtotalCents: sub, DiscountCents: disc, TaxCents: vat, TotalCents: total,
			VatMode: "inclusive", VatPct: "13",
		})
		if err != nil {
			t.Fatalf("sub=%d disc=%d: %v", sub, disc, err)
		}
		if got.TotalCents != total || got.VATCents != vat {
			t.Fatalf("does not repeat the order: %+v", got)
		}
		// Ex-VAT discount stays within a paisa of the exact value.
		exact := float64(disc) * 100 / 113
		if d := float64(got.DiscountCents) - exact; d > 0.5 || d < -0.5 {
			t.Fatalf("discount ex-VAT %d vs exact %.3f", got.DiscountCents, exact)
		}
	}
}

func TestParseRate(t *testing.T) {
	for in, want := range map[string]int64{"13": 1300, "13.0": 1300, "13.00": 1300, "12.5": 1250, "x": -1} {
		if got := parseRateHundredths(in); got != want {
			t.Errorf("%q = %d want %d", in, got, want)
		}
	}
}
