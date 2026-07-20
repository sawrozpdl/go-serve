package api

// Focused test for IssueWSTicket's client-gone handling.
//
// Handler lives in internal/api/ws_ticket.go. When the client aborts the
// in-flight POST /v1/ws-ticket (navigation/refocus/network flap), r.Context()
// is canceled, the ws_tickets INSERT fails with context.Canceled, and the
// handler must record 499 client_closed_request — not a paging 500 — matching
// the RequireMember / TxMiddleware treatment shipped in 0f8f85f.
//
// This path is RLS-independent: pool.Exec on an already-canceled context
// returns context.Canceled before touching any row, so no fixture rows are
// needed — only a constructed pool object (appPool) and user+tenant context.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

func TestIssueWSTicket_ClientGoneReturns499(t *testing.T) {
	if dbSkip != "" {
		t.Skip(dbSkip)
	}

	ctx, cancel := context.WithCancel(context.Background())
	ctx = appctx.WithUser(ctx, appctx.User{ID: uuid.New(), Email: "mgr@example.com", Name: "Mgr"})
	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: uuid.New(), Slug: "chiya-thali", Name: "Chiya Thali", Timezone: "Asia/Kathmandu"})
	// Client goes away before the ticket lands.
	cancel()

	req := httptest.NewRequest(http.MethodPost, "/v1/ws-ticket", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	IssueWSTicket(appPool)(rec, req)

	if rec.Code != 499 {
		t.Fatalf("client-gone ws-ticket: got status %d, want 499 (client_closed_request); body=%s",
			rec.Code, rec.Body.String())
	}
}
