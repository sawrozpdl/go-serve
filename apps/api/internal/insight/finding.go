// Package insight turns a café's own rows into a short list of things worth its
// owner's attention, and remembers what they decided to do about each one.
//
// # THE DIVISION OF LABOUR, which is the whole design
//
// Detectors are PURE FUNCTIONS over a pre-gathered Inputs snapshot. They do the
// arithmetic, they pick the severity, and they write the sentence. No detector
// touches a database, a clock, or a template. That is what makes them testable
// the way internal/platform/health is testable: a table of hand-built Inputs at
// a fixed instant, asserting the exact Detail string.
//
// A language model, when one is involved at all, only ever REORDERS and
// REPHRASES what a detector already computed — see the weekly wrap. It never
// does arithmetic and never selects. Selection lives in select.go so that an
// accepted finding reliably comes back, and so the brief can be tested.
//
// # THE RULE EVERY DETECTOR OBEYS
//
// Only surface what the person standing at the counter could not have seen.
// They know it rained and they know the power cut. What they cannot see is
// margin drift, cost creep, coverage gaps, credit quietly aging, and arithmetic
// that does not reconcile.
//
// And: when there is nothing to compare against, say nothing. health.gradeVolume
// returns GradeNA with "no earlier weeks to compare against" rather than
// inventing a ratio; variance-match.ts stays silent rather than guessing between
// two candidates. A detector with no baseline returns no finding — never a
// finding built on a zero denominator.
package insight

import (
	"time"

	"github.com/google/uuid"
)

// Severity mirrors the warn/bad half of health.Grade. There is deliberately no
// "good" and no "not applicable": a detector with nothing to report returns an
// empty slice, so the existence of a Finding always means something needs
// attention. That is what lets the brief be built by simply listing findings.
type Severity string

const (
	SeverityWarn Severity = "warn"
	SeverityBad  Severity = "bad"
)

// severityRank orders severities so "worse than" is a comparison rather than a
// pile of special cases, exactly like jobs.statusRank.
var severityRank = map[Severity]int{SeverityWarn: 0, SeverityBad: 1}

// WorseThan reports whether s is more severe than other.
func (s Severity) WorseThan(other Severity) bool {
	return severityRank[s] > severityRank[other]
}

// SubjectKind is what a finding is ABOUT. It pairs with SubjectKey to form the
// finding's identity, and the values match the CHECK constraint on
// insight_findings.subject_kind.
type SubjectKind string

const (
	// SubjectTenant is a finding about the café as a whole — books confidence,
	// unallocated spend, shift discipline. SubjectKey is "" for these, which is
	// why subject_key is text and not uuid: a café-wide finding needs no
	// sentinel id.
	SubjectTenant   SubjectKind = "tenant"
	SubjectMenuItem SubjectKind = "menu_item"
	SubjectCategory SubjectKind = "menu_category"
	SubjectShift    SubjectKind = "shift"
	SubjectHouseTab SubjectKind = "house_tab"
	SubjectUser     SubjectKind = "user"
	SubjectStock    SubjectKind = "inventory_item"
)

// Unit is what MetricValue is measured in, so the renderer and the UI can format
// a number without guessing.
type Unit string

const (
	UnitCents   Unit = "cents"
	UnitCount   Unit = "count"
	UnitRatio   Unit = "ratio" // 0..1, rendered as a percentage
	UnitDays    Unit = "days"
	UnitMinutes Unit = "minutes"
)

// Finding is one thing worth an owner's attention on one day.
//
// It carries both the identity (DetectorKey + Subject*) that the durable
// insight_findings row is keyed on, and the day's numbers that become an
// insight_observations row. store.go splits it across the two tables; detectors
// only ever construct whole Findings.
type Finding struct {
	// DetectorKey is set by the registry, not by the detector function, so a
	// detector cannot disagree with its own registration.
	DetectorKey string

	SubjectKind  SubjectKind
	SubjectKey   string
	SubjectLabel string

	Severity Severity

	// Detail is the sentence the owner reads. Written by the detector, in full,
	// with its own numbers already formatted — because the detector is the only
	// thing that knows which of its numbers matter. Tests assert on this string
	// exactly, so it doubles as the specification of what the rule means.
	Detail string

	// MetricValue is the one number this finding is about, in Unit.
	MetricValue float64
	Unit        Unit
	// Baseline is what MetricValue is being compared against, when there is
	// something to compare against. Nil means there wasn't — preserved rather
	// than flattened to zero, so "no baseline" survives into the database and
	// the UI can say so.
	Baseline *float64

	// Facts is the supporting numbers, for the evidence view and for anything
	// that later wants to re-render without re-running the detector.
	Facts map[string]any

	// LinkArgs fills the detector's LinkTpl. Kept separate from the template so
	// the detector never builds a URL and the registry lint can check arity.
	LinkArgs []any

	// LinkPath overrides the detector's template for this one finding, and wins
	// when set. Roll-ups need it: creditAging's template is
	// "/admin/credit/%s" for a named account, but the finding that stands for
	// twenty-two others belongs on the list page, and feeding it an empty id
	// produced "/admin/credit/" — a link to nowhere, in an email.
	LinkPath string
}

// Window is a closed date range in the café's own timezone, plus the totals
// every detector tends to want. Detectors receive one for the current window and
// one for the window immediately before it, which is the same "prior period of
// the same length" convention analytics.go already uses for item deltas.
type Window struct {
	From time.Time
	To   time.Time

	// RevenueCents is net of voids, on closed orders, attributed by closed_at —
	// the same basis as every existing report, so a finding can never disagree
	// with the dashboard the owner opens next.
	RevenueCents int64
	OrderCount   int
	LineCount    int
}

// Days is the window's length in whole days, used for per-day rates.
func (w Window) Days() int {
	d := int(w.To.Sub(w.From).Hours() / 24)
	if d < 1 {
		return 1
	}
	return d
}

// Coverage is "how much of this do we actually know", the shape behind Books
// Confidence. Two amounts rather than a precomputed ratio, so a detector can
// report the absolute gap (which is what an owner acts on) as well as the
// proportion, and so a zero denominator is visible instead of dividing by it.
type Coverage struct {
	KnownCents int64
	TotalCents int64
}

// Ratio is the covered proportion, and false when there is nothing to divide by.
func (c Coverage) Ratio() (float64, bool) {
	if c.TotalCents <= 0 {
		return 0, false
	}
	return float64(c.KnownCents) / float64(c.TotalCents), true
}

// GapCents is the uncovered amount — the number worth putting in a sentence.
func (c Coverage) GapCents() int64 { return c.TotalCents - c.KnownCents }

// ActorStat is one person's share of some countable act (a void, a discount).
// Concentration detectors need at least two of these to say anything: with a
// single operator every share is 100% and naming them tells the owner something
// they already know. See detectors/leakage.go.
type ActorStat struct {
	UserID     uuid.UUID
	Name       string
	Count      int
	ValueCents int64
}

// IntegrityViolation is one row from tenant_integrity_check() (migration 0068).
type IntegrityViolation struct {
	CheckKey   string
	Entity     string
	EntityID   uuid.UUID
	DeltaCents int64
	OccurredAt time.Time
}
