package mcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/tenant"
)

// LOOPBACK DISPATCH — the design decision this whole package rests on.
//
// A tool call is turned into an ordinary HTTP request and replayed through the
// SAME http.Handler the browser talks to. Not a shared service layer, not a
// duplicated query: the actual router.
//
// Everything then applies for free and, more importantly, STAYS applying:
//
//	auth.RequireAuth          the connection's identity is a real user
//	tenant.Middleware         the café is resolved the normal way
//	auth.RequireMember        their permission set and billing state load
//	billing.WriteGate         a write-locked café's connector cannot write
//	auth.Require(perm)        per-route permission checks
//	billing.RequireFeature    per-route plan gates
//	db.TxMiddleware           the RLS transaction, with app.tenant_id set
//	audit.Log                 writes land in the tenant's activity trail
//
// The alternative — an MCP-specific data layer — would mean every future
// permission, gate or RLS policy had to be remembered twice. This way there is
// exactly one implementation of "what may this member see", and a connector is
// definitionally a subset of it.
//
// The cost is one extra pool connection while a tool call is in flight (the
// outer request holds none, because /mcp is mounted outside TxMiddleware) and a
// little request-building. Against MaxConns=25 and one call at a time per
// connector, that is nothing.

// Connection is a resolved, live connector.
type Connection struct {
	ID         uuid.UUID
	TenantID   uuid.UUID
	TenantSlug string
	UserID     uuid.UUID
	Scopes     []string
	Label      string
}

// HasScope reports whether this connection was granted a capability.
func (c Connection) HasScope(want string) bool {
	for _, s := range c.Scopes {
		if s == want {
			return true
		}
	}
	return false
}

// TokenBytes is the length of the opaque secret. 32 bytes = 256 bits, rendered
// as 64 hex characters. Long enough that the URL it sits in is not guessable
// even at internet scale.
const TokenBytes = 32

// HashToken is the one-way transform stored in mcp_connections.token_hash.
//
// Plain sha256 with no salt and no work factor, deliberately: this is a
// high-entropy random secret we generated, not a human password. A brute-force
// against 256 bits does not happen, and a slow KDF here would only add latency
// to every single tool call.
func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// ErrNoConnection means the presented token matched nothing live.
var ErrNoConnection = errors.New("mcp: no such connection")

// Resolve turns a presented secret into a connection.
//
// Runs through the SECURITY DEFINER function from 0072/0073 because this call is
// what establishes which café the request is for — so by definition it happens
// before any tenant context exists. Knowledge of the secret IS the
// authorisation; there is nothing else to gate on.
func Resolve(ctx context.Context, pool *pgxpool.Pool, rawToken string) (Connection, error) {
	var c Connection
	err := pool.QueryRow(ctx,
		`SELECT id, tenant_id, tenant_slug, user_id, scopes, label
		 FROM mcp_resolve_connection($1)`, HashToken(rawToken),
	).Scan(&c.ID, &c.TenantID, &c.TenantSlug, &c.UserID, &c.Scopes, &c.Label)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNoConnection
	}
	return c, err
}

