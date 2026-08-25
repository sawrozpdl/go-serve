package insight

import (
	"strings"
	"testing"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/platform/health"
)

// run is the standard way to exercise one detector at the fixed instant.
func run(d Detector, in Inputs) []Finding { return d.Run(fixedNow(), in) }

// only asserts a detector produced exactly one finding and returns it.
func only(t *testing.T, got []Finding) Finding {
	t.Helper()
	if len(got) != 1 {
		t.Fatalf("got %d findings, want exactly 1", len(got))
	}
	return got[0]
}

// silent asserts a detector said nothing, printing what it did say if it spoke.
func silent(t *testing.T, got []Finding) {
	t.Helper()
	if len(got) != 0 {
		t.Fatalf("expected silence, got %d findings: %q", len(got), got[0].Detail)
	}
}

// =========================================================================
// Books confidence
// =========================================================================

func TestCostCoverage_Thresholds(t *testing.T) {
	win := baseWindow()
	cases := []struct {
		name       string
		known      int64
		total      int64
		wantSev    Severity
		wantSilent bool
	}{
		// A couple of percent uncovered is ordinary — a free glass of water, a
		// one-off item. Nagging about it would train the owner to ignore us.
		{name: "99% covered is unremarkable", known: 39_600_000, total: 40_000_000, wantSilent: true},
		{name: "exactly at the good bar", known: 39_200_000, total: 40_000_000, wantSilent: true},
		{name: "94% is a warning", known: 37_600_000, total: 40_000_000, wantSev: SeverityWarn},
		{name: "75% is bad", known: 30_000_000, total: 40_000_000, wantSev: SeverityBad},
		{name: "nothing covered at all", known: 0, total: 40_000_000, wantSev: SeverityBad},
		// No revenue: there is nothing to have a cost for. This is the
		// no-baseline case and it must be silence, not "0% covered".
		{name: "no revenue means no finding", known: 0, total: 0, wantSilent: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := Inputs{Window: win, CostCoverage: Coverage{KnownCents: tc.known, TotalCents: tc.total}}
			got := run(costCoverage, in)
			if tc.wantSilent {
				silent(t, got)
				return
			}
			if f := only(t, got); f.Severity != tc.wantSev {
				t.Fatalf("severity = %q, want %q (%q)", f.Severity, tc.wantSev, f.Detail)
			}
		})
	}
}

func TestUnallocatedSpend_NoExpensesIsSilent(t *testing.T) {
	// A café that has recorded no expenses has nothing to allocate. Reporting
	// "0% of nothing is tagged" is technically true and completely useless.
	silent(t, run(unallocatedSpend, Inputs{
		Window:          baseWindow(),
		ExpenseCoverage: Coverage{KnownCents: 0, TotalCents: 0},
	}))
}

func TestUnallocatedSpend_NoneTaggedReadsAsNone(t *testing.T) {
	f := only(t, run(unallocatedSpend, Inputs{
		Window:          baseWindow(),
		ExpenseCoverage: Coverage{KnownCents: 0, TotalCents: 9_000_000},
	}))
	if f.Severity != SeverityBad {
		t.Errorf("severity = %q, want bad", f.Severity)
	}
	// The common case for a café that has never opened the screen, so it gets
	// the wording that actually describes it.
	if !strings.HasPrefix(f.Detail, "None of the last 30 days' Rs 90,000.00 of spending") {
		t.Errorf("detail should lead with None-of-it phrasing, got: %q", f.Detail)
	}
}

func TestBooksConfidence_SkipsComponentsThatDoNotApply(t *testing.T) {
	// Cost coverage 100%, no expenses recorded, no trading days. Only the one
	// applicable component counts — a café must not be marked down for failing
	// to allocate expenses it never had.
	in := Inputs{CostCoverage: Coverage{KnownCents: 100, TotalCents: 100}}
	got, ok := in.BooksConfidence()
	if !ok || got != 1 {
		t.Fatalf("confidence = %v (ok=%v), want 1", got, ok)
	}

	if _, ok := (Inputs{}).BooksConfidence(); ok {
		t.Error("a café with nothing recorded has no confidence figure, not a zero one")
	}
}

