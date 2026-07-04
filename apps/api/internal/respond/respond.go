// Package respond centralises JSON error responses so server-side failure
// detail (pg constraint names, connection strings, file paths) never reaches
// clients in prod. Handlers keep passing the real error text; in prod any
// >=500 body is swapped for a generic message and the original detail is
// logged instead.
package respond

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

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
		if c, ok := w.(ServerErrorCapturer); ok {
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
