package auth

import (
	"encoding/json"
	"net/http"
)

// ConfigHandler advertises which login methods the server has mounted, so the
// SPA can render the matching buttons without having to probe routes.
//
// Returned unauthenticated. The booleans are derived from server config at
// startup (google env vars present, APP_ENV=dev) — they don't change between
// requests.
func ConfigHandler(googleEnabled, devLoginEnabled bool) http.HandlerFunc {
	body := struct {
		GoogleEnabled   bool `json:"google_enabled"`
		DevLoginEnabled bool `json:"dev_login_enabled"`
	}{googleEnabled, devLoginEnabled}
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(body)
	}
}
