package insight

import (
	"time"

	"github.com/google/uuid"
)

// Inputs is everything the detectors get to see, gathered once per café per run
// by gather.go in a handful of wide queries rather than one query per detector.
//
// It is a plain snapshot with no methods that touch IO, which is what makes the
// detectors pure. Adding a field here is cheap; adding a query inside a detector
// is not allowed.
type Inputs struct {
	// Loc is the café's own timezone. Every date boundary in Window and in the
	// day-based counts below was computed in it, matching what resolveRangeFull
	// does for reports so a finding and a report never disagree about "today".
	Loc *time.Location

	// Window is the period under examination; Prior is the window of the same
	// length immediately before it — the same convention analytics.go uses for
	// item-level deltas.
	Window Window
	Prior  Window

	// Integrity is the output of tenant_integrity_check(): arithmetic that does
	// not reconcile. Empty is the healthy and expected case.
	Integrity []IntegrityViolation

	// CostCoverage: how much of the window's revenue came from items that have a
	// real cost recorded. menu_items.cost_cents is nullable and NULL is treated
	// as zero throughout the app, so margins silently OVERSTATE until this is
	// high. Every margin finding carries the caveat derived from it.
	CostCoverage Coverage
	// ExpenseCoverage: how much of the window's spend is attributed to a
	// category via expense_allocations. Profit is not knowable while this is low.
	ExpenseCoverage Coverage

	Close CloseDiscipline

	// Countable acts that reduce recorded takings, each with its per-actor split.
	Voids       ActSummary
	Discounts   ActSummary
	Retractions ActSummary // payments entered and then removed (payment_voids, 0067)

	// ActiveStaff is how many distinct people touched orders in the window.
	// Concentration detectors check this first: with one operator every share is
	// 100% and saying so tells the owner nothing they don't know.
	ActiveStaff int

	Categories []CategoryMargin
	BelowCost  []ItemMargin
	Credit     []CreditTab
	DeadItems  []DeadItem
	Shifts     []ShiftVariance
}

// CloseDiscipline counts trading days that ended without a drawer reconciliation.
// Deliberately the same shape health.Signals uses, so the tenant-facing detector
// and the platform-facing health grade can never drift apart.
type CloseDiscipline struct {
	TradingDays    int
	ShiftCloseDays int
	// OpenShiftSince is set when a shift is still hanging open, which is the same
	// discipline failure as never closing one.
	OpenShiftSince *time.Time
}

// Misses is trading days with no close, floored at zero. More closes than
// trading days means they tidied up on a day with no sales, which is not a
// problem — health.gradeShiftDiscipline makes the same allowance.
func (c CloseDiscipline) Misses() int {
	if m := c.TradingDays - c.ShiftCloseDays; m > 0 {
		return m
	}
	return 0
}

// ActSummary is a countable act over the window, with who did it.
type ActSummary struct {
	Count      int
	ValueCents int64
	Actors     []ActorStat
}

// TopActor returns the largest contributor by value, and false when there is
// nothing to report.
func (a ActSummary) TopActor() (ActorStat, bool) {
	var best ActorStat
	found := false
	for _, s := range a.Actors {
		if !found || s.ValueCents > best.ValueCents {
			best, found = s, true
		}
	}
	return best, found
}

// CategoryMargin is one menu category's gross margin this window and last.
// Direct cost only — allocated overhead is a separate, manual attribution and
// folding it in here would make the comparison move for reasons the owner did
// not cause.
type CategoryMargin struct {
	ID                uuid.UUID
	Name              string
	RevenueCents      int64
	CostCents         int64
	PriorRevenueCents int64
	PriorCostCents    int64
}

// Margin is gross margin as a 0..1 ratio, false when there was no revenue.
func (c CategoryMargin) Margin() (float64, bool) {
	return marginOf(c.RevenueCents, c.CostCents)
}

// PriorMargin is the same for the preceding window. False means there is no
// baseline — the caller must then say nothing rather than treat it as zero.
func (c CategoryMargin) PriorMargin() (float64, bool) {
	return marginOf(c.PriorRevenueCents, c.PriorCostCents)
}

func marginOf(revenue, cost int64) (float64, bool) {
	if revenue <= 0 {
		return 0, false
	}
	return float64(revenue-cost) / float64(revenue), true
}

// ItemMargin is an item that sold at or below what it cost.
type ItemMargin struct {
	ID         uuid.UUID
	Name       string
	PriceCents int64
	CostCents  int64
	Qty        float64
	// LostCents is (cost − price) × qty over the window: the money the café gave
	// away. Zero when it sold exactly at cost, which still warrants a mention.
	LostCents int64
}

// CreditTab is an outstanding house-tab balance. "Credit" is the customer-facing
// word (0050 renamed it in the UI); the tables are still house_tab*.
type CreditTab struct {
	ID           uuid.UUID
	Name         string
	BalanceCents int64
	// DaysSincePayment is how long since anything was collected against this
	// tab. Nil when nothing has ever been collected, which is a different and
	// louder fact than "collected a long time ago".
	DaysSincePayment *int
}

// DeadItem is an active menu item nobody ordered in the window.
type DeadItem struct {
	ID   uuid.UUID
	Name string
	// EverSold distinguishes a listing that has gone stale from one that never
	// worked at all. They deserve different sentences.
	EverSold bool
}

// ShiftVariance is one closed drawer reconciliation.
type ShiftVariance struct {
	ID   uuid.UUID
	Day  time.Time
	Diff int64 // counted − expected; negative is short
}
