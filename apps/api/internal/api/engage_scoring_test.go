package api

import (
	"strings"
	"testing"
)

// =========================================================================
// Pure scoring logic — no database, so these run everywhere and fast.
// =========================================================================

func TestValidateScore_AcceptsAPlausibleRun(t *testing.T) {
	// 30 obstacles in 30 seconds: brisk but well inside 1.5/sec, and one tap per
	// obstacle.
	ok, reason := validateScore(scoreSubmission{
		Game: "tea_runner", Score: 30, ServerElapsedMS: 30000, EventCount: 45,
	})
	if !ok {
		t.Fatalf("a normal run was rejected: %s", reason)
	}
}

func TestValidateScore_RejectsTheObviousForgeries(t *testing.T) {
	cases := []struct {
		name string
		sub  scoreSubmission
		want string
	}{
		{
			// The single most likely attack: POST a huge number and see what happens.
			name: "naked curl with a huge score",
			sub:  scoreSubmission{Game: "tea_runner", Score: 99999, ServerElapsedMS: 30000, EventCount: 99999},
			want: "ceiling",
		},
		{
			name: "score outpacing the clock",
			sub:  scoreSubmission{Game: "tea_runner", Score: 200, ServerElapsedMS: 30000, EventCount: 200},
			want: "outpaces",
		},
		{
			name: "finished instantly",
			sub:  scoreSubmission{Game: "tea_runner", Score: 2, ServerElapsedMS: 500, EventCount: 2},
			want: "too fast",
		},
		{
			// A trace that doesn't have enough inputs to have produced the score.
			name: "score without the taps to earn it",
			sub:  scoreSubmission{Game: "tea_runner", Score: 40, ServerElapsedMS: 60000, EventCount: 3},
			want: "not enough inputs",
		},
		{
			name: "negative score",
			sub:  scoreSubmission{Game: "stack", Score: -5, ServerElapsedMS: 30000, EventCount: 0},
			want: "negative",
		},
		{
			name: "stale session",
			sub:  scoreSubmission{Game: "stack", Score: 5, ServerElapsedMS: 3600000, EventCount: 5},
			want: "too old",
		},
		{
			name: "unknown game",
			sub:  scoreSubmission{Game: "chess", Score: 5, ServerElapsedMS: 30000, EventCount: 5},
			want: "unknown game",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, reason := validateScore(tc.sub)
			if ok {
				t.Fatalf("accepted %+v", tc.sub)
			}
			if !strings.Contains(reason, tc.want) {
				t.Fatalf("reason = %q, want it to mention %q", reason, tc.want)
			}
		})
	}
}

// TestValidateScore_MemoryMatchScoresInBursts guards against tuning the event
// ratio for the tap games and accidentally making Memory Match unplayable: its
// points arrive several at a time, so one flip can legitimately be worth ten.
func TestValidateScore_MemoryMatchScoresInBursts(t *testing.T) {
	ok, reason := validateScore(scoreSubmission{
		Game: "memory_match", Score: 110, ServerElapsedMS: 20000, EventCount: 20,
	})
	if !ok {
		t.Fatalf("a legitimate memory match clear was rejected: %s", reason)
	}
}

func TestValidateScore_EveryGameHasRules(t *testing.T) {
	// A game the router can route to but scoring doesn't know about would be
	// unwinnable in a way nobody would notice until a guest complained.
	for game := range engageGames {
		if _, ok := engageGameRules[game]; !ok {
			t.Errorf("game %q has no scoring rules", game)
		}
	}
}

// =========================================================================
// Tier resolution
// =========================================================================

func TestResolveTier(t *testing.T) {
	ladder := []scoreTier{
		{ID: "low", MinScore: 10, RewardKind: "percent"},
		{ID: "mid", MinScore: 25, RewardKind: "free_item"},
		{ID: "high", MinScore: 50, RewardKind: "flat"},
	}
	cases := []struct {
		score int
		want  string
	}{
		{0, ""},
		{9, ""},
		{10, "low"},  // exactly at a threshold wins it
		{24, "low"},
		{25, "mid"},
		{49, "mid"},
		{50, "high"},
		{999, "high"}, // a score above everything wins the top tier, not nothing
	}
	for _, tc := range cases {
		got := resolveTier(ladder, tc.score)
		switch {
		case tc.want == "" && got != nil:
			t.Errorf("score %d won %q, want nothing", tc.score, got.ID)
		case tc.want != "" && got == nil:
			t.Errorf("score %d won nothing, want %q", tc.score, tc.want)
		case tc.want != "" && got.ID != tc.want:
			t.Errorf("score %d won %q, want %q", tc.score, got.ID, tc.want)
		}
	}
}

// TestResolveTier_DoesNotDependOnOrdering: the ladder arrives ordered from the
// database, and this must not quietly rely on that.
func TestResolveTier_DoesNotDependOnOrdering(t *testing.T) {
	shuffled := []scoreTier{
		{ID: "high", MinScore: 50},
		{ID: "low", MinScore: 10},
		{ID: "mid", MinScore: 25},
	}
	if got := resolveTier(shuffled, 30); got == nil || got.ID != "mid" {
		t.Fatalf("got %v, want mid", got)
	}
}

func TestResolveTier_EmptyLadder(t *testing.T) {
	if got := resolveTier(nil, 1000); got != nil {
		t.Fatalf("an empty ladder returned %v, want nil", got)
	}
}

// =========================================================================
// Code minting
// =========================================================================

func TestGenerateRewardCode_ShapeAndAlphabet(t *testing.T) {
	for i := 0; i < 200; i++ {
		display, norm, err := generateRewardCode()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if len(norm) != 8 {
			t.Fatalf("normalised code %q is %d chars, want 8", norm, len(norm))
		}
		if display != norm[:4]+"-"+norm[4:] {
			t.Fatalf("display %q does not group %q as 4-4", display, norm)
		}
		// The whole point of the alphabet: no character anyone mishears or
		// mistypes when the code is read aloud across a counter.
		for _, r := range norm {
			if !strings.ContainsRune(engageCodeAlphabet, r) {
				t.Fatalf("code %q contains %q, which is not in the alphabet", norm, r)
			}
			if strings.ContainsRune("01OILU", r) {
				t.Fatalf("code %q contains the ambiguous character %q", norm, r)
			}
		}
		// And what the cashier types has to normalise back to what we stored.
		if got := normalizeRewardCode(display); got != norm {
			t.Fatalf("normalising the display form gave %q, want %q", got, norm)
		}
	}
}

func TestGenerateRewardCode_IsNotObviouslyRepeating(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		_, norm, err := generateRewardCode()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if seen[norm] {
			t.Fatalf("generated %q twice in 500 draws — the source is not random", norm)
		}
		seen[norm] = true
	}
}

// =========================================================================
// Normalisation — what a cashier types has to find the row
// =========================================================================

func TestNormalizeRewardCode(t *testing.T) {
	cases := []struct{ in, want string }{
		{"TEA-7K2M", "TEA7K2M"},
		{"tea-7k2m", "TEA7K2M"},
		{"  tea 7k2m  ", "TEA7K2M"},
		{"TEA—7K2M", "TEA7K2M"}, // an em dash from a copy-paste
		{"", ""},
		{"---", ""},
	}
	for _, tc := range cases {
		if got := normalizeRewardCode(tc.in); got != tc.want {
			t.Errorf("normalizeRewardCode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
