// Package respond centralises JSON error responses so server-side failure
// detail (pg constraint names, connection strings, file paths) never reaches
// clients in prod. Handlers keep passing the real error text; in prod any
// >=500 body is swapped for a generic message and the original detail is
// logged instead.
package respond

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

// StatusClientClosedRequest is nginx's non-standard 499, used when the client
// aborted the request before the server finished. Go's net/http has no constant
// for it. We record it (instead of a 500) when r.Context() was canceled, so a
// client that navigated away mid-request doesn't count as a server fault.
const StatusClientClosedRequest = 499

// ClientGone reports whether the request was aborted by the client — i.e. the
// request context was canceled. It deliberately treats only context.Canceled as
// "client gone"; a context.DeadlineExceeded is a server-side timeout and must
// still be surfaced as a real 5xx.
func ClientGone(ctx context.Context) bool {
	return errors.Is(ctx.Err(), context.Canceled)
}

var sanitizeServerErrors bool

// SanitizeServerErrors toggles prod behaviour: replace 5xx message bodies
// with a generic string and slog the original detail. Call once at startup.
func SanitizeServerErrors(on bool) { sanitizeServerErrors = on }

// ServerErrorCapturer receives the masked-away detail of a 5xx so a
// request-scoped layer (the HTTP middleware) can log it WITH req_id and fold it
// into the operational alert. The response writer passed to Err implements this
// when the request ran through the middleware chain; see internal/httpx.
type ServerErrorCapturer interface {
	CaptureServerError(kind, detail string)
}

// Err writes the canonical {code, message} error body. With sanitization on,
// 5xx messages are masked; the real detail is handed to the request writer's
// ServerErrorCapturer (so it is logged with req_id and surfaced in the alert),
// falling back to a bare slog line when the writer can't capture it.
func Err(w http.ResponseWriter, code int, kind, msg string) {
	if code >= 500 && sanitizeServerErrors && msg != "" {
		if c := FindCapturer(w); c != nil {
			c.CaptureServerError(kind, msg)
		} else {
			// Non-request writer (or a re-wrapped one that dropped the
			// capturer): keep the detail somewhere rather than lose it.
			slog.Default().Error("http.internal_error", "code", kind, "detail", msg)
		}
		msg = "an internal error occurred"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": kind, "message": msg})
}

// FindCapturer locates the ServerErrorCapturer for this response, following the
// Unwrap() chain. Middleware routinely re-wrap the writer (compression, a
// status recorder, the tx layer), and a plain type assertion on the outermost
// wrapper misses the capturer sitting underneath — which silently diverts every
// 5xx detail to a req_id-less log line instead of the alert. All the wrappers in
// our chain implement Unwrap() (for http.ResponseController), so we can walk
// down to reach it.
func FindCapturer(w http.ResponseWriter) ServerErrorCapturer {
	for x := w; x != nil; {
		if c, ok := x.(ServerErrorCapturer); ok {
			return c
		}
		u, ok := x.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return nil
		}
		x = u.Unwrap()
	}
	return nil
}
