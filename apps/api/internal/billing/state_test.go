package billing

import (
	"testing"
	"time"
)

func intp(n int) *int { return &n }

func TestComputeState(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	future := now.Add(10 * 24 * time.Hour)
	pastInGrace := now.Add(-3 * 24 * time.Hour)        // ended 3d ago, within 7d grace
	pastBeyondGrace := now.Add(-10 * 24 * time.Hour)   // ended 10d ago, past grace
	standardFeatures := []string{"email_shift_summaries"}

	t.Run("no trial gate, active", func(t *testing.T) {
		s := ComputeState(now, "enterprise", nil, nil, []string{"advanced_analytics", "email_shift_summaries"}, FeatureOverrides{}, nil, false)
		if s.Phase != PhaseActive {
			t.Fatalf("phase = %q, want active", s.Phase)
		}
		if s.WriteLocked {
			t.Fatal("should not be write-locked")
		}
		if s.EffectiveLimit != nil {
			t.Fatal("enterprise nil limit should stay unlimited")
		}
	})

	t.Run("in trial: all features, unlocked", func(t *testing.T) {
		s := ComputeState(now, "standard", intp(5), nil, standardFeatures, FeatureOverrides{}, &future, false)
		if s.Phase != PhaseTrial {
			t.Fatalf("phase = %q, want trial", s.Phase)
		}
		if !s.Has(FeatureAdvancedAnalytics) {
			t.Fatal("trial should grant advanced_analytics even on standard plan")
		}
		if s.WriteLocked {
			t.Fatal("trial should not be locked")
		}
	})

	t.Run("grace: nag only, writes allowed, plan features", func(t *testing.T) {
		s := ComputeState(now, "standard", intp(5), nil, standardFeatures, FeatureOverrides{}, &pastInGrace, false)
		if s.Phase != PhaseGrace {
			t.Fatalf("phase = %q, want grace", s.Phase)
		}
		if s.WriteLocked {
			t.Fatal("grace should not be locked")
		}
		if s.Has(FeatureAdvancedAnalytics) {
			t.Fatal("post-trial standard should NOT have advanced_analytics")
		}
	})

	t.Run("expired past grace: write locked", func(t *testing.T) {
		s := ComputeState(now, "standard", intp(5), nil, standardFeatures, FeatureOverrides{}, &pastBeyondGrace, false)
		if s.Phase != PhaseExpired {
			t.Fatalf("phase = %q, want expired", s.Phase)
		}
		if !s.WriteLocked {
			t.Fatal("expired past grace must be write-locked")
		}
	})

	t.Run("manual lock wins regardless of trial", func(t *testing.T) {
		s := ComputeState(now, "standard", intp(5), nil, standardFeatures, FeatureOverrides{}, &future, true)
		if s.Phase != PhaseLocked {
			t.Fatalf("phase = %q, want locked", s.Phase)
		}
		if !s.WriteLocked {
			t.Fatal("manual lock must write-lock")
		}
	})

	t.Run("limit override beats plan limit", func(t *testing.T) {
		s := ComputeState(now, "standard", intp(5), intp(25), standardFeatures, FeatureOverrides{}, nil, false)
		if s.EffectiveLimit == nil || *s.EffectiveLimit != 25 {
			t.Fatalf("effective limit = %v, want 25", s.EffectiveLimit)
		}
	})

	t.Run("feature overrides grant/revoke", func(t *testing.T) {
		s := ComputeState(now, "standard", intp(5), nil, standardFeatures,
			FeatureOverrides{Grant: []string{"advanced_analytics"}, Revoke: []string{"email_shift_summaries"}}, nil, false)
		if !s.Has(FeatureAdvancedAnalytics) {
			t.Fatal("grant should add advanced_analytics")
		}
		if s.Has(FeatureEmailShiftSummaries) {
			t.Fatal("revoke should remove email_shift_summaries")
		}
	})
}
