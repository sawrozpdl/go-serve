package llm

// Pricing, as named constants rather than a config table.
//
// These are USD per MILLION tokens. They are checked into the repo on purpose:
// the ledger in insight_briefs.cost_micros has to mean something months later,
// and a rate read from the environment would silently rewrite history every
// time somebody changed it. When a provider's price moves, this file moves with
// a commit that says so.
//
// An unknown model costs the most expensive known rate rather than zero. A
// missing entry must overstate spend and trip the cap early, never understate
// it and let a runaway through — the failure has to be safe in the direction
// that costs nothing.
type rate struct {
	inPerMillion  float64
	outPerMillion float64
}

var rates = map[string]rate{
	"gemini-2.0-flash-lite": {inPerMillion: 0.075, outPerMillion: 0.30},
	"gemini-2.0-flash":      {inPerMillion: 0.10, outPerMillion: 0.40},
	"gemini-1.5-flash":      {inPerMillion: 0.075, outPerMillion: 0.30},
	"gemini-2.5-flash":      {inPerMillion: 0.30, outPerMillion: 2.50},
}

// fallbackRate is the most expensive known rate, used for an unrecognised model.
var fallbackRate = rate{inPerMillion: 0.30, outPerMillion: 2.50}

// CostMicros converts a token count to USD × 1e6.
//
// Integer micros rather than a float: the ledger sums thousands of tiny charges,
// and float addition of tiny numbers drifts. Rounding up means the recorded
// spend is never less than the real spend.
func CostMicros(model string, inTokens, outTokens int) int64 {
	r, ok := rates[model]
	if !ok {
		r = fallbackRate
	}
	usd := (float64(inTokens)/1e6)*r.inPerMillion + (float64(outTokens)/1e6)*r.outPerMillion
	micros := usd * 1e6
	// Ceiling: a sub-micro charge still costs something, and rounding it to zero
	// would make a large number of tiny calls look free.
	if micros > 0 && micros < 1 {
		return 1
	}
	return int64(micros + 0.5)
}

// BudgetMicros is the configured monthly ceiling in micros.
func (c *Client) BudgetMicros() int64 {
	if c == nil {
		return 0
	}
	return int64(c.cfg.MonthlyBudgetUSD * 1e6)
}
