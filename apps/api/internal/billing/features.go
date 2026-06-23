// Package billing implements subscription-plan enforcement: per-request plan
// state, the team-size seat limit, premium feature gating, and the trial /
// write-lock lifecycle. Feature KEYS are defined here in code; which plan
// includes which key is data in the plan_features table.
//
// This package deliberately imports neither appctx nor auth — the request-
// scoped State and its context accessors live here so both auth (which loads
// the state) and the api handlers (which read it) can depend on billing
// without an import cycle.
package billing

// FeatureKey is a code-defined gated capability. plan_features rows and
// tenants.feature_overrides reference these by string; the super-admin UI
// validates submitted keys against Registry before persisting.
type FeatureKey string

const (
	FeatureAdvancedAnalytics   FeatureKey = "advanced_analytics"
	FeatureEmailShiftSummaries FeatureKey = "email_shift_summaries"
	FeatureAuditLogs           FeatureKey = "audit_logs"
)

// FeatureDef describes a gated feature for the super-admin plan editor and
// the owner-facing plan page.
type FeatureDef struct {
	Key   FeatureKey `json:"key"`
	Label string     `json:"label"`
	Desc  string     `json:"desc"`
}

// Registry is the single source of truth for valid feature keys. Adding a new
// gated feature is a one-line addition here (plus a plan_features data row and
// the route/handler gate).
var Registry = []FeatureDef{
	{FeatureAdvancedAnalytics, "Advanced Analytics", "Heatmaps, sales velocity, category/table mix, and top sellers on the dashboard."},
	{FeatureEmailShiftSummaries, "Email Shift Summaries", "Email owners and managers a summary when a shift is closed."},
	{FeatureAuditLogs, "Audit Logs", "Record and view the tenant activity timeline — who changed what, when."},
}

// IsKnownFeature reports whether k is a registered feature key.
func IsKnownFeature(k string) bool {
	for _, f := range Registry {
		if string(f.Key) == k {
			return true
		}
	}
	return false
}
