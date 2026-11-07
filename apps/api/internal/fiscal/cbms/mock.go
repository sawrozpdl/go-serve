package cbms

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// Scenario steers the Mock's answers.
type Scenario string

const (
	ScenarioOK        Scenario = "ok"        // every post succeeds (200)
	ScenarioDuplicate Scenario = "duplicate" // bills answer 101 (already exists)
	ScenarioAuth      Scenario = "auth"      // 100 bad credentials
	ScenarioInvalid   Scenario = "invalid"   // 104 invalid model
	ScenarioTimeout   Scenario = "timeout"   // transport failure
	ScenarioFlaky     Scenario = "flaky"     // first post of each document fails in transport, then 200
)

// ParseScenario accepts a scenario name; unknown names fall back to ok.
func ParseScenario(s string) Scenario {
	switch Scenario(s) {
	case ScenarioDuplicate, ScenarioAuth, ScenarioInvalid, ScenarioTimeout, ScenarioFlaky:
		return Scenario(s)
	}
	return ScenarioOK
}

// Mock is an in-process CBMS used until a café has real IRD credentials (and
// in dev and CI). It validates the totals identity the real server relies
// on, answers per Scenario, de-duplicates bills like the real server, and
// records every post so tests and the demo can inspect them.
type Mock struct {
	mu       sync.Mutex
	scenario Scenario
	// PerPAN overrides the scenario for one seller PAN, so one demo café can
	// show a failure while others sync.
	perPAN map[string]Scenario
	seen   map[string]bool // dedupe key → stored
	tries  map[string]int  // flaky: attempts per document
	posts  []Posted
}

// Posted is one recorded post (credentials stripped).
type Posted struct {
	Endpoint   Endpoint
	SellerPAN  string
	Document   map[string]any
	IsRealtime bool
	Code       int
}

// NewMock returns a Mock answering with the given scenario.
func NewMock(s Scenario) *Mock {
	return &Mock{scenario: s, perPAN: map[string]Scenario{}, seen: map[string]bool{}, tries: map[string]int{}}
}

// Name implements Client.
func (m *Mock) Name() string { return "mock" }

// SetScenario changes the default scenario.
func (m *Mock) SetScenario(s Scenario) { m.mu.Lock(); m.scenario = s; m.mu.Unlock() }

// SetScenarioFor overrides the scenario for one seller PAN.
func (m *Mock) SetScenarioFor(pan string, s Scenario) {
	m.mu.Lock()
	m.perPAN[pan] = s
	m.mu.Unlock()
}

// Posts returns a copy of everything posted so far.
func (m *Mock) Posts() []Posted {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Posted(nil), m.posts...)
}

// Post implements Client.
func (m *Mock) Post(_ context.Context, e Envelope) (Result, error) {
	var doc map[string]any
	if err := json.Unmarshal(e.Document, &doc); err != nil {
		return Result{Code: CodeInvalidModel, Raw: "104"}, nil
	}
	var sales Sales
	if err := json.Unmarshal(e.Document, &sales); err != nil || sales.Check() != nil {
		return m.record(e, doc, CodeInvalidModel), nil
	}

	m.mu.Lock()
	sc := m.scenario
	if o, ok := m.perPAN[e.Creds.SellerPAN]; ok {
		sc = o
	}
	key := dedupeKey(e.Endpoint, e.Creds.SellerPAN, doc)
	m.tries[key]++
	try := m.tries[key]
	m.mu.Unlock()

	switch sc {
	case ScenarioAuth:
		return m.record(e, doc, CodeBadCredentials), nil
	case ScenarioInvalid:
		return m.record(e, doc, CodeInvalidModel), nil
	case ScenarioTimeout:
		return Result{}, fmt.Errorf("%w: mock timeout", ErrTransport)
	case ScenarioFlaky:
		if try == 1 {
			return Result{}, fmt.Errorf("%w: mock flaky first attempt", ErrTransport)
		}
	case ScenarioDuplicate:
		if e.Endpoint == EndpointBill {
			return m.record(e, doc, CodeDuplicate), nil
		}
	}

	m.mu.Lock()
	dup := e.Endpoint == EndpointBill && m.seen[key]
	m.seen[key] = true
	m.mu.Unlock()
	if dup {
		return m.record(e, doc, CodeDuplicate), nil
	}
	return m.record(e, doc, CodeSuccess), nil
}

func (m *Mock) record(e Envelope, doc map[string]any, code int) Result {
	m.mu.Lock()
	m.posts = append(m.posts, Posted{Endpoint: e.Endpoint, SellerPAN: e.Creds.SellerPAN, Document: doc, IsRealtime: e.IsRealtime, Code: code})
	m.mu.Unlock()
	return Result{Code: code, Raw: fmt.Sprint(code)}
}

func dedupeKey(ep Endpoint, pan string, doc map[string]any) string {
	if ep == EndpointBill {
		return fmt.Sprintf("bill|%s|%v|%v", pan, doc["fiscal_year"], doc["invoice_number"])
	}
	return fmt.Sprintf("return|%s|%v|%v", pan, doc["fiscal_year"], doc["credit_note_number"])
}