func TestBooksConfidence_CloseDisciplineCannotExceedOne(t *testing.T) {
	// More close-days than trading days happens when staff tidy up on a day with
	// no sales. That is good practice, not 150% confidence.
	in := Inputs{Close: CloseDiscipline{TradingDays: 10, ShiftCloseDays: 15}}
	got, ok := in.BooksConfidence()
	if !ok || got != 1 {
		t.Fatalf("confidence = %v, want 1", got)
	}
}

// =========================================================================
// Leakage
// =========================================================================

func TestVoidRate_Thresholds(t *testing.T) {
	win := baseWindow() // Rs 400,000
	cases := []struct {
		name       string
		value      int64
		wantSev    Severity
		wantSilent bool
	}{
		{name: "2% is normal till behaviour", value: 800_000, wantSilent: true},
		{name: "3% warns", value: 1_200_000, wantSev: SeverityWarn},
		{name: "8% is bad", value: 3_200_000, wantSev: SeverityBad},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := Inputs{Window: win, Voids: ActSummary{Count: 20, ValueCents: tc.value}}
			got := run(voidRate, in)
			if tc.wantSilent {
				silent(t, got)
				return
			}
			if f := only(t, got); f.Severity != tc.wantSev {
				t.Fatalf("severity = %q, want %q", f.Severity, tc.wantSev)
			}
		})
	}
}

func TestVoidRate_NoVoidsOrNoRevenueIsSilent(t *testing.T) {
	silent(t, run(voidRate, Inputs{Window: baseWindow()}))
	silent(t, run(voidRate, Inputs{Voids: ActSummary{Count: 5, ValueCents: 10_000}}))
}

// The most important test in this file. On the real anchor café there was
// exactly ONE person operating the till: 684 orders, one actor, 100% of voids
// and discounts theirs. A concentration finding there would say "100% of voids
// were by the owner" to the owner — the definitive example of telling someone
// something they already know.
func TestConcentration_SilentWithoutAtLeastTwoOperators(t *testing.T) {
	single := Inputs{
		Window:      baseWindow(),
		ActiveStaff: 1,
		Voids: ActSummary{Count: 84, ValueCents: 4_000_000,
			Actors: []ActorStat{{UserID: id(10), Name: "Sahan Owner", Count: 84, ValueCents: 4_000_000}}},
	}
	silent(t, run(voidConcentration, single))

	// Two staff on the books but only one actor in the data is the same problem.
	oneActor := single
	oneActor.ActiveStaff = 3
	silent(t, run(voidConcentration, oneActor))
}

func TestConcentration_FiresOnlyAboveTheShare(t *testing.T) {
	mk := func(topValue, otherValue int64) Inputs {
		return Inputs{
			Window: baseWindow(), ActiveStaff: 2,
			Voids: ActSummary{Count: 50, ValueCents: topValue + otherValue, Actors: []ActorStat{
				{UserID: id(10), Name: "Bikash", Count: 40, ValueCents: topValue},
				{UserID: id(11), Name: "Sita", Count: 10, ValueCents: otherValue},
			}},
		}
	}
	silent(t, run(voidConcentration, mk(600_000, 400_000))) // 60%

	f := only(t, run(voidConcentration, mk(800_000, 200_000))) // 80%
	// Never `bad`: with no attendance data anywhere in the schema this cannot be
	// normalised by hours worked, so it is a prompt to look, not a conclusion.
	if f.Severity != SeverityWarn {
		t.Errorf("severity = %q, want warn — concentration must never be stated as bad", f.Severity)
	}
	if !strings.Contains(f.Detail, "may simply have worked the most service") {
		t.Errorf("the sentence must state the innocent explanation, got: %q", f.Detail)
	}
	if f.SubjectKind != SubjectUser {
		t.Errorf("subject kind = %q, want user", f.SubjectKind)
	}
}

