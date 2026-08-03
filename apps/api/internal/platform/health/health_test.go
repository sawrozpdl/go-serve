package health

import (
	"testing"
	"time"
)

var now = time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)

func ago(d time.Duration) *time.Time {
	t := now.Add(-d)
	return &t
}

// established is a healthy, mature cafe — every test starts from this and
// perturbs exactly one thing, so a failure names its own cause.
func established() Signals {
	return Signals{
		TenantAgeDays:     120,
		LastOrderClosedAt: ago(2 * time.Hour),
		Orders7d:          140,
		OrdersPrev28d:     560, // 140/week — flat
		OperatingDays7d:   7,
		ShiftClosedDays7d: 7,
		ActiveMembers7d:   4,
	}
}

func gradeOf(r Result, key string) Grade {
	for _, s := range r.Signals {
		if s.Key == key {
			return s.Grade
		}
	}
	return "missing"
}

func hasReason(r Result, want string) bool {
	for _, k := range r.Reasons {
		if k == want {
			return true
		}
	}
	return false
}

func TestCompute_HealthyBaseline(t *testing.T) {
	r := Compute(now, established())
	if r.Status != StatusHealthy {
		t.Fatalf("status = %q, want healthy (reasons: %v)", r.Status, r.Reasons)
	}
	if len(r.Reasons) != 0 {
		t.Errorf("a healthy cafe should have no reasons, got %v", r.Reasons)
	}
	if len(r.Signals) != 3 {
		t.Errorf("want 3 graded signals, got %d", len(r.Signals))
	}
}

// --- overrides -----------------------------------------------------------

// A brand-new cafe has no baseline to fall from, so grading it on volume would
// flag every single signup as collapsing.
func TestCompute_OnboardingWindowSuppressesEverything(t *testing.T) {
	s := established()
	s.TenantAgeDays = OnboardingDays - 1
	s.Orders7d = 0
	s.OperatingDays7d = 5
	s.ShiftClosedDays7d = 0 // would otherwise be at_risk
	s.ActiveMembers7d = 0

	if got := Compute(now, s).Status; got != StatusOnboarding {
		t.Errorf("status = %q, want onboarding for a %d-day-old cafe", got, s.TenantAgeDays)
	}
}

func TestCompute_OnboardingBoundary(t *testing.T) {
	s := established()
	s.TenantAgeDays = OnboardingDays // exactly at the boundary = old enough
	if got := Compute(now, s).Status; got == StatusOnboarding {
		t.Errorf("a cafe exactly %d days old should be graded normally", OnboardingDays)
	}
}

// Dormant beats everything: shift discipline is meaningless once they've
// stopped selling.
func TestCompute_DormantBeatsOtherSignals(t *testing.T) {
	s := established()
	s.LastOrderClosedAt = ago((DormantDays + 1) * 24 * time.Hour)
	r := Compute(now, s)
	if r.Status != StatusDormant {
		t.Errorf("status = %q, want dormant", r.Status)
	}
	if !hasReason(r, "dormant") {
		t.Errorf("reasons = %v, want it to name dormant", r.Reasons)
	}
}

func TestCompute_NeverTradedIsDormant(t *testing.T) {
	s := established()
	s.LastOrderClosedAt = nil
	if got := Compute(now, s).Status; got != StatusDormant {
		t.Errorf("status = %q, want dormant when there has never been a closed order", got)
	}
}

func TestCompute_JustInsideDormantWindowIsNot(t *testing.T) {
	s := established()
	s.LastOrderClosedAt = ago(DormantDays*24*time.Hour - time.Hour)
	if got := Compute(now, s).Status; got == StatusDormant {
		t.Error("a cafe that traded within the window must not be dormant")
	}
}

// --- shift discipline ----------------------------------------------------

func TestShiftDiscipline_Thresholds(t *testing.T) {
	for _, tc := range []struct {
		name        string
		operating   int
		closed      int
		wantGrade   Grade
		wantOverall Status
	}{
		{"every day closed off", 7, 7, GradeGood, StatusHealthy},
		{"one miss", 7, 6, GradeWarn, StatusWatch},
		{"two misses", 7, 5, GradeWarn, StatusWatch},
		{"three misses", 7, 4, GradeBad, StatusAtRisk},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := established()
			s.OperatingDays7d = tc.operating
			s.ShiftClosedDays7d = tc.closed
			r := Compute(now, s)
			if got := gradeOf(r, "shift_discipline"); got != tc.wantGrade {
				t.Errorf("grade = %q, want %q", got, tc.wantGrade)
			}
			if r.Status != tc.wantOverall {
				t.Errorf("status = %q, want %q", r.Status, tc.wantOverall)
			}
		})
	}
}

// Closing a shift on a day with no sales is tidy, not a fault — it must not
// produce a negative miss count that masks a real problem elsewhere.
func TestShiftDiscipline_MoreClosesThanTradingDaysIsFine(t *testing.T) {
	s := established()
	s.OperatingDays7d = 3
	s.ShiftClosedDays7d = 5
	if got := gradeOf(Compute(now, s), "shift_discipline"); got != GradeGood {
		t.Errorf("grade = %q, want good", got)
	}
}

