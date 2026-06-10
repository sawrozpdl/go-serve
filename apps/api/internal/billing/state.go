package billing

import (
	"context"
	"time"
)

// GraceDays is the nag-only window after a trial ends, before writes auto-lock.
const GraceDays = 7

// Phase labels for UX. Drives the banner the FE shows.
const (
	PhaseActive  = "active"  // no trial gate, not locked
	PhaseTrial   = "trial"   // within the trial window
	PhaseGrace   = "grace"   // trial ended, within grace — nag, writes still allowed
	PhaseExpired = "expired" // trial ended past grace — writes locked
	PhaseLocked  = "locked"  // manual super-admin write lock
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
func ComputeState(
	now time.Time,
	planKey string,
	planLimit *int,
	limitOverride *int,
	planFeatures []string,
	overrides FeatureOverrides,
	trialEndsAt *time.Time,
	manualLock bool,
) State {
	st := State{PlanKey: planKey, TrialEndsAt: trialEndsAt}

	// Effective seat limit.
	if limitOverride != nil {
		st.EffectiveLimit = limitOverride
	} else {
		st.EffectiveLimit = planLimit
	}

	inTrial := trialEndsAt != nil && now.Before(*trialEndsAt)

	// Effective feature set.
	st.Features = map[string]bool{}
	if inTrial {
		for _, f := range Registry {
			st.Features[string(f.Key)] = true
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

	// Trial-expiry lock (computed) and phase.
	trialExpired := false
	switch {
	case trialEndsAt == nil:
		st.Phase = PhaseActive
	case inTrial:
		st.Phase = PhaseTrial
	case now.Before(trialEndsAt.Add(GraceDays * 24 * time.Hour)):
		st.Phase = PhaseGrace
	default:
		st.Phase = PhaseExpired
		trialExpired = true
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
