// Package health grades how much a cafe is actually using the product.
//
// The deliberate choice here is NOT to produce a single fuzzy score. A score
// tells you a cafe is "63% healthy", which is unactionable — you still have to
// go and find out why. Instead there are three independently graded signals
// plus one checklist, and the overall status is the worst of the three. The
// console always names which signals fired, so a red row explains itself.
//
// The signals are also kept separate from BILLING urgency (see the FE's
// lib/superBilling.ts). "Trial expiring" and "stopped closing shifts" are
// different problems, land on different people's desks, and blending them into
// one column loses information.
//
// Grade is pure and takes `now` explicitly, mirroring billing.ComputeState, so
// every threshold and boundary is testable without a database.
package health

import (
	"strconv"
	"time"
)

// Status is the overall verdict for a cafe.
type Status string

const (
	// StatusOnboarding — too new to judge. Suppresses the volume signal, which
	// would otherwise flag every brand-new cafe as collapsing (it has no
	// baseline to fall from).
	StatusOnboarding Status = "onboarding"
	StatusHealthy    Status = "healthy"
	StatusWatch      Status = "watch"
	StatusAtRisk     Status = "at_risk"
	// StatusDormant — no trade at all for a fortnight. The loudest state; it
	// beats every other signal because nothing else matters if they've stopped.
	StatusDormant Status = "dormant"
)

// Grade of a single signal.
type Grade string

const (
	GradeGood Grade = "good"
	GradeWarn Grade = "warn"
	GradeBad  Grade = "bad"
	// GradeNA — not applicable (e.g. volume during the onboarding window).
	GradeNA Grade = "na"
)

// Thresholds. Named constants rather than literals so the tests and the UI
// copy can both refer to the same numbers.
const (
	// OnboardingDays — below this age a cafe is still being set up.
	OnboardingDays = 14
	// DormantDays — no closed order in this long means they've stopped.
	DormantDays = 14

	// A shift left open longer than this is a strike: staff opened a shift and
	// walked away, which is the same discipline failure as never closing one.
	StaleShiftHours = 36

	// shift_discipline: operating days with no closed shift, over 7 days.
	ShiftMissesWarn = 1 // 1–2 misses
	ShiftMissesBad  = 3

	// volume: last 7 days vs the median of the 4 preceding 7-day buckets.
	VolumeGoodRatio = 0.7
	VolumeWarnRatio = 0.4

	// engagement: distinct members seen in the last 7 days.
	EngagementGood = 2
	EngagementWarn = 1
)

// Signals is the raw rollup for one cafe — the shape platform_tenant_usage()
// returns, plus the tenant's age.
type Signals struct {
	TenantAgeDays int

	LastOrderClosedAt *time.Time
	Orders7d          int
	OrdersPrev28d     int
	OperatingDays7d   int
	ShiftClosedDays7d int
	OpenShiftSince    *time.Time
	ActiveMembers7d   int

	MenuItemCount int
	Adoption      Adoption
}

// Adoption is the checklist signal — never graded, because a cafe that simply
// doesn't need inventory isn't unhealthy. It drives onboarding follow-up and
// upsell, so it's surfaced as a list of ticks rather than a colour.
type Adoption struct {
	Inventory bool `json:"inventory"`
	Expenses  bool `json:"expenses"`
	Credit    bool `json:"credit"`
	Staff     int  `json:"staff"`
	Outlets   int  `json:"outlets"`
}

// SignalResult is one graded signal with the numbers behind it, so the UI can
// say "3 of 6 operating days had no shift close" rather than just "bad".
type SignalResult struct {
	Key    string  `json:"key"`
	Grade  Grade   `json:"grade"`
	Detail string  `json:"detail"`
	Value  float64 `json:"value"`
}

// Result is the graded verdict.
type Result struct {
	Status Status `json:"status"`
	// Reasons lists the signal keys that pushed the status away from healthy,
	// so the console can name them in a tooltip instead of showing a bare
	// colour. Empty when healthy.
	Reasons []string       `json:"reasons"`
	Signals []SignalResult `json:"signals"`
}