func TestPaymentRetraction_NeedsAPattern(t *testing.T) {
	// One correction is routine and must not be reported.
	silent(t, run(paymentRetraction, Inputs{
		Window: baseWindow(), Retractions: ActSummary{Count: 2, ValueCents: 50_000}}))

	f := only(t, run(paymentRetraction, Inputs{
		Window: baseWindow(), Retractions: ActSummary{Count: 3, ValueCents: 90_000}}))
	if f.Severity != SeverityWarn {
		t.Errorf("severity = %q, want warn", f.Severity)
	}
	// With one operator the sentence must not name anybody.
	if strings.Contains(f.Detail, "recorded") && strings.Contains(f.Detail, " of them.") {
		t.Errorf("must not attribute with a single operator: %q", f.Detail)
	}
}

// =========================================================================
// Margin
// =========================================================================

func TestMarginSlip_RefusesWithoutABaseline(t *testing.T) {
	// health.gradeVolume returns GradeNA with "no earlier weeks to compare
	// against" rather than inventing a ratio. A brand-new category must not be
	// reported as collapsing from nothing.
	in := Inputs{
		Window: baseWindow(), Prior: priorWindow(),
		Categories: []CategoryMargin{{
			ID: id(20), Name: "New Line",
			RevenueCents: 20_000_000, CostCents: 18_000_000,
			PriorRevenueCents: 0, PriorCostCents: 0,
		}},
	}
	silent(t, run(marginSlip, in))
}

func TestMarginSlip_IgnoresCategoriesTooSmallToJudge(t *testing.T) {
	// Rs 3,000 of sales will swing double digits on one unusual order.
	in := Inputs{
		Window: baseWindow(), Prior: priorWindow(),
		Categories: []CategoryMargin{{
			ID: id(21), Name: "Specials",
			RevenueCents: 300_000, CostCents: 250_000,
			PriorRevenueCents: 280_000, PriorCostCents: 70_000,
		}},
	}
	silent(t, run(marginSlip, in))
}

func TestBelowCost_SellingAtCostStillCounts(t *testing.T) {
	in := Inputs{Window: baseWindow(), BelowCost: []ItemMargin{
		{ID: id(30), Name: "Bottled Water", PriceCents: 3_000, CostCents: 3_000, Qty: 120, LostCents: 0},
	}}
	f := only(t, run(belowCost, in))
	if f.Severity != SeverityWarn {
		t.Errorf("severity = %q, want warn (nothing lost, but nothing earned)", f.Severity)
	}
	if !strings.Contains(f.Detail, "earned nothing at all") {
		t.Errorf("at-cost items get their own wording, got: %q", f.Detail)
	}
}

func TestBelowCost_WorstMoneyFirst(t *testing.T) {
	in := Inputs{Window: baseWindow(), BelowCost: []ItemMargin{
		{ID: id(30), Name: "Small Loss", PriceCents: 100, CostCents: 120, Qty: 1, LostCents: 20},
		{ID: id(31), Name: "Big Loss", PriceCents: 100, CostCents: 200, Qty: 100, LostCents: 10_000},
	}}
	got := run(belowCost, in)
	if len(got) != 2 || got[0].SubjectLabel != "Big Loss" {
		t.Fatalf("expected the expensive one first, got %+v", []string{got[0].SubjectLabel, got[1].SubjectLabel})
	}
}

// =========================================================================
// Operations
// =========================================================================

func TestShiftDiscipline_UsesHealthThresholds(t *testing.T) {
	// Imported rather than restated, so the café-facing finding and the
	// platform-facing health grade can never disagree.
	silent(t, run(shiftDiscipline, Inputs{Close: CloseDiscipline{TradingDays: 14, ShiftCloseDays: 14}}))

	warn := only(t, run(shiftDiscipline, Inputs{
		Close: CloseDiscipline{TradingDays: 14, ShiftCloseDays: 14 - health.ShiftMissesWarn}}))
	if warn.Severity != SeverityWarn {
		t.Errorf("%d miss = %q, want warn", health.ShiftMissesWarn, warn.Severity)
	}

	bad := only(t, run(shiftDiscipline, Inputs{
		Close: CloseDiscipline{TradingDays: 14, ShiftCloseDays: 14 - health.ShiftMissesBad}}))
	if bad.Severity != SeverityBad {
		t.Errorf("%d misses = %q, want bad", health.ShiftMissesBad, bad.Severity)
	}
}

