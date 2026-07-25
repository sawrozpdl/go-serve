package main

// The worlds the generator can build. Each blueprint is a deliberate test
// scenario, not just "more data" — between them they cover every VAT mode, an
// empty cafe, a shift that is open right now, and a cafe whose books have drifted
// in the exact ways /super/accuracy-check looks for.

type memberSeed struct {
	Email string
	Name  string
	Role  string // roles.key — owner | manager | waiter | kitchen
}

type blueprint struct {
	Slug    string
	Name    string
	TZ      string
	Purpose string

	// VatMode is none | inclusive | exclusive; VatPct and ServicePct are numeric
	// strings as the tenants table stores them.
	VatMode    string
	VatPct     string
	ServicePct string

	// Days of trading to generate, most recent ending yesterday. 0 = none.
	Days int
	// Roughly how many serves per trading day (jittered per day).
	OrdersPerDay int
	// LeaveShiftOpen keeps today's shift open with live activity, so the drawer
	// tile, expected cash and the close panel all have something to show.
	LeaveShiftOpen bool
	// Messy plants the drift patterns the accuracy check exists to catch.
	Messy bool

	Members []memberSeed
	// CreditNames are the regulars who run a tab.
	CreditNames []string
	// OwnerNames get capital accounts (investments, payouts, cash custody).
	OwnerNames []string
	// StaffNames get payroll rows.
	StaffNames []string
}

func blueprints() []blueprint {
	return []blueprint{
		{
			// The flagship: what a real cafe's books look like after a quarter.
			// Big enough that reports have shape (weekday rhythm, quiet Mondays,
			// busy weekends) and that the sales-window index matters.
			Slug: "sahan", Name: "Sahan Cafe", TZ: "Asia/Kathmandu",
			Purpose: "90 days of trading · exclusive VAT 13% + 10% service · the main demo",
			VatMode: "exclusive", VatPct: "13.00", ServicePct: "10.00",
			Days:           90,
			OrdersPerDay:   22,
			LeaveShiftOpen: true,
			Members: []memberSeed{
				{"owner@sahan.test", "Sahan Owner", "owner"},
				{"manager@sahan.test", "Sahan Manager", "manager"},
				{"waiter@sahan.test", "Sahan Waiter", "waiter"},
				{"kitchen@sahan.test", "Sahan Kitchen", "kitchen"},
			},
			CreditNames: []string{"Ramesh (regular)", "Sunita (regular)", "Office next door"},
			OwnerNames:  []string{"Sahan", "Bikash"},
			StaffNames:  []string{"Gita", "Prakash", "Mina"},
		},
		{
			// Inclusive VAT is where the item-basis/net-revenue distinction bites
			// hardest: menu prices already contain the tax.
			Slug: "brews", Name: "Brews & Co", TZ: "Asia/Kathmandu",
			Purpose: "30 days · INCLUSIVE VAT 13%, no service charge",
			VatMode: "inclusive", VatPct: "13.00", ServicePct: "0",
			Days:         30,
			OrdersPerDay: 14,
			Members: []memberSeed{
				{"owner@brews.test", "Brews Owner", "owner"},
				{"waiter@brews.test", "Brews Waiter", "waiter"},
			},
			CreditNames: []string{"Cricket club"},
			OwnerNames:  []string{"Anita"},
			StaffNames:  []string{"Hari"},
		},
		{
			// No VAT at all: the simplest arithmetic, and the mode most small
			// cafes actually run. Also the easiest world to hand-check a bug in.
			Slug: "plain-cafe", Name: "Plain Tea House", TZ: "Asia/Kathmandu",
			Purpose: "14 days · no VAT, no service charge · easiest to hand-check",
			VatMode: "none", VatPct: "0", ServicePct: "0",
			Days:         14,
			OrdersPerDay: 8,
			Members: []memberSeed{
				{"owner@plain.test", "Plain Owner", "owner"},
			},
			CreditNames: []string{"Neighbour"},
			OwnerNames:  []string{"Kamala"},
		},
		{
			// Every empty state in the product: no menu, no orders, no shift.
			// Screens that only get exercised on day one of a real cafe.
			Slug: "fresh-cafe", Name: "Brand New Cafe", TZ: "Asia/Kathmandu",
			Purpose: "zero data · every empty state",
			VatMode: "none", VatPct: "0", ServicePct: "0",
			Days: 0,
			Members: []memberSeed{
				{"owner@fresh.test", "Fresh Owner", "owner"},
			},
		},
		{
			// A shift open RIGHT NOW with sales already through it, so the live
			// drawer, expected cash, the close panel and the variance hint all
			// have something real to work with without waiting for a day to pass.
			Slug: "midshift-cafe", Name: "Mid Shift Cafe", TZ: "Asia/Kathmandu",
			Purpose: "shift open now · live drawer + close panel",
			VatMode: "exclusive", VatPct: "13.00", ServicePct: "5.00",
			Days:           2,
			OrdersPerDay:   10,
			LeaveShiftOpen: true,
			Members: []memberSeed{
				{"owner@midshift.test", "Midshift Owner", "owner"},
				{"waiter@midshift.test", "Midshift Waiter", "waiter"},
			},
			CreditNames: []string{"Taxi stand"},
			OwnerNames:  []string{"Deepak"},
		},
		{
			// The unhappy path. Its books carry each drift pattern the accuracy
			// check reports, so you can see what a violation looks like in the UI
			// and confirm the check catches it — without breaking a good tenant.
			Slug: "messy-cafe", Name: "Messy Books Cafe", TZ: "Asia/Kathmandu",
			Purpose: "DELIBERATELY BROKEN · /super/accuracy-check should light up here",
			VatMode: "exclusive", VatPct: "13.00", ServicePct: "0",
			Days:         7,
			OrdersPerDay: 6,
			Messy:        true,
			Members: []memberSeed{
				{"owner@messy.test", "Messy Owner", "owner"},
			},
			CreditNames: []string{"Mystery tab"},
			OwnerNames:  []string{"Sabin"},
		},
	}
}

