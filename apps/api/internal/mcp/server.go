package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/billing"
)

// The HTTP surface: POST /mcp/c/{token}.
//
// Mounted OUTSIDE /v1, because /v1 resolves the café from X-Tenant-ID and the
// caller from a first-party JWT — and a connector has neither until the token in
// its URL is resolved. It needs its own front door, and then it borrows /v1
// entirely (see dispatch.go).
//
// GET returns 405 on purpose. A GET on the MCP endpoint means the client is
// trying to open the legacy SSE stream, and answering it would start something
// this deployment cannot hold open for more than sixty seconds. A clean 405 is a
// better failure than a stream that dies mid-conversation every minute.

// maxRequestBytes bounds a JSON-RPC body. Tool arguments are a handful of small
// fields; anything larger is a mistake or an attack, and this runs on a 480 MiB
// task.
const maxRequestBytes = 64 << 10

// Handler serves the MCP endpoint.
type Handler struct {
	pool *pgxpool.Pool
	disp *Dispatcher
	log  *slog.Logger
}

func NewHandler(pool *pgxpool.Pool, app http.Handler, log *slog.Logger) *Handler {
	return &Handler{pool: pool, disp: NewDispatcher(pool, app), log: log}
}

// Mount registers the routes on r.
func (h *Handler) Mount(r chi.Router) {
	r.Post("/c/{token}", h.serve)
	// Every other verb, including the SSE GET, is refused with the reason.
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w,
			"this MCP server is stateless Streamable HTTP: POST only. "+
				"The legacy HTTP+SSE transport is not supported.",
			http.StatusMethodNotAllowed)
	})
}

func writeRPC(w http.ResponseWriter, resp response) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// --- authenticate -----------------------------------------------------
	//
	// A bad token gets a plain HTTP 401, NOT a JSON-RPC error. The distinction
	// matters to a client: 401 means "this connector is not valid, stop
	// retrying and tell the user", while a JSON-RPC error means "the server is
	// working and your call was wrong".
	conn, err := Resolve(ctx, h.pool, chi.URLParam(r, "token"))
	if err != nil {
		if errors.Is(err, ErrNoConnection) {
			http.Error(w, "unknown, revoked or expired connection", http.StatusUnauthorized)
			return
		}
		h.log.ErrorContext(ctx, "mcp.resolve_failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// The feature gate is checked HERE rather than relying on the per-route
	// gates inside /v1. Those protect the data; this protects the doorway. A
	// café whose plan does not include the connector should not have a working
	// URL at all, even one that would only ever return 403s.
	if !h.featureEnabled(ctx, conn) {
		http.Error(w, "the AI connector is not enabled for this café", http.StatusPaymentRequired)
		return
	}

	// --- parse ------------------------------------------------------------
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes))
	if err != nil {
		writeRPC(w, fail(nil, codeParse, "could not read request"))
		return
	}
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		writeRPC(w, fail(nil, codeParse, "invalid JSON"))
		return
	}
	if req.JSONRPC != "2.0" {
		writeRPC(w, fail(req.ID, codeInvalidRequest, "jsonrpc must be \"2.0\""))
		return
	}

	// --- dispatch ---------------------------------------------------------
	switch req.Method {
	case "initialize":
		res := initializeResult{
			ProtocolVersion: protocolVersion,
			ServerInfo:      serverInfo{Name: serverName, Version: serverVersion},
			Instructions:    instructions,
		}
		writeRPC(w, ok(req.ID, res))

	case "notifications/initialized", "notifications/cancelled":
		// A notification has no id and MUST NOT be answered. Some clients treat
		// a reply to one as a protocol violation and drop the connection.
		w.WriteHeader(http.StatusAccepted)

	case "ping":
		writeRPC(w, ok(req.ID, map[string]any{}))

	case "tools/list":
		writeRPC(w, ok(req.ID, toolsListResult{Tools: Descriptors(conn.Scopes)}))

	case "tools/call":
		h.callTool(w, r, conn, req)

	default:
		if req.isNotification() {
			// An unknown notification is ignored rather than refused: the spec
			// lets a server not implement one, and erroring on a client's
			// housekeeping message is how a connection gets dropped.
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeRPC(w, fail(req.ID, codeMethodNotFound, "unknown method: "+req.Method))
	}
}