func TestShiftDiscipline_TidyingUpIsNotAMiss(t *testing.T) {
	// More closes than trading days: they closed a drawer on a day with no
	// sales. health.gradeShiftDiscipline makes the same allowance.
	silent(t, run(shiftDiscipline, Inputs{Close: CloseDiscipline{TradingDays: 5, ShiftCloseDays: 7}}))
}

func TestShiftDiscipline_HangingShiftIsAStrike(t *testing.T) {
	stale := fixedNow().Add(-(health.StaleShiftHours + 1) * time.Hour)
	f := only(t, run(shiftDiscipline, Inputs{
		Close: CloseDiscipline{TradingDays: 14, ShiftCloseDays: 14, OpenShiftSince: &stale}}))
	if !strings.Contains(f.Detail, "open for more than") {
		t.Errorf("a hanging shift gets its own sentence, got: %q", f.Detail)
	}
}

func TestDrawerVariance_SmallDiscrepanciesAreGoodCounting(t *testing.T) {
	// The real café was out by Rs 25 across 14 shifts. That is a well-run
	// drawer and must produce silence.
	in := Inputs{Shifts: []ShiftVariance{
		{ID: id(60), Diff: -2_500}, {ID: id(61), Diff: 0}, {ID: id(62), Diff: 0},
	}}
	silent(t, run(drawerVariance, in))
}

func TestDrawerVariance_OneBigMissCountsEvenIfTheRestAreClean(t *testing.T) {
	in := Inputs{Shifts: []ShiftVariance{
		{ID: id(60), Diff: -DrawerVarianceSingleCents}, {ID: id(61), Diff: 0},
	}}
	if f := only(t, run(drawerVariance, in)); f.Severity != SeverityWarn {
		t.Errorf("severity = %q, want warn", f.Severity)
	}
}

func TestCreditAging_NeverPaidIsLouderThanSlowPaying(t *testing.T) {
	in := Inputs{Credit: []CreditTab{
		{ID: id(40), Name: "Office Account", BalanceCents: 480_000, DaysSincePayment: nil},
	}}
	f := only(t, run(creditAging, in))
	if f.Severity != SeverityBad {
		t.Errorf("severity = %q, want bad — an account that has only ever taken", f.Severity)
	}
	if !strings.Contains(f.Detail, "never paid anything") {
		t.Errorf("got: %q", f.Detail)
	}
}

func TestCreditAging_IgnoresSmallAndRecent(t *testing.T) {
	in := Inputs{Credit: []CreditTab{
		// Ancient but trivial: not worth chasing or mentioning.
		{ID: id(42), Name: "Petty", BalanceCents: CreditAgingMinCents - 1, DaysSincePayment: ptrInt(400)},
		// Large but current.
		{ID: id(43), Name: "Current", BalanceCents: 5_000_000, DaysSincePayment: ptrInt(CreditAgingWarnDays - 1)},
	}}
	silent(t, run(creditAging, in))
}

func TestDeadItems_OneFindingForTheWholeMenu(t *testing.T) {
	// Seventeen separate findings would bury every money finding in the brief.
	items := make([]DeadItem, 17)
	for i := range items {
		items[i] = DeadItem{ID: id(byte(100 + i)), Name: "Item", EverSold: i%2 == 0}
	}
	f := only(t, run(deadItems, Inputs{Window: baseWindow(), DeadItems: items}))
	if f.Severity != SeverityWarn {
		t.Errorf("severity = %q, want warn — a quiet item must never outrank money", f.Severity)
	}
	if f.MetricValue != 17 {
		t.Errorf("metric = %v, want 17", f.MetricValue)
	}
}