// menuPlan is the catalogue each trading tenant gets. Prices are paisa. Costs are
// set on most items so the profitability report has real margins, and left at
// zero on a couple so the "100% margin / missing cost" warning has something to
// flag — that banner is otherwise never seen in demo data.
type menuPlan struct {
	Category string
	Items    []itemPlan
}

type itemPlan struct {
	Name      string
	Price     int64
	Cost      int64
	AllowHalf bool
	// Weight biases how often it sells (a momo outsells a special).
	Weight int
}

func menuPlans() []menuPlan {
	return []menuPlan{
		{"Momo & Snacks", []itemPlan{
			{"Steam Momo", 25000, 9000, true, 30},
			{"Fry Momo", 28000, 10000, true, 18},
			{"Jhol Momo", 32000, 12000, true, 14},
			{"Chowmein", 22000, 7500, false, 16},
			{"Sekuwa Plate", 45000, 21000, false, 6},
		}},
		{"Hot Drinks", []itemPlan{
			{"Milk Tea", 6000, 1800, false, 40},
			{"Black Tea", 4000, 900, false, 12},
			{"Americano", 18000, 4500, false, 14},
			{"Cappuccino", 22000, 6000, false, 12},
			// No cost set: exercises the missing-cost warning on Profitability.
			{"Special Masala Tea", 9000, 0, false, 8},
		}},
		{"Cold Drinks", []itemPlan{
			{"Lassi", 12000, 4000, true, 12},
			{"Cold Coffee", 20000, 6500, false, 10},
			{"Mineral Water", 3000, 1500, false, 20},
		}},
		{"Rice & Mains", []itemPlan{
			{"Veg Thali", 33000, 13000, true, 12},
			{"Chicken Thali", 42000, 18000, true, 10},
			{"Dal Bhat", 28000, 11000, false, 8},
			// Also cost-less, in a different category.
			{"Chef's Special", 55000, 0, false, 3},
		}},
	}
}

// tablePlan — a floor with a mix of sizes, plus enough tables that the
// table-mix report has something to rank. One is retired part-way through
// seeding so the "Retired tables" row in table mix is exercised.
func tablePlan() []struct {
	Name     string
	Capacity int
} {
	return []struct {
		Name     string
		Capacity int
	}{
		{"T1", 2}, {"T2", 2}, {"T3", 4}, {"T4", 4},
		{"T5", 6}, {"T6", 4}, {"Terrace 1", 4}, {"Terrace 2", 6},
	}
}
