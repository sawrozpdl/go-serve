package api

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
)

// =========================================================================
// ENGAGE — scoring, tier resolution and code minting (0065)
//
// Pure functions, no database, so the arithmetic that decides who wins money is
// unit-testable on its own.
//
// WHAT THE SCORE CHECKS DO AND DO NOT ACHIEVE
//
// The game runs in the guest's browser. Someone who reads the JS can always
// submit a plausible score with a synthetic input trace, and no amount of
// checking here changes that. What these rules DO kill is the overwhelming
// majority of real abuse: a naked `curl` posting score=99999, a replayed
// request, and a bot that finishes "instantly".
//
// The controls that actually bound the café's financial exposure live
// elsewhere and are the real defence:
//
//	* one winnable play per device per day (a partial unique index);
//	* per-campaign daily and total budget caps, checked before a guest plays;
//	* the five-minute code TTL, which makes a farmed code worthless;
//	* a cashier typing the code at the till with the bill in front of them.
//
// So: treat these as plausibility bounds, not as anti-cheat. Real anti-cheat
// would mean re-simulating three seeded games in Go — a game engine inside the
// API, with real drift risk between two implementations of the same physics.
// The input trace is stored on the session so that option stays open.
// =========================================================================

// gameRules bounds what a legitimate run of each game can produce. The client's
// own reported elapsed time is NEVER used here — the caller passes the server's
// measured wall clock, which the guest cannot forge.
type gameRules struct {
	// MaxScorePerSec is the fastest a real player can accumulate points.
	MaxScorePerSec float64
	// Burst absorbs the first moments, where a couple of points can land before
	// the rate has anything to divide into.
	Burst int
	// AbsoluteMax is a ceiling regardless of how long they played, so an
	// afternoon-long session can't legitimise an absurd score.
	AbsoluteMax int
	// MinDurationMS: below this the game was not physically played.
	MinDurationMS int
	// MaxDurationMS: beyond this the session is stale rather than a long game.
	MaxDurationMS int
	// MinEventsPerPoint ties the score to the input trace — Tea Runner needs at
	// least one tap per obstacle passed, Stack one per block. 0 disables the
	// check for games where score is not one-per-input.
	MinEventsPerPoint float64
}

// engageGameRules is the single source of truth for both scoring validation and
// the client's own difficulty tuning. If a game's scoring changes, it changes
// here and in the game module together.
var engageGameRules = map[string]gameRules{
	// Score = obstacles passed, one point each, one tap minimum to clear each.
	"tea_runner": {MaxScorePerSec: 1.5, Burst: 3, AbsoluteMax: 500, MinDurationMS: 3000, MaxDurationMS: 1800000, MinEventsPerPoint: 1},
	// Score = blocks stacked, one point each, one tap to drop each.
	"stack": {MaxScorePerSec: 2.0, Burst: 3, AbsoluteMax: 300, MinDurationMS: 3000, MaxDurationMS: 1800000, MinEventsPerPoint: 1},
	// Score = pairs matched x 10 + seconds left, so points arrive in bursts and
	// a single flip can be worth several. The event ratio is correspondingly
	// loose; the absolute max is what does the work here.
	"memory_match": {MaxScorePerSec: 20, Burst: 20, AbsoluteMax: 200, MinDurationMS: 5000, MaxDurationMS: 1800000, MinEventsPerPoint: 0.15},
}

// scoreSubmission is what the guest's browser reports, plus the one figure it
// cannot lie about.
type scoreSubmission struct {
	Game string
	Score int
	// ServerElapsedMS is now() - started_at, measured here. The client's own
	// elapsed time is stored for forensics but never used in a decision.
	ServerElapsedMS int
	EventCount      int
}

// validateScore reports whether a submission is physically plausible. The reason
// is for the audit trail and the fraud review list, never for the guest — telling
// someone exactly which bound they tripped is a free tuning guide.
func validateScore(s scoreSubmission) (ok bool, reason string) {
	rules, known := engageGameRules[s.Game]
	if !known {
		return false, "unknown game"
	}
	if s.Score < 0 {
		return false, "negative score"
	}
	if s.ServerElapsedMS < rules.MinDurationMS {
		return false, "too fast to have been played"
	}
	if s.ServerElapsedMS > rules.MaxDurationMS {
		return false, "session too old"
	}
	if s.Score > rules.AbsoluteMax {
		return false, "score above the game's ceiling"
	}
	elapsedSec := float64(s.ServerElapsedMS) / 1000
	if float64(s.Score) > elapsedSec*rules.MaxScorePerSec+float64(rules.Burst) {
		return false, "score outpaces the clock"
	}
	if rules.MinEventsPerPoint > 0 {
		if float64(s.EventCount) < float64(s.Score)*rules.MinEventsPerPoint {
			return false, "not enough inputs for that score"
		}
	}
	return true, ""
}

// scoreTier is the subset of a reward tier that tier resolution needs.
type scoreTier struct {
	ID         string
	MinScore   int
	RewardKind string
}

// resolveTier picks the HIGHEST tier the score reaches. Returns nil when the
// score clears nothing — the "so close" case, which is a normal outcome and not
// an error.
//
// Tiers need not be sorted: the ladder comes from the database ordered, but this
// must not silently depend on that.
func resolveTier(tiers []scoreTier, score int) *scoreTier {
	var best *scoreTier
	for i := range tiers {
		t := &tiers[i]
		if score >= t.MinScore && (best == nil || t.MinScore > best.MinScore) {
			best = t
		}
	}
	return best
}

// engageCodeAlphabet excludes 0/O/1/I/L/U — the characters people mishear or
// mistype when a code is read aloud across a counter, which is exactly how these
// are used. U is dropped as well so the generator cannot produce an unfortunate
// word.
const engageCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

// generateRewardCode mints a code as (display, normalised). The display form is
// grouped 4-4 because a grouped code is markedly easier to read off a phone
// screen and type without losing your place; the normalised form is what is
// stored for lookup and what normalizeRewardCode produces from anything a
// cashier types.
//
// 30^8 is ~656 billion, and codes live for minutes, so collisions are a
// non-issue — but the unique index on (tenant_id, code_norm) is still there and
// the caller retries on conflict rather than trusting the odds.
func generateRewardCode() (display, norm string, err error) {
	var b strings.Builder
	max := big.NewInt(int64(len(engageCodeAlphabet)))
	for i := 0; i < 8; i++ {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", "", fmt.Errorf("reward code entropy: %w", err)
		}
		b.WriteByte(engageCodeAlphabet[n.Int64()])
	}
	norm = b.String()
	return norm[:4] + "-" + norm[4:], norm, nil
}
