package billing

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

// gateBypass lists route patterns that are technically non-GET but are not
// real "writes" to business data and must keep working while a tenant is
// write-locked (e.g. minting a WebSocket ticket so the read-only UI can still
// receive live updates). Matched against chi's RoutePattern().
var gateBypass = map[string]bool{
	"/ws-ticket": true,
}

// WriteGate blocks mutating requests when the tenant is write-locked (manual
// super-admin lock OR trial expired past grace). Reads (GET/HEAD/OPTIONS)
// always pass, as do the explicit bypass routes. Mount inside the tenant-
// scoped group AFTER RequireMember (which loads State) and before the route
// permission gates.
//
// Returns 402 Payment Required with code "write_locked" so the FE can tell a
// billing lock apart from a permission denial (403) or a feature gate
// (403 plan_upgrade_required).
func WriteGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isReadMethod(r.Method) || isGateBypass(r) {
			next.ServeHTTP(w, r)
			return
		}
		if st, ok := StateFromContext(r.Context()); ok && st.WriteLocked {
			writeErr(w, http.StatusPaymentRequired, "write_locked",
				"this workspace is read-only — a billing action is required to make changes")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireFeature gates a route on the tenant's effective feature set. Mount
// via chi's With(...) exactly like auth.Require. Trial tenants pass everything
// (ComputeState sets all features during the trial window). Returns 403 with
// code "plan_upgrade_required" so the FE can surface an upgrade prompt.
func RequireFeature(f FeatureKey) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			st, ok := StateFromContext(r.Context())
			if !ok || !st.Has(f) {
				writeErr(w, http.StatusForbidden, "plan_upgrade_required",
					"this feature is not included in your plan: "+string(f))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isReadMethod(m string) bool {
	switch strings.ToUpper(m) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}

func isGateBypass(r *http.Request) bool {
	if rc := chi.RouteContext(r.Context()); rc != nil {
		return gateBypass[rc.RoutePattern()]
	}
	return false
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": kind, "message": msg})
}