func (h *Handler) callTool(w http.ResponseWriter, r *http.Request, conn Connection, req request) {
	ctx := r.Context()

	var p toolCallParams
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &p); err != nil {
			writeRPC(w, fail(req.ID, codeInvalidParams, "could not read params"))
			return
		}
	}
	tool, found := ByName(p.Name)
	if !found {
		writeRPC(w, fail(req.ID, codeInvalidParams, "unknown tool: "+p.Name))
		return
	}

	// Scope check. Descriptors() already hides tools this connection cannot
	// call, so reaching here means the model either remembered a tool from an
	// earlier session or guessed — either way it is refused, and told plainly
	// enough that it stops trying.
	if !conn.HasScope(tool.Scope) {
		writeRPC(w, ok(req.ID, errorResult(
			"This connection is not allowed to use %s. The café's owner can enable the %q "+
				"permission for it in Settings.", tool.Name, tool.Scope)))
		return
	}

	a := args{}
	if len(p.Arguments) > 0 {
		if err := json.Unmarshal(p.Arguments, &a); err != nil {
			writeRPC(w, fail(req.ID, codeInvalidParams, "arguments must be a JSON object"))
			return
		}
	}

	body, status, err := h.disp.Call(ctx, conn, tool, a)
	if err != nil {
		// A bad argument is the model's problem to fix, so it comes back as a
		// TOOL error it can read and retry, not a protocol error that looks
		// like we are broken.
		writeRPC(w, ok(req.ID, errorResult("%s", err.Error())))
		return
	}
	// Detached from the request context on purpose: the stamp outlives the
	// response, and cancelling it because the client hung up would lose the one
	// signal that tells an owner a connector is still in use.
	go touch(context.WithoutCancel(ctx), h.pool, conn)

	switch {
	case status >= 200 && status < 300:
		// A 204 (or any empty 2xx) is what the /v1 write handlers return on
		// success. Handing a model empty content leaves it unable to tell
		// whether anything happened — it will either say nothing to the user or,
		// worse, invent a confirmation. So success gets said out loud.
		if strings.TrimSpace(body) == "" {
			note := tool.SuccessNote
			if note == "" {
				note = "The call succeeded."
			}
			writeRPC(w, ok(req.ID, textResult("Done. "+note)))
			return
		}
		writeRPC(w, ok(req.ID, textResult(body)))
	case status == http.StatusForbidden, status == http.StatusPaymentRequired:
		// Translated rather than passed through. The raw envelope
		// ("plan_upgrade_required") means nothing to a model, and an assistant
		// that cannot tell "you may not" from "that broke" will either keep
		// retrying or tell the user the café's data is unavailable.
		writeRPC(w, ok(req.ID, errorResult(
			"Not permitted: this connection's café either does not include that on its plan, "+
				"or the member it acts as lacks the permission. Nothing was changed.")))
	case status == http.StatusNotFound:
		writeRPC(w, ok(req.ID, errorResult(
			"Not found. If you passed an id, fetch a current one first rather than reusing an old one.")))
	default:
		h.log.WarnContext(ctx, "mcp.tool_failed",
			"tool", tool.Name, "status", status, "tenant", conn.TenantSlug)
		writeRPC(w, ok(req.ID, errorResult(
			"That call did not succeed (status %d). %s", status, trimBody(body))))
	}
}

// featureEnabled checks the café's plan for the connector.
func (h *Handler) featureEnabled(ctx context.Context, conn Connection) bool {
	// billing exposes only LoadStateTx, so this borrows a transaction. Read-only
	// and rolled back: the plan is not this request's business to change.
	tx, err := h.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		h.log.ErrorContext(ctx, "mcp.billing_tx_failed", "err", err)
		return false
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	st, err := billing.LoadStateTx(ctx, tx, conn.TenantID)
	if err != nil {
		// Fail CLOSED. An unreadable plan must not silently open a doorway that
		// sends a café's data to a third party.
		h.log.ErrorContext(ctx, "mcp.billing_load_failed", "err", err, "tenant", conn.TenantSlug)
		return false
	}
	return st.Has(billing.FeatureMCPConnect)
}

// trimBody keeps an upstream error message short enough to be useful without
// pasting an entire response into a model's context.
func trimBody(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}