// worst returns the more severe of two grades. GradeNA never wins.
func worst(a, b Grade) Grade {
	rank := map[Grade]int{GradeNA: 0, GradeGood: 1, GradeWarn: 2, GradeBad: 3}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

func statusFor(g Grade) Status {
	switch g {
	case GradeBad:
		return StatusAtRisk
	case GradeWarn:
		return StatusWatch
	default:
		return StatusHealthy
	}
}

// Compute grades the signals. Pure: `now` is explicit so boundaries are
// testable at a fixed instant.
func Compute(now time.Time, s Signals) Result {
	shift := gradeShiftDiscipline(now, s)
	volume := gradeVolume(s)
	engagement := gradeEngagement(s)
	res := Result{Signals: []SignalResult{shift, volume, engagement}}

	// Override 1: too new to judge. Checked before the worst-of roll-up so a
	// cafe in its first fortnight is never labelled at-risk for not yet having
	// a routine.
	if s.TenantAgeDays < OnboardingDays {
		res.Status = StatusOnboarding
		return res
	}

	// Override 2: no trade at all. Beats everything — a cafe that has stopped
	// selling has no meaningful shift discipline to grade.
	if s.LastOrderClosedAt == nil || now.Sub(*s.LastOrderClosedAt) > DormantDays*24*time.Hour {
		res.Status = StatusDormant
		res.Reasons = []string{"dormant"}
		return res
	}

	overall := GradeGood
	for _, sig := range res.Signals {
		overall = worst(overall, sig.Grade)
		if sig.Grade == GradeWarn || sig.Grade == GradeBad {
			res.Reasons = append(res.Reasons, sig.Key)
		}
	}
	res.Status = statusFor(overall)
	return res
}

// gradeShiftDiscipline counts operating days that ended without a shift close,
// plus a strike for a shift left hanging open.
func gradeShiftDiscipline(now time.Time, s Signals) SignalResult {
	misses := s.OperatingDays7d - s.ShiftClosedDays7d
	if misses < 0 {
		// More close-days than operating-days: they closed a shift on a day
		// with no sales. Tidy, not a problem.
		misses = 0
	}
	stale := s.OpenShiftSince != nil && now.Sub(*s.OpenShiftSince) > StaleShiftHours*time.Hour
	if stale {
		misses++
	}

	out := SignalResult{Key: "shift_discipline", Value: float64(misses)}
	switch {
	case misses >= ShiftMissesBad:
		out.Grade = GradeBad
	case misses >= ShiftMissesWarn:
		out.Grade = GradeWarn
	default:
		out.Grade = GradeGood
	}

	switch {
	case s.OperatingDays7d == 0 && !stale:
		out.Detail = "no trading days in the last week"
	case stale && misses == 1:
		out.Detail = "a shift has been open for more than " + strconv.Itoa(StaleShiftHours) + " hours"
	case stale:
		out.Detail = strconv.Itoa(misses-1) + " of " + strconv.Itoa(s.OperatingDays7d) +
			" trading days had no shift close, and a shift is still hanging open"
	case misses == 0:
		out.Detail = "every trading day was closed off"
	default:
		out.Detail = strconv.Itoa(misses) + " of " + strconv.Itoa(s.OperatingDays7d) + " trading days had no shift close"
	}
	return out
}

// gradeVolume compares the last 7 days against the average weekly rate of the
// preceding 4 weeks.
func gradeVolume(s Signals) SignalResult {
	out := SignalResult{Key: "volume"}
	// No baseline to fall from — say so rather than inventing a ratio.
	if s.OrdersPrev28d == 0 {
		out.Grade = GradeNA
		out.Detail = "no earlier weeks to compare against"
		return out
	}
	baseline := float64(s.OrdersPrev28d) / 4.0
	ratio := float64(s.Orders7d) / baseline
	out.Value = ratio

	switch {
	case ratio >= VolumeGoodRatio:
		out.Grade = GradeGood
	case ratio >= VolumeWarnRatio:
		out.Grade = GradeWarn
	default:
		out.Grade = GradeBad
	}
	out.Detail = strconv.Itoa(s.Orders7d) + " orders this week vs " + strconv.Itoa(int(baseline+0.5)) + " a week before"
	return out
}

func gradeEngagement(s Signals) SignalResult {
	out := SignalResult{Key: "engagement", Value: float64(s.ActiveMembers7d)}
	switch {
	case s.ActiveMembers7d >= EngagementGood:
		out.Grade = GradeGood
		out.Detail = strconv.Itoa(s.ActiveMembers7d) + " people used the app this week"
	case s.ActiveMembers7d >= EngagementWarn:
		out.Grade = GradeWarn
		out.Detail = "only one person used the app this week"
	default:
		out.Grade = GradeBad
		out.Detail = "nobody signed in this week"
	}
	return out
}
