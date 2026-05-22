package realtime

import (
	"context"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/auth"
)

// Handler returns the WebSocket upgrade handler for /ws.
//
// Auth: session cookie must be present and valid. Tenant: the slug must
// be supplied via either ?tenant=<slug> query string or X-Tenant-ID
// header (browser WebSocket clients can do either via the Vite proxy).
//
// On accept, the client is auto-subscribed to ["kitchen", "tables", "orders", "finance"]
// for the tenant. We don't expose subscription control to clients today;
// the FE has only one app, the topic set is small, and the hub is
// goroutine-cheap.
func Handler(pool *pgxpool.Pool, hub *Hub, allowedOrigins []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// 1. Resolve session.
		c, err := r.Cookie(auth.CookieName)
		if err != nil || c.Value == "" {
			http.Error(w, "session required", http.StatusUnauthorized)
			return
		}
		_, userID, _, _, err := auth.LookupSession(r.Context(), pool, c.Value)
		if err != nil {
			http.Error(w, "session invalid", http.StatusUnauthorized)
			return
		}

		// 2. Resolve tenant.
		slug := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("tenant")))
		if slug == "" {
			slug = strings.ToLower(strings.TrimSpace(r.Header.Get("X-Tenant-ID")))
		}
		if slug == "" {
			http.Error(w, "tenant required (?tenant=slug)", http.StatusBadRequest)
			return
		}
		var tenantID uuid.UUID
		if err := pool.QueryRow(r.Context(), `
			SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL AND status = 'active'
		`, slug).Scan(&tenantID); err != nil {
			http.Error(w, "tenant not found", http.StatusNotFound)
			return
		}

		// 3. Verify membership (RLS-checked via short tx).
		if !isActiveMember(r.Context(), pool, tenantID, userID) {
			http.Error(w, "not a member", http.StatusForbidden)
			return
		}

		// 4. Upgrade.
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns:   allowedOrigins,
			InsecureSkipVerify: len(allowedOrigins) == 0,
		})
		if err != nil {
			return // websocket.Accept already wrote a 4xx
		}

		// 5. Subscribe to default topics + run.
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		_ = hub.newClient(ctx, ws, tenantID, []Topic{TopicKitchen, TopicTables, TopicOrders, TopicFinance})

		// Block until the connection closes (the lifecycle goroutine will
		// finish first; we just wait for ctx.Done so the http.Handler
		// doesn't return prematurely and tear down the conn).
		<-ctx.Done()
	}
}

func isActiveMember(ctx context.Context, pool *pgxpool.Pool, tenantID, userID uuid.UUID) bool {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
		tenantID.String(), userID.String()); err != nil {
		return false
	}
	var status string
	if err := tx.QueryRow(ctx, `
		SELECT status::text FROM tenant_members WHERE tenant_id = $1 AND user_id = $2
	`, tenantID, userID).Scan(&status); err != nil {
		return false
	}
	return status == "active"
}
