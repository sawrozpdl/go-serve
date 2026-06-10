// Package super implements the site-wide super-admin console (/v1/super). It
// is NOT tenant-scoped: handlers operate across all tenants and are gated by
// auth.RequirePlatformAdmin, never by tenant RBAC. Cross-tenant reads that
// would otherwise be blocked by RLS go through the SECURITY DEFINER functions
// installed in migration 0025.
package super

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/pewssh/cafe-mgmt/api/internal/respond"
)

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	respond.Err(w, code, kind, msg)
}

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
var nonSlugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = nonSlugRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 63 {
		s = s[:63]
	}
	return s
}
