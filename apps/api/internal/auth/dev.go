package auth

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DevLoginHandler creates or finds a user by email, opens a session, and
// returns the bearer token in the response body (also sets the cookie).
//
// Mount only when APP_ENV is "dev" or "test" — production should never
// expose this. The route does no password check.
//
//	POST /auth/dev-login
//	{ "email": "owner@sahan.test", "name": "Sahan Owner" }
func DevLoginHandler(pool *pgxpool.Pool, rootDomain string, secureCookies bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
			return
		}
		var body struct {
			Email string `json:"email"`
			Name  string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "email required")
			return
		}

		userID, err := LookupOrCreateUser(r.Context(), pool, "", body.Email, body.Name, "")
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "user upsert failed")
			return
		}
		// Best-effort: consume any pending invites for this email. A
		// failure mustn't block login — the user can re-try later.
		_, _ = AcceptPendingInvites(r.Context(), pool, userID, body.Email)
		token, sessID, err := CreateSession(r.Context(), pool, userID, r.RemoteAddr, r.UserAgent())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "session create failed")
			return
		}
		SetCookie(w, token, rootDomain, secureCookies)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":    userID,
			"session_id": sessID,
			"token":      token,
		})
	}
}