func TestDeadItems_AFewIsJustAMenu(t *testing.T) {
	silent(t, run(deadItems, Inputs{Window: baseWindow(), DeadItems: []DeadItem{
		{ID: id(50), Name: "A"}, {ID: id(51), Name: "B"},
	}}))
}

// =========================================================================
// Integrity
// =========================================================================

func TestIntegrity_UnknownCheckKeyIsNotReported(t *testing.T) {
	// Adding a check to tenant_integrity_check() must not start emailing cafés
	// about it before somebody has written the sentence.
	silent(t, run(integrity, Inputs{Integrity: []IntegrityViolation{
		{CheckKey: "brand_new_check", Entity: "order", EntityID: id(1), DeltaCents: 500},
	}}))
}

func TestIntegrity_OneFindingPerCheckNotPerRow(t *testing.T) {
	var rows []IntegrityViolation
	for i := 0; i < 40; i++ {
		rows = append(rows, IntegrityViolation{
			CheckKey: "drawer_expense_unlinked", Entity: "expense",
			EntityID: id(byte(i)), DeltaCents: 10_000,
		})
	}
	f := only(t, run(integrity, Inputs{Integrity: rows}))
	if f.MetricValue != 40 {
		t.Errorf("metric = %v, want 40 rolled into one finding", f.MetricValue)
	}
	if !strings.HasPrefix(f.Detail, "40 expenses marked paid") {
		t.Errorf("got: %q", f.Detail)
	}
}

func TestIntegrity_SeverityOutranksMoney(t *testing.T) {
	// A Rs 1,200 bookkeeping warn must not sort above a Rs 400 payments-mismatch
	// bad; that reads as though the tidier problem were the bigger one.
	got := run(integrity, Inputs{Integrity: []IntegrityViolation{
		{CheckKey: "drawer_expense_unlinked", Entity: "expense", EntityID: id(1), DeltaCents: 120_000},
		{CheckKey: "payments_vs_total", Entity: "order", EntityID: id(2), DeltaCents: 40_000},
	}})
	if len(got) != 2 {
		t.Fatalf("got %d findings, want 2", len(got))
	}
	if got[0].Severity != SeverityBad {
		t.Fatalf("first finding is %q (%q); bad must come first", got[0].Severity, got[0].Detail)
	}
}

func TestIntegrity_SingularReadsCorrectly(t *testing.T) {
	f := only(t, run(integrity, Inputs{Integrity: []IntegrityViolation{
		{CheckKey: "drawer_expense_unlinked", Entity: "expense", EntityID: id(1), DeltaCents: 120_000},
	}}))
	if strings.Contains(f.Detail, "1 expenses") {
		t.Errorf("sloppy pluralisation makes the numbers look careless: %q", f.Detail)
	}
	if !strings.HasPrefix(f.Detail, "1 expense marked") {
		t.Errorf("got: %q", f.Detail)
	}
}

// =========================================================================
// Whole-registry properties
// =========================================================================

func TestRunAll_IsDeterministic(t *testing.T) {
	// The brief must be reproducible: an accepted finding has to come back in
	// the same place, and a test that asserts on the email cannot chase a map
	// iteration order.
	in := richInputs()
	a := RunAll(fixedNow(), in)
	b := RunAll(fixedNow(), in)
	if len(a) != len(b) {
		t.Fatalf("run lengths differ: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].DetectorKey != b[i].DetectorKey || a[i].Detail != b[i].Detail {
			t.Fatalf("run %d differs:\n  %s / %s\n  %s / %s",
				i, a[i].DetectorKey, a[i].Detail, b[i].DetectorKey, b[i].Detail)
		}
	}
}

// =========================================================================
// The unbounded-findings rule
// =========================================================================

