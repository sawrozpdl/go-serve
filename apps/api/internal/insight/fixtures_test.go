package insight

import (
	"time"

	"github.com/google/uuid"
)

// fixedNow is the instant every detector test runs at. Explicit and constant so
// thresholds expressed in days have exact, non-flaky boundaries — the same
// reason health.Compute takes `now` as a parameter.
//
// Chosen to sit in Asia/Kathmandu (+05:45), the anchor café's timezone, because
// a UTC-midnight fixture would hide off-by-one-day errors in exactly the
// timezone the product actually runs in.
func fixedNow() time.Time {
	return time.Date(2026, 7, 26, 9, 0, 0, 0, kathmandu())
}

func kathmandu() *time.Location {
	loc, err := time.LoadLocation("Asia/Kathmandu")
	if err != nil {
		// +05:45 is fixed and has no DST, so a missing tzdata is not fatal here.
		return time.FixedZone("Asia/Kathmandu", 5*3600+45*60)
	}
	return loc
}

// ids returns stable uuids so a golden-style assertion on ordering is
// reproducible across runs.
func id(n byte) uuid.UUID {
	var u uuid.UUID
	u[0] = n
	u[15] = n
	return u
}

func f64(v float64) *float64 { return &v }
func ptrInt(v int) *int      { return &v }

// baseWindow is a 30-day window ending at fixedNow, with takings in the same
// order of magnitude as the real anchor café (Rs ~400,000/month).
func baseWindow() Window {
	to := fixedNow()
	return Window{
		From:         to.AddDate(0, 0, -30),
		To:           to,
		RevenueCents: 40_000_000, // Rs 400,000
		OrderCount:   684,
		LineCount:    1749,
	}
}

func priorWindow() Window {
	to := fixedNow().AddDate(0, 0, -30)
	return Window{
		From:         to.AddDate(0, 0, -30),
		To:           to,
		RevenueCents: 38_000_000,
		OrderCount:   650,
		LineCount:    1680,
	}
}

