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
type FeatureDef struct {
	Key   FeatureKey `json:"key"`
	Label string     `json:"label"`
	Desc  string     `json:"desc"`
	Group string     `json:"group"`
}

// Registry is the single source of truth for valid feature keys. Adding a new
// gated feature is a one-line addition here (plus a plan_features data row and
// the route/handler gate). The FE mirror lives in apps/web/src/lib/features.ts
// (a parity test keeps the key sets in sync).
var Registry = []FeatureDef{
	{FeatureAdvancedAnalytics, "Advanced Analytics", "Heatmaps, sales velocity, category/table mix, and top sellers on the dashboard.", GroupAnalytics},
	{FeatureProfitability, "Profitability Report", "Profit & loss by category with per-category drilldown.", GroupAnalytics},
	{FeatureOwnerFinance, "Owner Finance", "Owners, equity, investments, loans, payouts and owner-cash custody.", GroupFinance},
	{FeatureHouseTabs, "House Tabs", "Stakeholder running-ledger house tabs and their settlements.", GroupFinance},
	{FeatureStaffHR, "Staff Records", "Staff profiles, private personal documents, and the salary pay ledger.", GroupTeam},
	{FeatureStaffScheduling, "Staff Scheduling", "Roster, shift timeline, and per-staff schedules.", GroupTeam},
	{FeatureCustomRoles, "Custom Roles", "Create and edit custom permission roles beyond the built-in defaults.", GroupTeam},
	{FeatureEmailShiftSummaries, "Email Shift Summaries", "Email owners and managers a summary when a shift is closed.", GroupTeam},
	{FeatureMultiOutlet, "Multiple Outlets", "Run more than one prep station (Kitchen, Bar, …) with per-outlet printers.", GroupOperations},
	{FeatureInventory, "Inventory", "Stock levels, movements, adjustments, pack rules and low-stock alerts.", GroupOperations},
	{FeatureMenuImport, "Bulk Menu Import", "Import categories and items in one step from an AI-parsed menu.", GroupOperations},
	{FeatureThermalPrinting, "Thermal Printing", "Network/thermal printer setup for kitchen dockets and receipts.", GroupOperations},
	{FeatureAuditLogs, "Audit Logs", "Record and view the tenant activity timeline — who changed what, when.", GroupCompliance},
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
