package mcp

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// THE most important test in this package.
//
// "Read-only, apart from accepting a finding" is a claim about a table, so it is
// checked against the table. Somebody adding a second write tool has to delete a
// test whose name and comment explain exactly why they should not.
func TestTools_ExactlyOneToolMutatesAnything(t *testing.T) {
	var writes []string
	for _, tool := range Tools {
		if tool.Method != http.MethodGet {
			writes = append(writes, tool.Name+" ("+tool.Method+")")
		}
	}
	if len(writes) != 1 {
		t.Fatalf("found %d non-GET tools: %v\n\n"+
			"This connector is read-only apart from accepting a finding, which is inert: it "+
			"can only set a review date on a row the café was already going to be shown. "+
			"Any other write would hand a third-party model provider the ability to change "+
			"this café's money. If you are adding one deliberately, that needs a product "+
			"decision, not a test edit.", len(writes), writes)
	}
	if !strings.HasPrefix(writes[0], writeToolName) {
		t.Errorf("the one write is %q, expected %q — dispatch.go's runtime guard "+
			"names the same constant, so the two must agree", writes[0], writeToolName)
	}
}

// The single write must go through the app's own accept handler, whose UPDATE
// can only touch an EXISTING open finding for this tenant. That is where the
// safety lives; this asserts the tool actually points at it.
func TestTools_TheWriteTargetsTheAcceptHandler(t *testing.T) {
	tool, ok := ByName(writeToolName)
	if !ok {
		t.Fatalf("%s is missing", writeToolName)
	}
	path, err := tool.Path(args{"finding_id": "11111111-1111-1111-1111-111111111111"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(path, "/v1/insights/") || !strings.HasSuffix(path, "/accept") {
		t.Errorf("write path = %q, want the /v1 accept route", path)
	}
	if tool.Scope != ScopeWriteFollowUp {
		t.Errorf("the write must need its own scope, got %q", tool.Scope)
	}
}

// A write whose handler returns 204 must have something to say, or the model
// cannot tell success from silence.
func TestTools_WritesExplainTheirSuccess(t *testing.T) {
	for _, tool := range Tools {
		if tool.Method == http.MethodGet {
			continue
		}
		if tool.SuccessNote == "" {
			t.Errorf("%s writes but has no SuccessNote — its handler returns 204, "+
				"so the model would receive empty content and could not tell it worked", tool.Name)
		}
	}
}

func TestTools_EveryToolIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, tool := range Tools {
		if tool.Name == "" {
			t.Error("a tool has no name")
			continue
		}
		if seen[tool.Name] {
			t.Errorf("duplicate tool %q", tool.Name)
		}
		seen[tool.Name] = true

		if tool.Desc == "" {
			t.Errorf("%s: no description — the model chooses from these", tool.Name)
		}
		if tool.Scope == "" {
			t.Errorf("%s: no scope, so no connection could be narrowed away from it", tool.Name)
		}
		if tool.Path == nil {
			t.Errorf("%s: no path", tool.Name)
		}
		// Every schema must be valid JSON Schema-ish: it is sent to the model
		// verbatim, and a malformed one breaks the whole tools/list response
		// rather than just that tool.
		var parsed map[string]any
		if err := json.Unmarshal([]byte(tool.Schema), &parsed); err != nil {
			t.Errorf("%s: schema is not valid JSON: %v", tool.Name, err)
		}
		if parsed["type"] != "object" {
			t.Errorf("%s: schema type = %v, want object", tool.Name, parsed["type"])
		}
	}
}

// Every tool must resolve to a /v1 path. A tool pointing at /public or /super
// would bypass the tenant scoping this whole design depends on.
func TestTools_AllPathsStayInsideV1(t *testing.T) {
	for _, tool := range Tools {
		path, err := tool.Path(args{
			"item_id":    "11111111-1111-1111-1111-111111111111",
			"finding_id": "11111111-1111-1111-1111-111111111111",
		})
		if err != nil {
			t.Errorf("%s: %v", tool.Name, err)
			continue
		}
		if !strings.HasPrefix(path, "/v1/") {
			t.Errorf("%s resolves to %q — every tool must go through /v1, or it "+
				"skips RequireMember and the RLS transaction", tool.Name, path)
		}
	}
}

// A required argument that is missing must produce a readable error the MODEL can
// act on, not a request to a malformed path.
func TestTools_RequiredArgsAreEnforced(t *testing.T) {
	for _, name := range []string{"item_detail", writeToolName} {
		tool, _ := ByName(name)
		if _, err := tool.Path(args{}); err == nil {
			t.Errorf("%s accepted a missing id", name)
		} else if !strings.Contains(err.Error(), "required") {
			t.Errorf("%s error should tell the model what to do: %q", name, err)
		}
	}
}

// --- scope gating ---------------------------------------------------------

// A tool the connection cannot call is not advertised at all. A model cannot be
// tempted by a capability it never saw, and an assistant retrying a tool it will
// always be refused burns the user's turns.
func TestDescriptors_HidesToolsOutsideTheGrantedScopes(t *testing.T) {
	sales := Descriptors([]string{ScopeReadSales})
	names := map[string]bool{}
	for _, d := range sales {
		names[d.Name] = true
	}
	if !names["cafe_overview"] {
		t.Error("a sales-scoped connection must see cafe_overview")
	}
	if names["cash_and_accounts"] {
		t.Error("finance must not be advertised without the finance scope — that read " +
			"sends the café's cash position to a third party")
	}
	if names[writeToolName] {
		t.Error("the write must not be advertised without its own scope")
	}
}

func TestDescriptors_FinanceIsNeverImplied(t *testing.T) {
	// Every combination that does NOT include read_finance must hide it.
	for _, scopes := range [][]string{
		{ScopeReadSales},
		{ScopeReadSales, ScopeReadInventory},
		{ScopeReadSales, ScopeWriteFollowUp},
		{ScopeReadSales, ScopeReadInventory, ScopeWriteFollowUp},
	} {
		for _, d := range Descriptors(scopes) {
			if d.Name == "cash_and_accounts" {
				t.Fatalf("finance leaked into scopes %v", scopes)
			}
		}
	}
	// And granting it works.
	found := false
	for _, d := range Descriptors([]string{ScopeReadSales, ScopeReadFinance}) {
		if d.Name == "cash_and_accounts" {
			found = true
		}
	}
	if !found {
		t.Error("granting read_finance must actually expose it")
	}
}

func TestDescriptors_EmptyScopesAdvertiseNothing(t *testing.T) {
	if got := Descriptors(nil); len(got) != 0 {
		t.Errorf("a connection with no scopes saw %d tools", len(got))
	}
}

// --- the shared range vocabulary -----------------------------------------

// The window vocabulary is resolveRangeFull's, verbatim. Reusing it is what
// stops the same question returning different numbers here and on the dashboard.
func TestRangeQuery_ReusesTheProductsOwnVocabulary(t *testing.T) {
	q := rangeQuery(args{})
	if q.Get("range") != "30d" {
		t.Errorf("default range = %q, want 30d", q.Get("range"))
	}

	q = rangeQuery(args{"range": "mtd"})
	if q.Get("range") != "mtd" {
		t.Errorf("range = %q", q.Get("range"))
	}
	// from/to are only meaningful with custom, and passing them otherwise would
	// be silently ignored by the report handler — so they are not sent.
	if q.Get("from") != "" {
		t.Error("from must not be sent unless range=custom")
	}

	q = rangeQuery(args{"range": "custom", "from": "2026-07-01", "to": "2026-07-31"})
	if q.Get("from") != "2026-07-01" || q.Get("to") != "2026-07-31" {
		t.Errorf("custom range dropped its dates: %v", q)
	}
}

func TestArgs_ClampAndCoerce(t *testing.T) {
	// A model that sends a string where a number belongs is common; coercing it
	// is kinder than refusing, and clamping stops it asking for 10,000 rows.
	sales, _ := ByName("sales_summary")

	q := sales.Query(args{"limit": "5"})
	if q.Get("limit") != "5" {
		t.Errorf("string limit not coerced: %q", q.Get("limit"))
	}
	// float64 is what JSON decoding actually produces, so the clamp is asserted
	// against the type a real model call arrives as.
	q = sales.Query(args{"limit": float64(100000)})
	if q.Get("limit") != "200" {
		t.Errorf("limit not clamped: %q", q.Get("limit"))
	}
	q = sales.Query(args{"limit": float64(0)})
	if q.Get("limit") != "1" {
		t.Errorf("limit not floored: %q", q.Get("limit"))
	}
	q = sales.Query(args{})
	if q.Get("limit") != "20" {
		t.Errorf("default limit = %q, want 20", q.Get("limit"))
	}
}

func TestTruncate_BoundsTheNote(t *testing.T) {
	// The note reaches us from somebody else's assistant. It is capped here AND
	// again in the handler, and excluded from every model prompt.
	long := strings.Repeat("x", 500)
	tool, _ := ByName(writeToolName)
	body := tool.Body(args{"note": long}).(map[string]any)
	if got := len(body["note"].(string)); got != 280 {
		t.Errorf("note length = %d, want 280", got)
	}
}

func TestWriteTool_ClampsTheFollowUpWindow(t *testing.T) {
	tool, _ := ByName(writeToolName)
	// The tool passes the raw value; the /v1 handler clamps it to 1-90. What
	// matters here is that an unset value becomes a sane default rather than 0,
	// which the handler would read as "use the default" anyway — belt and braces.
	body := tool.Body(args{}).(map[string]any)
	if body["follow_up_days"].(int) != 14 {
		t.Errorf("default follow-up = %v, want 14", body["follow_up_days"])
	}
}

// --- hashing --------------------------------------------------------------

func TestHashToken_IsStableAndOneWay(t *testing.T) {
	a, b := HashToken("secret"), HashToken("secret")
	if a != b {
		t.Error("the same secret must hash the same, or no connector would ever resolve")
	}
	if a == HashToken("secret2") {
		t.Error("different secrets must not collide")
	}
	if strings.Contains(a, "secret") {
		t.Error("the hash must not contain the secret")
	}
	if len(a) != 64 {
		t.Errorf("hash length = %d, want 64 hex chars", len(a))
	}
}

func TestConnection_HasScope(t *testing.T) {
	c := Connection{Scopes: []string{ScopeReadSales, ScopeReadInventory}}
	if !c.HasScope(ScopeReadSales) {
		t.Error("granted scope not recognised")
	}
	if c.HasScope(ScopeReadFinance) {
		t.Error("ungranted scope must not be recognised")
	}
	if (Connection{}).HasScope(ScopeReadSales) {
		t.Error("a connection with no scopes holds none")
	}
}
