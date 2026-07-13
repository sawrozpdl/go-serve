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
	// Analytics & Reports.
	FeatureAdvancedAnalytics FeatureKey = "advanced_analytics"
	FeatureProfitability     FeatureKey = "profitability"
	// Finance.
	FeatureOwnerFinance FeatureKey = "owner_finance"
	FeatureHouseTabs    FeatureKey = "house_tabs"
	// Team & Staff.
	FeatureStaffHR             FeatureKey = "staff_hr"
	FeatureStaffScheduling     FeatureKey = "staff_scheduling"
	FeatureCustomRoles         FeatureKey = "custom_roles"
	FeatureEmailShiftSummaries FeatureKey = "email_shift_summaries"
	// Operations.
	FeatureMultiOutlet     FeatureKey = "multi_outlet"
	FeatureInventory       FeatureKey = "inventory"
	FeatureMenuImport      FeatureKey = "menu_import"
	FeatureThermalPrinting FeatureKey = "thermal_printing"
	// Compliance.
	FeatureAuditLogs FeatureKey = "audit_logs"
)

// Feature group labels — used by the super-admin editors to render the
// registry as grouped checkbox lists.
const (
	GroupAnalytics  = "Analytics & Reports"
	GroupFinance    = "Finance"
	GroupTeam       = "Team & Staff"
	GroupOperations = "Operations"
	GroupCompliance = "Compliance"
)

// FeatureDef describes a gated feature for the super-admin plan/feature editors
// and the owner-facing plan page. Group buckets features for display.
//
// DefaultOff marks a feature that is NOT included in the trial "all features"
// blanket grant and is off unless explicitly granted (plan_features or a
// per-tenant grant override). Used for opt-in capabilities like audit logs that
// a super admin turns on deliberately rather than every workspace getting them.
type FeatureDef struct {
	Key        FeatureKey `json:"key"`
	Label      string     `json:"label"`
	Desc       string     `json:"desc"`
	Group      string     `json:"group"`
	DefaultOff bool       `json:"default_off,omitempty"`
}

// Registry is the single source of truth for valid feature keys. Adding a new
// gated feature is a one-line addition here (plus a plan_features data row and
// the route/handler gate). The FE mirror lives in apps/web/src/lib/features.ts
// (a parity test keeps the key sets in sync).
var Registry = []FeatureDef{
	{Key: FeatureAdvancedAnalytics, Label: "Advanced Analytics", Desc: "Heatmaps, sales velocity, category/table mix, and top sellers on the dashboard.", Group: GroupAnalytics},
	{Key: FeatureProfitability, Label: "Profitability Report", Desc: "Profit & loss by category with per-category drilldown.", Group: GroupAnalytics},
	{Key: FeatureOwnerFinance, Label: "Owner Finance", Desc: "Owners, equity, investments, loans, payouts and owner-cash custody.", Group: GroupFinance},
	{Key: FeatureHouseTabs, Label: "Credit", Desc: "Customer credit accounts — running ledgers and their settlements.", Group: GroupFinance},
	{Key: FeatureStaffHR, Label: "Staff Records", Desc: "Staff profiles, private personal documents, and the salary pay ledger.", Group: GroupTeam},
	{Key: FeatureStaffScheduling, Label: "Staff Scheduling", Desc: "Roster, shift timeline, and per-staff schedules.", Group: GroupTeam},
	{Key: FeatureCustomRoles, Label: "Custom Roles", Desc: "Create and edit custom permission roles beyond the built-in defaults.", Group: GroupTeam},
	{Key: FeatureEmailShiftSummaries, Label: "Email Shift Summaries", Desc: "Email owners and managers a summary when a shift is closed.", Group: GroupTeam},
	{Key: FeatureMultiOutlet, Label: "Multiple Outlets", Desc: "Run more than one prep station (Kitchen, Bar, …) with per-outlet printers.", Group: GroupOperations},
	{Key: FeatureInventory, Label: "Inventory", Desc: "Stock levels, movements, adjustments, pack rules and low-stock alerts.", Group: GroupOperations},
	{Key: FeatureMenuImport, Label: "Bulk Menu Import", Desc: "Import categories and items in one step from an AI-parsed menu.", Group: GroupOperations},
	{Key: FeatureThermalPrinting, Label: "Thermal Printing", Desc: "Network/thermal printer setup for kitchen dockets and receipts.", Group: GroupOperations},
	// audit_logs is opt-in: off by default for every tenant (excluded from the
	// trial blanket grant and from all plans), enabled per-tenant by a super
	// admin via a grant override.
	{Key: FeatureAuditLogs, Label: "Audit Logs", Desc: "Record and view the tenant activity timeline — who changed what, when. Off by default; enable per tenant.", Group: GroupCompliance, DefaultOff: true},
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
