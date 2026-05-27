package httpx

import (
	"net/http"
	"strings"
)

// SecurityHeaders returns middleware that sets a hardened set of response
// headers on every API response.
//
//   - X-Content-Type-Options: nosniff
//   - X-Frame-Options: DENY            — the API is JSON; never a frame
//   - Referrer-Policy: strict-origin-when-cross-origin
//   - Permissions-Policy: ()           — opt out of features we never use
//   - Strict-Transport-Security        — prod only (gated on `prod`)
//   - Content-Security-Policy          — locked to 'self' for the API; the
//     SPA serves its own CSP from the static-host layer
//
// HSTS is intentionally gated: localhost dev with self-signed certs would
// pin the browser onto HTTPS and break the workflow.
func SecurityHeaders(prod bool) func(http.Handler) http.Handler {
	csp := strings.Join([]string{
		"default-src 'self'",
		"img-src 'self' data: https:",
		"style-src 'self' 'unsafe-inline'",
		"script-src 'self'",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
	}, "; ")
	permissions := strings.Join([]string{
		"camera=()",
		"microphone=()",
		"geolocation=()",
		"payment=()",
	}, ", ")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			h.Set("Permissions-Policy", permissions)
			h.Set("Content-Security-Policy", csp)
			if prod {
				h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}
