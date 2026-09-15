// Full-stack MCP integration test.
//
// This lives here rather than beside the handlers because it needs the WHOLE
// router: internal/api cannot import internal/httpx (that is the import cycle
// the loopback dispatcher is built around), so the only place the real mux and
// the real database meet is this package.
//
// And it has to be the real mux. The entire claim of internal/mcp is that a tool
// call is replayed through the same handler a browser hits, so RequireMember,
// the plan gate, per-route permissions and the RLS transaction all keep applying
// without a second implementation. A unit test of the dispatcher would prove
// none of that.
package test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/config"
	"github.com/pewssh/cafe-mgmt/api/internal/httpx"
	"github.com/pewssh/cafe-mgmt/api/internal/mcp"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

const testSigningSecret = "mcp-integration-test-secret-at-least-32-bytes"

// realRouter builds the production router over the app-role pool.
func realRouter(t *testing.T, appPool *pgxpool.Pool) http.Handler {
	t.Helper()
	auth.SetTokenConfig(testSigningSecret, 10*time.Minute, time.Hour)
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := config.Config{
		Env:           "dev",
		RootDomain:    "localhost",
		PublicAPIURL:  "https://api.test",
		SessionSecret: testSigningSecret,
	}
	// Generous limits: these tests fire many calls from one "IP".
	cfg.RateLimit.GlobalPerMin = 100000
	cfg.RateLimit.MCPPerMin = 100000

	store, err := storage.NewLocal("/tmp/mcp-test-uploads", "/uploads")
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	return httpx.NewRouter(cfg, logger, appPool, realtime.New(logger), store, nil, nil, nil)
}

