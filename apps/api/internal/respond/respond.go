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

// Err writes the canonical {code, message} error body. With sanitization on,
// 5xx messages are masked; the real detail still lands in the server log.
func Err(w http.ResponseWriter, code int, kind, msg string) {
	if code >= 500 && sanitizeServerErrors && msg != "" {
		slog.Default().Error("http.internal_error", "code", kind, "detail", msg)
		msg = "an internal error occurred"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": kind, "message": msg})
}