// A shift left hanging open is the same discipline failure as never closing
// one, and must count even when every trading day was otherwise closed off.
func TestShiftDiscipline_StaleOpenShiftCountsAsAMiss(t *testing.T) {
	s := established()
	s.OpenShiftSince = ago((StaleShiftHours + 1) * time.Hour)
	r := Compute(now, s)
	if got := gradeOf(r, "shift_discipline"); got != GradeWarn {
		t.Errorf("grade = %q, want warn for a stale open shift", got)
	}
	if r.Status != StatusWatch {
		t.Errorf("status = %q, want watch", r.Status)
	}
}

// A shift open since this morning is just a shift in progress.
func TestShiftDiscipline_FreshOpenShiftIsNotAMiss(t *testing.T) {
	s := established()
	s.OpenShiftSince = ago(4 * time.Hour)
	if got := gradeOf(Compute(now, s), "shift_discipline"); got != GradeGood {
		t.Errorf("grade = %q, want good for a shift opened 4h ago", got)
	}
}

func TestShiftDiscipline_StaleShiftBoundary(t *testing.T) {
	s := established()
	s.OpenShiftSince = ago(StaleShiftHours * time.Hour) // exactly at the limit
	if got := gradeOf(Compute(now, s), "shift_discipline"); got != GradeGood {
		t.Errorf("grade = %q, want good exactly at the %dh boundary", got, StaleShiftHours)
	}
}

// --- volume --------------------------------------------------------------

func TestVolume_Thresholds(t *testing.T) {
	// Baseline is 100 orders/week (400 over the preceding 28 days).
	for _, tc := range []struct {
		name      string
		orders7d  int
		wantGrade Grade
	}{
		{"holding steady", 100, GradeGood},
		{"exactly at the good boundary", 70, GradeGood},
		{"slipping", 69, GradeWarn},
		{"exactly at the warn boundary", 40, GradeWarn},
		{"collapsing", 39, GradeBad},
		{"stopped", 0, GradeBad},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := established()
			s.OrdersPrev28d = 400
			s.Orders7d = tc.orders7d
			if got := gradeOf(Compute(now, s), "volume"); got != tc.wantGrade {
				t.Errorf("grade = %q, want %q", got, tc.wantGrade)
			}
		})
	}
}

// Growth must never be penalised.
func TestVolume_GrowthIsGood(t *testing.T) {
	s := established()
	s.OrdersPrev28d = 400
	s.Orders7d = 300
	if got := gradeOf(Compute(now, s), "volume"); got != GradeGood {
		t.Errorf("grade = %q, want good for a cafe tripling its trade", got)
	}
}

// No history means no verdict — an invented ratio would be worse than none.
func TestVolume_NoBaselineIsNotApplicable(t *testing.T) {
	s := established()
	s.OrdersPrev28d = 0
	r := Compute(now, s)
	if got := gradeOf(r, "volume"); got != GradeNA {
		t.Errorf("grade = %q, want na", got)
	}
	// GradeNA must not drag the overall status down.
	if r.Status != StatusHealthy {
		t.Errorf("status = %q, want healthy — an n/a signal must not count against them", r.Status)
	}
}

// --- engagement ----------------------------------------------------------

func TestEngagement_Thresholds(t *testing.T) {
	for _, tc := range []struct {
		members   int
		wantGrade Grade
	}{
		{5, GradeGood},
		{2, GradeGood},
		{1, GradeWarn},
		{0, GradeBad},
	} {
		s := established()
		s.ActiveMembers7d = tc.members
		if got := gradeOf(Compute(now, s), "engagement"); got != tc.wantGrade {
			t.Errorf("%d members: grade = %q, want %q", tc.members, got, tc.wantGrade)
		}
	}
}

// --- worst-of roll-up ----------------------------------------------------

// The overall status is the WORST signal, not an average — one bad signal must
// not be diluted by two good ones.
func TestCompute_WorstSignalWins(t *testing.T) {
	s := established()
	s.ActiveMembers7d = 0 // bad
	// shift + volume stay good
	r := Compute(now, s)
	if r.Status != StatusAtRisk {
		t.Errorf("status = %q, want at_risk — one bad signal decides it", r.Status)
	}
	if !hasReason(r, "engagement") {
		t.Errorf("reasons = %v, want engagement named", r.Reasons)
	}
	if hasReason(r, "volume") || hasReason(r, "shift_discipline") {
		t.Errorf("reasons = %v, should only name the signals that actually fired", r.Reasons)
	}
}

func TestCompute_MultipleReasonsAllNamed(t *testing.T) {
	s := established()
	s.ShiftClosedDays7d = 6 // warn
	s.ActiveMembers7d = 1   // warn
	r := Compute(now, s)
	if r.Status != StatusWatch {
		t.Errorf("status = %q, want watch", r.Status)
	}
	if !hasReason(r, "shift_discipline") || !hasReason(r, "engagement") {
		t.Errorf("reasons = %v, want both signals named", r.Reasons)
	}
}

// Every graded signal must carry human-readable detail — a bare colour is
// exactly what this design set out to avoid.
func TestCompute_EverySignalExplainsItself(t *testing.T) {
	for _, s := range []Signals{established(), {TenantAgeDays: 90, LastOrderClosedAt: ago(time.Hour)}} {
		for _, sig := range Compute(now, s).Signals {
			if sig.Detail == "" {
				t.Errorf("signal %q has no detail text", sig.Key)
			}
		}
	}
}