// Learned on real data: creditAging originally emitted one finding per account
// and produced TWENTY-FIVE against the anchor café, burying the four findings
// that actually mattered. Any detector over an open-ended set must name a few
// and roll up the rest.
func TestCreditAging_CapsNamedAccountsAndStatesTheRemainder(t *testing.T) {
	var tabs []CreditTab
	for i := 0; i < 25; i++ {
		tabs = append(tabs, CreditTab{
			ID: id(byte(100 + i)), Name: "Account", BalanceCents: int64(1_000_000 - i*1000),
			DaysSincePayment: ptrInt(90),
		})
	}
	got := run(creditAging, Inputs{Window: baseWindow(), Credit: tabs})

	if len(got) != MaxNamedPerDetector+1 {
		t.Fatalf("got %d findings, want %d named plus one roll-up",
			len(got), MaxNamedPerDetector)
	}
	tail := got[len(got)-1]
	if n, _ := tail.Facts["account_count"].(int); n != 25-MaxNamedPerDetector {
		t.Errorf("roll-up covers %v accounts, want %d", tail.Facts["account_count"], 25-MaxNamedPerDetector)
	}
	// The remainder must be STATED, never silently dropped — a truncated list
	// pretends it was complete.
	if !strings.Contains(tail.Detail, "22 other credit accounts") {
		t.Errorf("roll-up must say how many were folded in, got: %q", tail.Detail)
	}
	// Named ones must be the largest balances.
	if b, _ := got[0].Facts["balance_cents"].(int64); b != 1_000_000 {
		t.Errorf("first named account balance = %d, want the largest (1000000)", b)
	}
}

func TestCreditAging_NoRollupWhenFewEnoughToName(t *testing.T) {
	got := run(creditAging, Inputs{Window: baseWindow(), Credit: []CreditTab{
		{ID: id(40), Name: "A", BalanceCents: 500_000, DaysSincePayment: ptrInt(90)},
		{ID: id(41), Name: "B", BalanceCents: 400_000, DaysSincePayment: ptrInt(90)},
	}})
	if len(got) != 2 {
		t.Fatalf("got %d findings, want 2 with no roll-up", len(got))
	}
	for _, f := range got {
		if f.SubjectKind != SubjectHouseTab {
			t.Errorf("expected per-account findings, got subject kind %q", f.SubjectKind)
		}
	}
}

// A roll-up must be as loud as the loudest thing inside it, or folding three
// `bad` accounts into a `warn` would quietly downgrade them.
func TestRollup_TakesTheWorstSeverityItContains(t *testing.T) {
	var tabs []CreditTab
	for i := 0; i < 5; i++ {
		// The tail entries are never-paid, which is `bad`.
		tabs = append(tabs, CreditTab{
			ID: id(byte(50 + i)), Name: "Never", BalanceCents: int64(900_000 - i*1000),
			DaysSincePayment: nil,
		})
	}
	got := run(creditAging, Inputs{Window: baseWindow(), Credit: tabs})
	tail := got[len(got)-1]
	if tail.Severity != SeverityBad {
		t.Errorf("roll-up severity = %q, want bad", tail.Severity)
	}
}

func TestBelowCost_CapsNamedItems(t *testing.T) {
	var items []ItemMargin
	for i := 0; i < 10; i++ {
		items = append(items, ItemMargin{
			ID: id(byte(70 + i)), Name: "Item", PriceCents: 100, CostCents: 200,
			Qty: 1, LostCents: int64(10_000 - i*100),
		})
	}
	got := run(belowCost, Inputs{Window: baseWindow(), BelowCost: items})
	if len(got) != MaxNamedPerDetector+1 {
		t.Fatalf("got %d findings, want %d named plus one roll-up", len(got), MaxNamedPerDetector)
	}
	if !strings.Contains(got[len(got)-1].Detail, "7 other items") {
		t.Errorf("roll-up must state the count, got: %q", got[len(got)-1].Detail)
	}
}

// The rule, asserted for every detector at once: no detector may produce an
// unbounded pile. Ten is generous — the brief only shows a handful — but it
// catches any future detector that forgets to roll up.
func TestNoDetectorFloodsTheBrief(t *testing.T) {
	in := floodInputs()
	for _, d := range Registry {
		if got := d.Run(fixedNow(), in); len(got) > 10 {
			t.Errorf("detector %q produced %d findings from a large café — roll the tail up "+
				"(see rollup.go)", d.Key, len(got))
		}
	}
}