// mcpCafe seeds a café with the connector feature, an owner holding *:*, and a
// live connection. Returns the raw secret — which exists only here, because the
// database keeps a hash.
func mcpCafe(t *testing.T, adm *pgxpool.Pool, scopes ...string) (tenantID, userID uuid.UUID, slug, secret string) {
	t.Helper()
	ctx := context.Background()
	sfx := uuid.NewString()[:8]
	slug = "mcp-" + sfx

	if err := adm.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, vat_mode, status, feature_overrides)
		VALUES ($1, $2, 'exclusive', 'active', '{"grant":["mcp_connect"]}'::jsonb)
		RETURNING id`, slug, "MCP Cafe "+sfx).Scan(&tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() { _, _ = adm.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1`, tenantID) })

	if err := adm.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, 'MCP Owner') RETURNING id`,
		"mcp-owner-"+sfx+"@test.local").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = adm.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })

	if _, err := adm.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1,$2,'active')`,
		tenantID, userID); err != nil {
		t.Fatalf("seed member: %v", err)
	}
	// The owner role must hold *:* IN THE DATABASE — the connector borrows this
	// member's real grant set, so a role row with no permissions would make
	// every tool 403 for reasons unrelated to what is under test.
	var roleID uuid.UUID
	if err := adm.QueryRow(ctx, `
		INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1,'owner','Owner',true)
		ON CONFLICT (tenant_id, key) DO UPDATE SET name = roles.name RETURNING id`,
		tenantID).Scan(&roleID); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	if _, err := adm.Exec(ctx,
		`INSERT INTO role_permissions (role_id, permission) VALUES ($1,'*:*')
		 ON CONFLICT DO NOTHING`, roleID); err != nil {
		t.Fatalf("grant role: %v", err)
	}
	if _, err := adm.Exec(ctx,
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`,
		tenantID, userID, roleID); err != nil {
		t.Fatalf("assign role: %v", err)
	}

	if len(scopes) == 0 {
		scopes = []string{mcp.ScopeReadSales}
	}
	secret = uuid.NewString() + uuid.NewString()
	if _, err := adm.Exec(ctx, `
		INSERT INTO mcp_connections (tenant_id, label, token_hash, user_id, scopes, expires_at)
		VALUES ($1, 'Test connector', $2, $3, $4, now() + interval '1 day')`,
		tenantID, mcp.HashToken(secret), userID, scopes); err != nil {
		t.Fatalf("seed connection: %v", err)
	}
	return tenantID, userID, slug, secret
}

// rpcCall posts one JSON-RPC message and returns the HTTP status and the parsed
// envelope.
func rpcCall(t *testing.T, app http.Handler, secret, method string, params any) (int, map[string]any) {
	t.Helper()
	msg := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method}
	if params != nil {
		msg["params"] = params
	}
	raw, _ := json.Marshal(msg)
	req := httptest.NewRequest(http.MethodPost, "/mcp/c/"+secret, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)

	var out map[string]any
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
	}
	return rec.Code, out
}

// tool runs tools/call, returning the text content and whether the TOOL (not the
// protocol) reported failure.
func tool(t *testing.T, app http.Handler, secret, name string, arguments map[string]any) (string, bool) {
	t.Helper()
	code, resp := rpcCall(t, app, secret, "tools/call", map[string]any{
		"name": name, "arguments": arguments,
	})
	if code != http.StatusOK {
		t.Fatalf("tools/call HTTP %d: %v", code, resp)
	}
	if e, bad := resp["error"]; bad {
		t.Fatalf("got a PROTOCOL error where a tool result was expected — a bad "+
			"argument should be isError so the model can retry: %v", e)
	}
	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", resp)
	}
	isErr, _ := result["isError"].(bool)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		return "", isErr
	}
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	return text, isErr
}

func TestMCP_HandshakeAdvertisesToolsAndTheMoneyUnit(t *testing.T) {
	app := realRouter(t, dbPool(t))
	adm := adminPool(t)
	_, _, _, secret := mcpCafe(t, adm)

	code, resp := rpcCall(t, app, secret, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"clientInfo":      map[string]any{"name": "test", "version": "1"},
	})
	if code != http.StatusOK {
		t.Fatalf("initialize HTTP %d: %v", code, resp)
	}
	result := resp["result"].(map[string]any)
	if result["protocolVersion"] == "" {
		t.Error("no protocol version advertised")
	}
	// The instructions are the only lever over how somebody else's model talks
	// about these numbers. Losing the money unit would make every figure 100x
	// wrong, silently.
	instr, _ := result["instructions"].(string)
	if !bytes.Contains([]byte(instr), []byte("paisa")) {
		t.Error("instructions must state the money unit")
	}

	code, resp = rpcCall(t, app, secret, "tools/list", nil)
	if code != http.StatusOK {
		t.Fatalf("tools/list HTTP %d", code)
	}
	tools := resp["result"].(map[string]any)["tools"].([]any)
	if len(tools) == 0 {
		t.Fatal("no tools advertised")
	}
	for _, tl := range tools {
		if tl.(map[string]any)["name"] == "cash_and_accounts" {
			t.Error("finance advertised to a sales-only connection")
		}
	}
}

// THE loopback assertion: the tool's text is what the real /v1 handler produced,
// for the right café.
func TestMCP_ToolCallReachesTheRealHandlerAndTheRightCafe(t *testing.T) {
	app := realRouter(t, dbPool(t))
	adm := adminPool(t)
	tenantID, _, _, secret := mcpCafe(t, adm)
	ctx := context.Background()

	var catID uuid.UUID
	if err := adm.QueryRow(ctx,
		`INSERT INTO menu_categories (tenant_id, name) VALUES ($1,'MCPCat') RETURNING id`,
		tenantID).Scan(&catID); err != nil {
		t.Fatal(err)
	}
	if _, err := adm.Exec(ctx,
		`INSERT INTO menu_items (tenant_id, category_id, name, price_cents)
		 VALUES ($1,$2,'MCPUniqueFlatWhite',25000)`, tenantID, catID); err != nil {
		t.Fatal(err)
	}

	text, isErr := tool(t, app, secret, "menu_list", nil)
	if isErr {
		t.Fatalf("menu_list errored: %s", text)
	}
	if !bytes.Contains([]byte(text), []byte("MCPUniqueFlatWhite")) {
		t.Fatalf("the tool did not return this café's menu: %s", text)
	}

	// A second café's data must be invisible — the property RLS guarantees,
	// asserted specifically through the connector path.
	otherID, _, _, _ := mcpCafe(t, adm)
	var otherCat uuid.UUID
	_ = adm.QueryRow(ctx,
		`INSERT INTO menu_categories (tenant_id, name) VALUES ($1,'Secret') RETURNING id`,
		otherID).Scan(&otherCat)
	_, _ = adm.Exec(ctx,
		`INSERT INTO menu_items (tenant_id, category_id, name, price_cents)
		 VALUES ($1,$2,'OtherCafeSecretItem',999)`, otherID, otherCat)

	text, _ = tool(t, app, secret, "menu_list", nil)
	if bytes.Contains([]byte(text), []byte("OtherCafeSecretItem")) {
		t.Fatal("another café's menu leaked through the connector")
	}
}

// Scope enforcement at CALL time, not merely in the advertised list: a model that
// remembers a tool from a different connection must still be refused.
func TestMCP_UnscopedToolIsRefused(t *testing.T) {
	app := realRouter(t, dbPool(t))
	_, _, _, secret := mcpCafe(t, adminPool(t), mcp.ScopeReadSales)

	text, isErr := tool(t, app, secret, "cash_and_accounts", nil)
	if !isErr {
		t.Fatalf("finance must be refused without the scope, got: %s", text)
	}
	if !bytes.Contains([]byte(text), []byte("read_finance")) {
		t.Errorf("the refusal should name the missing permission: %s", text)
	}
}

// The single write, end to end, both ways.
func TestMCP_TheOneWrite(t *testing.T) {
	app := realRouter(t, dbPool(t))
	adm := adminPool(t)
	ctx := context.Background()

	seedFindingRow := func(tenantID uuid.UUID) uuid.UUID {
		var id uuid.UUID
		if err := adm.QueryRow(ctx, `
			INSERT INTO insight_findings
			  (tenant_id, detector_key, subject_kind, subject_key, subject_label,
			   severity, state, first_seen_on, last_seen_on)
			VALUES ($1,'void_rate','tenant','','Voided sales','bad','new',
			        CURRENT_DATE, CURRENT_DATE)
			RETURNING id`, tenantID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := adm.Exec(ctx, `
			INSERT INTO insight_observations
			  (tenant_id, finding_id, day, severity, metric_value, metric_unit, detail)
			VALUES ($1,$2,CURRENT_DATE,'bad',5000,'cents','a sentence')`,
			tenantID, id); err != nil {
			t.Fatal(err)
		}
		return id
	}

	t.Run("works with the scope", func(t *testing.T) {
		tenantID, _, _, secret := mcpCafe(t, adm, mcp.ScopeReadSales, mcp.ScopeWriteFollowUp)
		id := seedFindingRow(tenantID)

		text, isErr := tool(t, app, secret, "accept_finding", map[string]any{
			"finding_id": id.String(), "follow_up_days": 7,
			"note": "asked the kitchen about it",
		})
		if isErr {
			t.Fatalf("accept_finding failed: %s", text)
		}
		var state, note string
		if err := adm.QueryRow(ctx,
			`SELECT state, note FROM insight_findings WHERE id=$1`, id).Scan(&state, &note); err != nil {
			t.Fatal(err)
		}
		if state != "accepted" || note != "asked the kitchen about it" {
			t.Errorf("state=%q note=%q", state, note)
		}
	})

	t.Run("refused without the scope", func(t *testing.T) {
		tenantID, _, _, secret := mcpCafe(t, adm, mcp.ScopeReadSales)
		id := seedFindingRow(tenantID)

		if _, isErr := tool(t, app, secret, "accept_finding", map[string]any{
			"finding_id": id.String(),
		}); !isErr {
			t.Fatal("the write must be refused without write_followup")
		}
		var state string
		_ = adm.QueryRow(ctx, `SELECT state FROM insight_findings WHERE id=$1`, id).Scan(&state)
		if state != "new" {
			t.Errorf("a refused write changed the row to %q", state)
		}
	})

	// The safety is in the handler's UPDATE ... WHERE, which can only match a
	// row that already exists for this tenant in an open state. So the model
	// cannot invent a finding, and cannot reach another café's.
	t.Run("cannot invent or cross tenants", func(t *testing.T) {
		_, _, _, secret := mcpCafe(t, adm, mcp.ScopeReadSales, mcp.ScopeWriteFollowUp)

		if _, isErr := tool(t, app, secret, "accept_finding", map[string]any{
			"finding_id": uuid.NewString(),
		}); !isErr {
			t.Error("accepting a non-existent finding must fail")
		}

		otherID, _, _, _ := mcpCafe(t, adm)
		foreign := seedFindingRow(otherID)
		if _, isErr := tool(t, app, secret, "accept_finding", map[string]any{
			"finding_id": foreign.String(),
		}); !isErr {
			t.Error("accepting another café's finding must fail")
		}
		var state string
		_ = adm.QueryRow(ctx, `SELECT state FROM insight_findings WHERE id=$1`, foreign).Scan(&state)
		if state != "new" {
			t.Errorf("another café's finding changed to %q", state)
		}
	})
}

func TestMCP_AuthFailuresAreHTTPNotJSONRPC(t *testing.T) {
	app := realRouter(t, dbPool(t))
	adm := adminPool(t)

	// A 401 tells a client "this connector is invalid, stop retrying". A
	// JSON-RPC error would say "we are fine, your call was wrong".
	if code, _ := rpcCall(t, app, "deadbeef"+uuid.NewString(), "tools/list", nil); code != http.StatusUnauthorized {
		t.Errorf("unknown token got %d, want 401", code)
	}

	tenantID, _, _, secret := mcpCafe(t, adm)
	if code, _ := rpcCall(t, app, secret, "tools/list", nil); code != http.StatusOK {
		t.Fatalf("baseline failed: %d", code)
	}

	_, _ = adm.Exec(context.Background(),
		`UPDATE mcp_connections SET revoked_at = now() WHERE tenant_id=$1`, tenantID)
	if code, _ := rpcCall(t, app, secret, "tools/list", nil); code != http.StatusUnauthorized {
		t.Error("revocation must take effect on the very next request")
	}

	_, _ = adm.Exec(context.Background(), `UPDATE mcp_connections
		SET revoked_at = NULL, expires_at = now() - interval '1 second' WHERE tenant_id=$1`, tenantID)
	if code, _ := rpcCall(t, app, secret, "tools/list", nil); code != http.StatusUnauthorized {
		t.Error("an expired connection must stop working")
	}
}

// The plan gate protects the DOORWAY. A café without the feature should not have
// a working URL at all, even one that would only return 403s.
func TestMCP_FeatureGateBlocksTheEndpoint(t *testing.T) {
	app := realRouter(t, dbPool(t))
	adm := adminPool(t)
	tenantID, _, _, secret := mcpCafe(t, adm)

	_, _ = adm.Exec(context.Background(),
		`UPDATE tenants SET feature_overrides = '{}'::jsonb WHERE id=$1`, tenantID)
	if code, _ := rpcCall(t, app, secret, "tools/list", nil); code != http.StatusPaymentRequired {
		t.Errorf("without the feature the endpoint returned %d, want 402", code)
	}
}

// A GET is the legacy SSE handshake. Refusing it with a reason beats opening a
// stream this deployment severs after sixty seconds.
func TestMCP_GetIsRefusedWithAReason(t *testing.T) {
	app := realRouter(t, dbPool(t))
	_, _, _, secret := mcpCafe(t, adminPool(t))

	req := httptest.NewRequest(http.MethodGet, "/mcp/c/"+secret, nil)
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET returned %d, want 405", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("SSE")) {
		t.Errorf("the 405 should explain why: %s", rec.Body.String())
	}
}

// A notification has no id and must not be answered; some clients treat a reply
// as a protocol violation.
func TestMCP_NotificationGetsNoBody(t *testing.T) {
	app := realRouter(t, dbPool(t))
	_, _, _, secret := mcpCafe(t, adminPool(t))

	raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	req := httptest.NewRequest(http.MethodPost, "/mcp/c/"+secret, bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Errorf("notification got %d, want 202", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("a notification must get no body, got %q", rec.Body.String())
	}
}

func TestMCP_UnknownMethodIsMethodNotFound(t *testing.T) {
	app := realRouter(t, dbPool(t))
	_, _, _, secret := mcpCafe(t, adminPool(t))

	code, resp := rpcCall(t, app, secret, "resources/list", nil)
	if code != http.StatusOK {
		t.Fatalf("HTTP %d", code)
	}
	e, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected a JSON-RPC error, got %v", resp)
	}
	if int(e["code"].(float64)) != -32601 {
		t.Errorf("code = %v, want -32601", e["code"])
	}
}

// last_used_at is how an owner spots a connector they forgot about.
func TestMCP_StampsLastUsed(t *testing.T) {
	app := realRouter(t, dbPool(t))
	adm := adminPool(t)
	tenantID, _, _, secret := mcpCafe(t, adm)

	if _, isErr := tool(t, app, secret, "menu_list", nil); isErr {
		t.Fatal("menu_list failed")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var used *time.Time
		_ = adm.QueryRow(context.Background(),
			`SELECT last_used_at FROM mcp_connections WHERE tenant_id=$1`, tenantID).Scan(&used)
		if used != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Error("last_used_at was never stamped")
}
