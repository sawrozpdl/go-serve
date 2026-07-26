package main

// The order-money arithmetic, mirroring buildQuote (internal/api/payments.go).
//
// The generator cannot call the handler — it writes rows directly — so this is
// the one place the arithmetic is reproduced, and it is reproduced exactly:
//
//	subtotal = Σ qty × unit_price over non-voided lines
//	base     = subtotal − discount + service        (clamped at 0)
//	none:       tax = 0,                     total = base
//	inclusive:  tax = base × p/(100+p),      total = base   (tax is INSIDE)
//	exclusive:  tax = base × p/100,          total = base + tax
//
// Rounding is half away from zero, like pctOf/pctInclusive. If this drifts from
// payments.go, verify.go catches it: the seeded rows would stop reconciling and
// the run fails.

import "math/big"

type quote struct {
	Subtotal int64
	Discount int64
	Service  int64
	Tax      int64
	Total    int64
}

// computeQuote mirrors buildQuote for a set of line totals.
func computeQuote(lineTotals []int64, discount int64, servicePct, vatPct string, vatMode string) quote {
	var q quote
	for _, l := range lineTotals {
		q.Subtotal += l
	}
	q.Discount = discount
	q.Service = pctOf(q.Subtotal, servicePct)

	base := q.Subtotal - q.Discount + q.Service
	if base < 0 {
		base = 0
	}
	switch vatMode {
	case "inclusive":
		q.Total = base
		q.Tax = pctInclusive(base, vatPct)
	case "exclusive":
		q.Tax = pctOf(base, vatPct)
		q.Total = base + q.Tax
	default: // none
		q.Tax = 0
		q.Total = base
	}
	return q
}

// pctOf is round(amount × pct / 100), half away from zero — the same result
// payments.go's integer implementation produces for the rates we seed.
func pctOf(amount int64, pct string) int64 {
	p, ok := new(big.Rat).SetString(pct)
	if !ok || p.Sign() == 0 {
		return 0
	}
	v := new(big.Rat).Mul(new(big.Rat).SetInt64(amount), p)
	v.Quo(v, new(big.Rat).SetInt64(100))
	return ratRound(v)
}

// pctInclusive extracts the VAT embedded in a gross amount: round(gross × p/(100+p)).
func pctInclusive(gross int64, pct string) int64 {
	p, ok := new(big.Rat).SetString(pct)
	if !ok || p.Sign() == 0 {
		return 0
	}
	denom := new(big.Rat).Add(new(big.Rat).SetInt64(100), p)
	v := new(big.Rat).Mul(new(big.Rat).SetInt64(gross), p)
	v.Quo(v, denom)
	return ratRound(v)
}

// ratRound rounds a rational half away from zero. big.Rat keeps this exact, so a
// value landing precisely on .5 is not at the mercy of float representation.
func ratRound(v *big.Rat) int64 {
	neg := v.Sign() < 0
	if neg {
		v = new(big.Rat).Neg(v)
	}
	v = new(big.Rat).Add(v, big.NewRat(1, 2))
	n := new(big.Int).Quo(v.Num(), v.Denom()).Int64()
	if neg {
		return -n
	}
	return n
}