// touch stamps last_used_at, so an owner can spot a connector they forgot about.
//
// Best-effort and fire-and-forget: a failure to record a timestamp must never
// fail a tool call. Needs tenant context because mcp_connections is RLS-scoped
// like everything else — the DEFINER function above is only for the lookup that
// cannot have context.
func touch(ctx context.Context, pool *pgxpool.Pool, c Connection) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, c.TenantID.String()); err != nil {
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE mcp_connections SET last_used_at = now() WHERE id = $1`, c.ID); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

// dispatchTimeout bounds one replayed call. Below the router's own 60s ceiling
// and the /v1 group's 25s, so whichever fires first the connector still gets a
// coherent answer rather than a dropped connection.
const dispatchTimeout = 20 * time.Second

// Dispatcher replays tool calls through the app's own handler.
type Dispatcher struct {
	pool *pgxpool.Pool
	// app is the SAME mux the browser hits. Held as an http.Handler so this
	// package cannot reach into routing.
	app http.Handler
}

func NewDispatcher(pool *pgxpool.Pool, app http.Handler) *Dispatcher {
	return &Dispatcher{pool: pool, app: app}
}

// mintFor issues a short-lived access token for the connection's identity.
//
// Reads the user's CURRENT token_version, so a global logout or a GDPR delete
// kills every connector that user made — which is the correct behaviour and
// comes for free from doing it this way rather than inventing a parallel
// credential.
//
// sid is uuid.Nil: there is no browser session behind a connector, and claiming
// one would put a row-less session id in the audit trail. Heartbeat's UPDATE
// simply matches nothing.
func (d *Dispatcher) mintFor(ctx context.Context, userID uuid.UUID) (string, error) {
	var email, name string
	var tv int
	if err := d.pool.QueryRow(ctx, `
		SELECT COALESCE(email::text, ''), COALESCE(name, ''), COALESCE(token_version, 0)
		FROM users WHERE id = $1 AND deleted_at IS NULL
	`, userID).Scan(&email, &name, &tv); err != nil {
		return "", fmt.Errorf("mcp: connection owner is gone: %w", err)
	}
	token, _, err := auth.MintAccessToken(userID, email, name, uuid.Nil, tv)
	return token, err
}

// Call executes one tool and returns the JSON body the /v1 handler produced.
func (d *Dispatcher) Call(ctx context.Context, c Connection, t Tool, a args) (string, int, error) {
	path, err := t.Path(a)
	if err != nil {
		return "", 0, err
	}

	// Structural guard, checked at run time as well as in dispatch_test.go's
	// table walk. Belt and braces on the single most important property of this
	// package: a tool that is not the one write must not be able to mutate
	// anything, however it was registered.
	if t.Method != http.MethodGet && t.Name != writeToolName {
		return "", 0, fmt.Errorf("mcp: %q is not %s and is not the permitted write tool", t.Name, http.MethodGet)
	}

	token, err := d.mintFor(ctx, c.UserID)
	if err != nil {
		return "", 0, err
	}

	var body io.Reader
	if t.Body != nil {
		raw, err := json.Marshal(t.Body(a))
		if err != nil {
			return "", 0, err
		}
		body = bytes.NewReader(raw)
	}

	url := path
	if t.Query != nil {
		if q := t.Query(a).Encode(); q != "" {
			url += "?" + q
		}
	}

	ctx, cancel := context.WithTimeout(ctx, dispatchTimeout)
	defer cancel()

	// RESET CHI'S ROUTE CONTEXT before replaying.
	//
	// This is the one non-obvious cost of dispatching a request through the mux
	// that is already serving one. chi stores its routing state — the path it
	// has consumed so far, and the URL params it matched — in the request
	// context under RouteCtxKey. The inner request inherits that context for its
	// deadline and cancellation, and chi then finds an existing RouteContext and
	// tries to CONTINUE routing from where /mcp/c/{token} left off. Every tool
	// call 404s, and it 404s only in the loopback: the dispatcher works
	// perfectly when called directly from a test, which is exactly the sort of
	// bug that survives a unit-test suite.
	//
	// A fresh RouteContext makes the inner request route from the root, as if it
	// had arrived over the network — which is the whole illusion this package
	// depends on.
	ctx = context.WithValue(ctx, chi.RouteCtxKey, chi.NewRouteContext())

	req := httptest.NewRequest(t.Method, url, body).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set(tenant.HeaderName, c.TenantSlug)
	if t.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// Marks the call in the audit trail as coming from a connector rather than a
	// browser, so an owner reviewing activity can tell the difference.
	req.Header.Set("X-Client", "mcp/"+c.ID.String())

	rec := httptest.NewRecorder()
	d.app.ServeHTTP(rec, req)

	return rec.Body.String(), rec.Code, nil
}

// writeToolName is the single mutating tool. Referenced by both the runtime
// guard above and the test that walks the table, so the two cannot disagree
// about which tool is the exception.
const writeToolName = "accept_finding"