// richInputs is a café with something wrong in every category, so that a single
// pass exercises every detector's happy path. It is NOT meant to be realistic —
// no real café trips all of these at once. Per-detector tests use narrow,
// realistic inputs; this one exists so the registry-wide invariants (link arity,
// well-formedness, deterministic ordering) cover every branch.
func richInputs() Inputs {
	return Inputs{
		Loc:    kathmandu(),
		Window: baseWindow(),
		Prior:  priorWindow(),

		Integrity: []IntegrityViolation{
			{CheckKey: "payments_vs_total", Entity: "order", EntityID: id(1), DeltaCents: -25_000},
			{CheckKey: "payments_vs_total", Entity: "order", EntityID: id(2), DeltaCents: 15_000},
			{CheckKey: "drawer_expense_unlinked", Entity: "expense", EntityID: id(3), DeltaCents: 120_000},
			// An unknown key must be ignored rather than reported without a sentence.
			{CheckKey: "not_a_real_check", Entity: "order", EntityID: id(4), DeltaCents: 999},
		},

		CostCoverage:    Coverage{KnownCents: 30_000_000, TotalCents: 40_000_000}, // 75%
		ExpenseCoverage: Coverage{KnownCents: 0, TotalCents: 9_000_000},           // 0%

		Close: CloseDiscipline{TradingDays: 14, ShiftCloseDays: 11},

		ActiveStaff: 3,
		Voids: ActSummary{
			Count: 84, ValueCents: 4_000_000, // 10% of revenue
			Actors: []ActorStat{
				{UserID: id(10), Name: "Bikash", Count: 70, ValueCents: 3_400_000},
				{UserID: id(11), Name: "Sita", Count: 14, ValueCents: 600_000},
			},
		},
		Discounts: ActSummary{
			Count: 75, ValueCents: 6_000_000, // 15% of revenue
			Actors: []ActorStat{
				{UserID: id(10), Name: "Bikash", Count: 60, ValueCents: 5_000_000},
				{UserID: id(11), Name: "Sita", Count: 15, ValueCents: 1_000_000},
			},
		},
		Retractions: ActSummary{
			Count: 12, ValueCents: 850_000,
			Actors: []ActorStat{{UserID: id(10), Name: "Bikash", Count: 9, ValueCents: 700_000}},
		},

		Categories: []CategoryMargin{
			{
				ID: id(20), Name: "Hot Drinks",
				RevenueCents: 20_000_000, CostCents: 9_000_000, // 55%
				PriorRevenueCents: 18_000_000, PriorCostCents: 4_500_000, // 75% → 20pt drop
			},
			// Steady: must NOT produce a finding.
			{
				ID: id(21), Name: "Rice & Mains",
				RevenueCents: 12_000_000, CostCents: 4_200_000,
				PriorRevenueCents: 11_000_000, PriorCostCents: 3_850_000,
			},
		},

		BelowCost: []ItemMargin{
			{ID: id(30), Name: "Imported Cheesecake", PriceCents: 45_000, CostCents: 52_000, Qty: 40, LostCents: 280_000},
			{ID: id(31), Name: "Bottled Water", PriceCents: 3_000, CostCents: 3_000, Qty: 120, LostCents: 0},
		},

		Credit: []CreditTab{
			{ID: id(40), Name: "Ram Thapa", BalanceCents: 1_250_000, DaysSincePayment: ptrInt(71)},
			{ID: id(41), Name: "Office Account", BalanceCents: 480_000, DaysSincePayment: nil},
			// Under the minimum: must be ignored.
			{ID: id(42), Name: "Petty Tab", BalanceCents: 20_000, DaysSincePayment: ptrInt(200)},
		},

		DeadItems: []DeadItem{
			{ID: id(50), Name: "Cold Brew Tonic", EverSold: true},
			{ID: id(51), Name: "Affogato", EverSold: false},
			{ID: id(52), Name: "Seasonal Salad", EverSold: true},
			{ID: id(53), Name: "Kombucha", EverSold: false},
			{ID: id(54), Name: "Waffle Stack", EverSold: true},
			{ID: id(55), Name: "Beetroot Latte", EverSold: true},
		},

		Shifts: []ShiftVariance{
			{ID: id(60), Day: fixedNow().AddDate(0, 0, -1), Diff: -120_000},
			{ID: id(61), Day: fixedNow().AddDate(0, 0, -2), Diff: 0},
			{ID: id(62), Day: fixedNow().AddDate(0, 0, -3), Diff: -45_000},
		},
	}
}

// floodInputs is a café large enough to make any un-capped detector misbehave:
// many credit accounts, many below-cost items, many dead items, many actors.
// Used by TestNoDetectorFloodsTheBrief.
func floodInputs() Inputs {
	in := richInputs()
	in.Credit = nil
	in.BelowCost = nil
	in.DeadItems = nil
	in.Integrity = nil
	for i := 0; i < 40; i++ {
		b := byte(i)
		in.Credit = append(in.Credit, CreditTab{
			ID: id(b), Name: "Tab", BalanceCents: int64(2_000_000 - i*1000), DaysSincePayment: ptrInt(120),
		})
		in.BelowCost = append(in.BelowCost, ItemMargin{
			ID: id(b), Name: "Loss", PriceCents: 100, CostCents: 300, Qty: 5, LostCents: int64(50_000 - i*100),
		})
		in.DeadItems = append(in.DeadItems, DeadItem{ID: id(b), Name: "Quiet", EverSold: i%2 == 0})
	}
	// Every invariant violated many times over.
	for key := range integrityChecks {
		for i := 0; i < 30; i++ {
			in.Integrity = append(in.Integrity, IntegrityViolation{
				CheckKey: key, Entity: "row", EntityID: id(byte(i)), DeltaCents: 1_000,
			})
		}
	}
	return in
}
