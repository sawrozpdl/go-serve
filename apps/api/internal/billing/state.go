package billing

import (
	"context"
	"time"
)

// GraceDays is the nag-only window after a trial ends, before writes auto-lock.
const GraceDays = 7

// Phase labels for UX. Drives the banner the FE shows.
const (
	PhaseActive  = "active"   // no gate (comped/perpetual) or paid & current
	PhaseTrial   = "trial"    // within the trial window
	PhaseGrace   = "grace"    // trial ended, within grace — nag, writes still allowed
	PhaseExpired = "expired"  // trial ended past grace — writes locked
	PhasePastDue = "past_due" // paid sub lapsed — flag only, writes NOT locked
	PhaseLocked  = "locked"   // manual super-admin write lock
)

// FeatureOverrides is the shape of tenants.feature_overrides:
//
//	{"grant": ["advanced_analytics"], "revoke": ["email_shift_summaries"]}
//
// grant adds features beyond the plan; revoke removes plan features. Ignored
// while the tenant is in its trial window (trial = all features).
type FeatureOverrides struct {
	Grant  []string `json:"grant"`
	Revoke []string `json:"revoke"`
}

// State is the per-request billing snapshot. Loaded fresh inside the request
// transaction by auth.RequireMember (never from the 60s tenant cache, which
// must not carry plan/lock state).
type State struct {
	PlanKey        string          `json:"plan_key"`
	EffectiveLimit *int            `json:"member_limit"` // nil = unlimited
	Features       map[string]bool `json:"-"`
	TrialEndsAt    *time.Time      `json:"trial_ends_at,omitempty"`
	PaidThroughAt  *time.Time      `json:"paid_through_at,omitempty"`
	WriteLocked    bool            `json:"write_locked"`
	Phase          string          `json:"phase"`
}

// Has reports whether the tenant's effective feature set includes f.
func (s State) Has(f FeatureKey) bool { return s.Features[string(f)] }

// FeatureList returns the effective feature keys (sorted-insensitive; order is
// the Registry order) for serialization to the FE.
func (s State) FeatureList() []string {
	out := make([]string, 0, len(s.Features))
	for _, f := range Registry {
		if s.Features[string(f.Key)] {
			out = append(out, string(f.Key))
		}
	}
	return out
}

// ComputeState derives the effective plan state from raw inputs. Pure (takes
// `now` explicitly) so it is trivially unit-testable.
//
//   - Effective limit  = limitOverride ?? planLimit (nil = unlimited).
//   - Trial window      = trialEndsAt != nil && now < trialEndsAt.
//   - Features          = ALL during the trial window; otherwise the plan's
//     plan_features set, then + grant - revoke from overrides.
//   - Write lock        = manualLock OR (trial ended past the grace window).
//     The trial lock is COMPUTED, never stored, so extending the trial clears
//     it on the next request. Manual lock is independent.
//   - Paid gate         = paidThroughAt. A lapsed paid subscription surfaces as
//     PhasePastDue but is FLAG-ONLY — it never contributes to the write lock
//     (an admin locks manually if they choose). A tenant carries at most one of
//     trialEndsAt / paidThroughAt; both nil = comped / perpetual (PhaseActive).
//
//     Belt-and-suspenders: a CURRENT (future) paidThroughAt always wins over a
//     trial gate — a paying customer must never be trial-locked by a stale
//     trial_ends_at that a write path forgot to clear. The write sites
//     (RecordPayment / SetSubscription / ChangePlan) enforce the "one gate"
//     invariant, and this ordering makes any row that slips through self-heal.
func ComputeState(
	now time.Time,
	planKey string,
	planLimit *int,
	limitOverride *int,
	planFeatures []string,
	overrides FeatureOverrides,
	trialEndsAt *time.Time,
	paidThroughAt *time.Time,
	manualLock bool,
) State {
	st := State{PlanKey: planKey, TrialEndsAt: trialEndsAt, PaidThroughAt: paidThroughAt}

	// Effective seat limit.
	if limitOverride != nil {
		st.EffectiveLimit = limitOverride
	} else {
		st.EffectiveLimit = planLimit
	}

	inTrial := trialEndsAt != nil && now.Before(*trialEndsAt)
	// A paid-through date that hasn't lapsed = an active, paying customer.
	paidCurrent := paidThroughAt != nil && now.Before(*paidThroughAt)

	// Effective feature set. The blanket "all features" grant is for genuine
	// trials only; a paying customer (even one with a leftover trial date) gets
	// their plan's features, not the trial's.
	st.Features = map[string]bool{}
	if inTrial && !paidCurrent {
		// Trial grants everything EXCEPT default-off features (e.g. audit logs),
		// which stay opt-in even during a trial. Overrides are still honored so a
		// super admin can grant a default-off feature to a trialing tenant.
		for _, f := range Registry {
			if f.DefaultOff {
				continue
			}
			st.Features[string(f.Key)] = true
		}
		for _, k := range overrides.Grant {
			st.Features[k] = true
		}
		for _, k := range overrides.Revoke {
			delete(st.Features, k)
		}
	} else {
		for _, k := range planFeatures {
			st.Features[k] = true
		}
		for _, k := range overrides.Grant {
			st.Features[k] = true
		}
		for _, k := range overrides.Revoke {
			delete(st.Features, k)
		}
	}

	// Phase + computed trial-expiry lock. The TRIAL gate auto-locks past grace
	// (the trial's job is to force a decision); the PAID gate is flag-only and
	// never contributes to the lock. A tenant carries at most one gate.
	trialExpired := false
	switch {
	case paidCurrent:
		// Live paid coverage beats everything but a manual lock — a paying
		// customer is active even if a stale trial_ends_at lingers.
		st.Phase = PhaseActive
	case inTrial:
		st.Phase = PhaseTrial
	case trialEndsAt != nil:
		// Trial gate set, not currently in it, and no live paid coverage.
		if now.Before(trialEndsAt.Add(GraceDays * 24 * time.Hour)) {
			st.Phase = PhaseGrace
		} else {
			st.Phase = PhaseExpired
			trialExpired = true
		}
	case paidThroughAt != nil:
		// Had paid coverage, now lapsed, no trial gate → flag-only past due.
		st.Phase = PhasePastDue // flag only — writes stay open
	default:
		st.Phase = PhaseActive // comped / perpetual
	}

	// Manual lock wins for both the flag and the phase label.
	st.WriteLocked = manualLock || trialExpired
	if manualLock {
		st.Phase = PhaseLocked
	}
	return st
}

// --- request-scoped context accessors -----------------------------------
// Kept here (not in appctx) so billing has no appctx dependency. auth sets the
// state via WithState; billing middleware and api handlers read it.

type ctxKey int

const stateKey ctxKey = iota

// WithState stashes the per-request billing snapshot on the context.
func WithState(ctx context.Context, s State) context.Context {
	return context.WithValue(ctx, stateKey, s)
}

// StateFromContext returns the billing snapshot if RequireMember loaded one.
func StateFromContext(ctx context.Context) (State, bool) {
	s, ok := ctx.Value(stateKey).(State)
	return s, ok
}
