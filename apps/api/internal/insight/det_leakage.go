package insight

import (
	"fmt"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// Money that leaves without a sale behind it.
//
// TWO SHAPES, AND WHY BOTH EXIST
//
// A RATE detector ("5% of your takings were voided") works at any size and is
// the useful one for the café this product is actually sold to: on real data the
// anchor café had 684 orders in a month and exactly ONE person operating the
// till.
//
// A CONCENTRATION detector ("most of it was one person") needs at least two
// people to mean anything. With a single operator every share is 100% and the
// answer is always the owner, which is precisely the "thing you already knew"
// this engine refuses to say. So concentration detectors check ActiveStaff first
// and return nothing below two.
//
// WHAT CONCENTRATION CANNOT CLAIM
//
// There is no attendance data anywhere in the schema — `shifts` is one drawer
// session per café, not a per-person clock-in, and there are no hours or wage
// rates. So a person's share of voids CANNOT be normalised by how much they
// actually worked. Someone with 70% of the voids may simply have run 70% of the
// service. These detectors therefore cap at `warn`, never `bad`, and the
// sentence states the alternative explanation out loud. Ranking staff on this
// would be both unfair and, in a six-person café where staff are often family,
// actively damaging.

const (
	// Voided line value as a share of the window's revenue.
	VoidRateWarn = 0.03
	VoidRateBad  = 0.08

	// Discount value as a share of revenue. Higher bars than voids: discounting
	// is a deliberate tool, and an owner does not need to be told they used it.
	DiscountRateWarn = 0.05
	DiscountRateBad  = 0.12

	// A single actor holding this much of the value is worth a look.
	ConcentrationShare = 0.70
	// Below two operators, concentration is arithmetic with no information in it.
	ConcentrationMinStaff = 2

	// Payments entered and then removed before the bill closed.
	RetractionWarnCount = 3
	RetractionBadCount  = 10
)

// rateOf expresses an act's value as a share of window revenue. False when
// there was no revenue to compare against — the no-baseline case.
func rateOf(valueCents, revenueCents int64) (float64, bool) {
	if revenueCents <= 0 {
		return 0, false
	}
	return float64(valueCents) / float64(revenueCents), true
}

// gradeRate maps a ratio onto warn/bad, or reports that it is unremarkable.
func gradeRate(ratio, warn, bad float64) (Severity, bool) {
	switch {
	case ratio >= bad:
		return SeverityBad, true
	case ratio >= warn:
		return SeverityWarn, true
	default:
		return "", false
	}
}

var voidRate = Detector{
	Key:     "void_rate",
	Label:   "Voided sales",
	Perm:    "report:read",
	LinkTpl: "/admin/history",
	Fn: func(_ time.Time, in Inputs) []Finding {
		if in.Voids.Count == 0 {
			return nil
		}
		ratio, ok := rateOf(in.Voids.ValueCents, in.Window.RevenueCents)
		if !ok {
			return nil
		}
		sev, notable := gradeRate(ratio, VoidRateWarn, VoidRateBad)
		if !notable {
			return nil
		}
		baseline := VoidRateWarn
		return []Finding{{
			SubjectKind:  SubjectTenant,
			SubjectLabel: "Voided sales",
			Severity:     sev,
			Detail: fmt.Sprintf(
				"%d items worth %s were voided in the last %d days — %.1f%% of takings. "+
					"Voids are normal at the till, but at this level it is worth knowing whether they are "+
					"corrections, kitchen mistakes, or something else.",
				in.Voids.Count, audit.Money(in.Voids.ValueCents), in.Window.Days(), ratio*100),
			MetricValue: ratio,
			Unit:        UnitRatio,
			Baseline:    &baseline,
			Facts: map[string]any{
				"void_count":    in.Voids.Count,
				"void_cents":    in.Voids.ValueCents,
				"revenue_cents": in.Window.RevenueCents,
			},
		}}
	},
}

var discountRate = Detector{
	Key:     "discount_rate",
	Label:   "Discounts given",
	Perm:    "report:read",
	LinkTpl: "/admin/history",
	Fn: func(_ time.Time, in Inputs) []Finding {
		if in.Discounts.Count == 0 {
			return nil
		}
		ratio, ok := rateOf(in.Discounts.ValueCents, in.Window.RevenueCents)
		if !ok {
			return nil
		}
		sev, notable := gradeRate(ratio, DiscountRateWarn, DiscountRateBad)
		if !notable {
			return nil
		}
		baseline := DiscountRateWarn
		return []Finding{{
			SubjectKind:  SubjectTenant,
			SubjectLabel: "Discounts given",
			Severity:     sev,
			Detail: fmt.Sprintf(
				"%s came off bills as discounts in the last %d days — %.1f%% of takings, across %d bills. "+
					"That is money you chose to give away, so the question is whether it bought you anything.",
				audit.Money(in.Discounts.ValueCents), in.Window.Days(), ratio*100, in.Discounts.Count),
			MetricValue: ratio,
			Unit:        UnitRatio,
			Baseline:    &baseline,
			Facts: map[string]any{
				"discount_count": in.Discounts.Count,
				"discount_cents": in.Discounts.ValueCents,
			},
		}}
	},
}

// concentration builds the shared "one person holds most of this" finding, or
// nothing. Shared by voids and discounts because the reasoning and the caveat
// are identical and should never be allowed to drift between them.
func concentration(in Inputs, act ActSummary, kind, label, link string) []Finding {
	if in.ActiveStaff < ConcentrationMinStaff || act.ValueCents <= 0 || len(act.Actors) < 2 {
		return nil
	}
	top, ok := act.TopActor()
	if !ok {
		return nil
	}
	share := float64(top.ValueCents) / float64(act.ValueCents)
	if share < ConcentrationShare {
		return nil
	}
	baseline := ConcentrationShare
	return []Finding{{
		SubjectKind:  SubjectUser,
		SubjectKey:   top.UserID.String(),
		SubjectLabel: top.Name,
		// Never `bad`: without attendance data this cannot be normalised by how
		// much each person actually worked, so it is a prompt to look, not a
		// conclusion.
		Severity: SeverityWarn,
		Detail: fmt.Sprintf(
			"%s accounts for %.0f%% of %s in the last %d days (%s of %s, across %d of %d). "+
				"They may simply have worked the most service — the app does not record hours, so this "+
				"is a place to look rather than a conclusion.",
			top.Name, share*100, kind, in.Window.Days(),
			audit.Money(top.ValueCents), audit.Money(act.ValueCents),
			top.Count, act.Count),
		MetricValue: share,
		Unit:        UnitRatio,
		Baseline:    &baseline,
		Facts: map[string]any{
			"actor_cents":  top.ValueCents,
			"total_cents":  act.ValueCents,
			"actor_count":  top.Count,
			"total_count":  act.Count,
			"active_staff": in.ActiveStaff,
		},
	}}
}

var voidConcentration = Detector{
	Key:     "void_concentration",
	Label:   "Voids by one person",
	Perm:    "report:read",
	LinkTpl: "/admin/history",
	Fn: func(_ time.Time, in Inputs) []Finding {
		return concentration(in, in.Voids, "voided value", "Voids by one person", "/admin/history")
	},
}

var discountConcentration = Detector{
	Key:     "discount_concentration",
	Label:   "Discounts by one person",
	Perm:    "report:read",
	LinkTpl: "/admin/history",
	Fn: func(_ time.Time, in Inputs) []Finding {
		return concentration(in, in.Discounts, "discounts given", "Discounts by one person", "/admin/history")
	},
}

// paymentRetraction reads payment_voids (migration 0067). Before that table
// existed this was unanswerable: a payment could be recorded and removed while
// the bill was still open and leave no row anywhere, and audit_log has been
// DefaultOff since 0051. It is the clearest example of something the person at
// the counter cannot see.
var paymentRetraction = Detector{
	Key:     "payment_retraction",
	Label:   "Payments entered then removed",
	Perm:    "report:read",
	LinkTpl: "/admin/history",
	Fn: func(_ time.Time, in Inputs) []Finding {
		if in.Retractions.Count < RetractionWarnCount {
			return nil
		}
		sev := SeverityWarn
		if in.Retractions.Count >= RetractionBadCount {
			sev = SeverityBad
		}
		who := ""
		if in.ActiveStaff >= ConcentrationMinStaff {
			if top, ok := in.Retractions.TopActor(); ok {
				who = fmt.Sprintf(" %s recorded %d of them.", top.Name, top.Count)
			}
		}
		baseline := float64(RetractionWarnCount)
		return []Finding{{
			SubjectKind:  SubjectTenant,
			SubjectLabel: "Payments entered then removed",
			Severity:     sev,
			Detail: fmt.Sprintf(
				"%d payments totalling %s were entered and then removed before the bill closed, "+
					"in the last %d days.%s Correcting a wrong payment method is routine; a pattern of it is "+
					"worth understanding.",
				in.Retractions.Count, audit.Money(in.Retractions.ValueCents), in.Window.Days(), who),
			MetricValue: float64(in.Retractions.Count),
			Unit:        UnitCount,
			Baseline:    &baseline,
			Facts: map[string]any{
				"retraction_count": in.Retractions.Count,
				"retraction_cents": in.Retractions.ValueCents,
			},
		}}
	},
}
