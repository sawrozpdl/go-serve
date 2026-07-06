package logging

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// contextHandler enriches every record with the request-scoped identity carried
// on the context — the tenant and user resolved by auth/tenant middleware — so
// that EVERY log line (handler logs, alert.Fire records, the request summary),
// not just the request-summary line, is attributable to a café and a user. It
// reads them at emit time from the mutable appctx.RequestInfo holder, which is
// the only way values resolved DOWNSTREAM of the logger's creation become
// visible: slog attaches attrs when a logger is built, but the tenant/user
// aren't known yet at that point.
//
// req_id/method/path stay on the per-request logger (attached via With in
// slogRequest) so they ride even non-context log calls; this handler adds only
// what must be resolved late.
type contextHandler struct{ slog.Handler }

// WithContextEnrichment wraps h so records pick up tenant/user from the context.
// It is a no-op-safe decorator: records without a populated holder are emitted
// unchanged.
func WithContextEnrichment(h slog.Handler) slog.Handler { return contextHandler{h} }

func (h contextHandler) Handle(ctx context.Context, r slog.Record) error {
	ri, ok := appctx.RequestInfoFromContext(ctx)
	if !ok {
		return h.Handler.Handle(ctx, r)
	}
	// A few call sites already log tenant/user explicitly (e.g. an audit or a
	// ticket handler). Don't clobber or duplicate those — only add keys the
	// record doesn't already carry.
	existing := map[string]bool{}
	r.Attrs(func(a slog.Attr) bool { existing[a.Key] = true; return true })
	add := func(key, val string) {
		if val != "" && !existing[key] {
			r.AddAttrs(slog.String(key, val))
		}
	}
	add("tenant", ri.TenantSlug)
	if ri.TenantID != uuid.Nil {
		add("tenant_id", ri.TenantID.String())
	}
	add("user", ri.UserEmail)
	if ri.UserID != uuid.Nil {
		add("user_id", ri.UserID.String())
	}
	return h.Handler.Handle(ctx, r)
}

func (h contextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return contextHandler{h.Handler.WithAttrs(attrs)}
}

func (h contextHandler) WithGroup(name string) slog.Handler {
	return contextHandler{h.Handler.WithGroup(name)}
}
