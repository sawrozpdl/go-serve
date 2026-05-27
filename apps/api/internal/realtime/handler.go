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
// Auth: a single-use ticket (?ticket=<t>) minted by POST /v1/ws-ticket. The
// browser WebSocket API can't send an Authorization header, and putting a
// bearer token in the URL would leak it into proxy logs — so the SPA fetches
// a short-lived ticket over the authenticated REST API and connects with it.
// The ticket already encodes the (user, tenant) pair.
//
// On accept, the client is auto-subscribed to ["kitchen", "tables", "orders", "finance"]
// for the tenant. We don't expose subscription control to clients today;
// the FE has only one app, the topic set is small, and the hub is
// goroutine-cheap.
func Handler(pool *pgxpool.Pool, hub *Hub, allowedOrigins []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// 1. Validate + consume the ticket → (user, tenant).
		ticket := strings.TrimSpace(r.URL.Query().Get("ticket"))
		if ticket == "" {
			http.Error(w, "ticket required (?ticket=...)", http.StatusUnauthorized)
			return
		}
		userID, tenantID, err := auth.ConsumeWSTicket(r.Context(), pool, ticket)
		if err != nil {
			http.Error(w, "ticket invalid or expired", http.StatusUnauthorized)
			return
		}

		// 2. Re-verify membership (RLS-checked via short tx) — tickets are
		// short-lived but a revoked membership must still be honored.
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
