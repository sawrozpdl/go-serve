package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// IssueTokensForUser creates a fresh refresh session and writes the access +
// refresh token pair as the JSON response. The shared success path for OTP,
// dev-login, and the Google handoff exchange.
func IssueTokensForUser(ctx context.Context, pool *pgxpool.Pool, w http.ResponseWriter, userID uuid.UUID, ip, ua string) error {
	refresh, sid, err := CreateSession(ctx, pool, userID, ip, ua)
	if err != nil {
		return err
	}
	return writeTokenPair(ctx, pool, w, userID, sid, refresh)
}

// writeTokenPair mints an access token for (userID, sid) and emits the pair.
func writeTokenPair(ctx context.Context, pool *pgxpool.Pool, w http.ResponseWriter, userID, sid uuid.UUID, refreshRaw string) error {
	email, name, err := LookupUserByID(ctx, pool, userID)
	if err != nil {
		return err
	}
	tv, err := GetTokenVersion(ctx, pool, userID)
	if err != nil {
		return err
	}
	access, exp, err := MintAccessToken(userID, email, name, sid, tv)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":      access,
		"refresh_token":     refreshRaw,
		"access_expires_in": int(time.Until(exp).Seconds()),
		"user_id":           userID,
		"session_id":        sid,
	})
	return nil
}

// RefreshHandler rotates a refresh token and returns a new access+refresh pair.
//
//	POST /auth/refresh  { "refresh_token": "..." }
func RefreshHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RefreshToken string `json:"refresh_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.RefreshToken) == "" {
			writeErr(w, http.StatusUnauthorized, "refresh_invalid", "refresh token required")
			return
		}
		newRaw, sid, userID, err := RotateRefresh(r.Context(), pool, strings.TrimSpace(body.RefreshToken), r.RemoteAddr, r.UserAgent())
		if err != nil {
			if errors.Is(err, ErrRefreshReuse) {
				LogAuthEvent(r.Context(), AuthLoginFailure, "refresh", "", nil, r.RemoteAddr, r.UserAgent(), "refresh_reuse")
			}
			writeErr(w, http.StatusUnauthorized, "refresh_invalid", "refresh token invalid or expired")
			return
		}
		if err := writeTokenPair(r.Context(), pool, w, userID, sid, newRaw); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "token mint failed")
		}
	}
}

// LogoutHandler revokes the current session. Accepts the refresh token in the
// body (primary) and/or falls back to the session id from the bearer access
// token. No cookies are involved.
//
//	POST /auth/logout  { "refresh_token": "..." }
func LogoutHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RefreshToken string `json:"refresh_token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		var loggedUser *uuid.UUID
		var loggedEmail string

		if strings.TrimSpace(body.RefreshToken) != "" {
			if _, uid, err := RevokeByRefreshToken(r.Context(), pool, strings.TrimSpace(body.RefreshToken)); err == nil {
				loggedUser = &uid
			}
		}
		// Best-effort: also revoke by the bearer's session id (covers the case
		// where the client lost the refresh token but still has an access one).
		if claims, err := ParseAccessToken(bearerToken(r)); err == nil {
			if sid, perr := uuid.Parse(claims.SID); perr == nil {
				_ = Revoke(r.Context(), pool, sid)
			}
			if loggedUser == nil {
				if uid, perr := uuid.Parse(claims.Subject); perr == nil {
					loggedUser = &uid
					loggedEmail = claims.Email
				}
			}
		}

		LogAuthEvent(r.Context(), AuthLogout, "", loggedEmail, loggedUser, r.RemoteAddr, r.UserAgent(), "")
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// LogoutAllHandler revokes every session for the authenticated user and bumps
// their token_version, immediately invalidating all outstanding access tokens.
// Mount behind BearerMiddleware + RequireAuth.
func LogoutAllHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := appctx.UserFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unauthenticated", "auth required")
			return
		}
		if err := RevokeAllForUser(r.Context(), pool, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "revoke failed")
			return
		}
		if _, err := BumpTokenVersion(r.Context(), pool, user.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "bump failed")
			return
		}
		LogAuthEvent(r.Context(), AuthLogout, "", user.Email, &user.ID, r.RemoteAddr, r.UserAgent(), "logout_all")
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// bearerToken extracts the raw token from an "Authorization: Bearer <t>" header.
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) >= 7 && strings.EqualFold(h[:7], "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}
