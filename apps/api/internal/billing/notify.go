package billing

import (
	"context"

	"github.com/google/uuid"
)

// AttentionKind classifies why a tenant's billing needs a platform admin's
// attention.
type AttentionKind string

const (
	AttentionTrialEndingSoon AttentionKind = "trial_ending_soon"
	AttentionTrialExpired    AttentionKind = "trial_expired"
	AttentionPastDue         AttentionKind = "past_due" // paid sub lapsed
)

// NotifyAttention is the hook for alerting a platform admin that a tenant needs
// billing attention (trial ending, trial expired, or a paid subscription gone
// past due).
//
// It is intentionally a NO-OP for now. There is no scheduled sweep wired to
// call it, and no email/SMS transport for platform billing yet — those land
// later. Until then the super console surfaces these states directly (the
// "past due / expiring soon" KPIs and per-tenant status badges) as the
// near-term awareness mechanism. When a scheduler + transport exist, drive the
// notifications from here so there is a single place to evolve.
func NotifyAttention(_ context.Context, _ uuid.UUID, _ AttentionKind) {
	// no-op stub — see doc comment.
}
