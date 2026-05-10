// Package auth provides session storage, cookie helpers, and the auth
// middleware that resolves a request's user from the session cookie.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	CookieName        = "cafe_session"
	SessionTTL        = 30 * 24 * time.Hour
	SessionRefreshAge = 24 * time.Hour
)

// sessionSameSite controls the SameSite attribute on the session cookie.
// Default Lax works when FE and API share a registrable domain (e.g.
// app.cafe.com calling api.cafe.com). For fully cross-site deployments
// (FE on cafe-app.vercel.app, API on api.cafe.com) configure SameSite=None
// at startup via SetSessionSameSite — this also requires Secure cookies,
// which config.Load() enforces.
var sessionSameSite = http.SameSiteLaxMode

// SetSessionSameSite overrides the SameSite mode used by SetCookie and
// ClearCookie. Call once at startup from main, before serving requests.
func SetSessionSameSite(s http.SameSite) {
	if s == 0 {
		return
	}
	sessionSameSite = s
}

// CreateSession inserts a new row and returns the raw token (to set in the
// cookie) plus the session ID.
func CreateSession(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, ip, ua string) (token string, sessID uuid.UUID, err error) {
	token, hash, err := newToken()
	if err != nil {
		return "", uuid.Nil, err
	}
	row := pool.QueryRow(ctx, `
		INSERT INTO sessions (user_id, token_hash, expires_at, ip, ua)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id
	`, userID, hash, time.Now().Add(SessionTTL), nullIfEmpty(ip), nullIfEmpty(ua))
	if err := row.Scan(&sessID); err != nil {
		return "", uuid.Nil, err
	}
	return token, sessID, nil
}

// LookupSession returns the (sessionID, userID, tenantID) for a raw token,
// or pgx.ErrNoRows if not found / expired / revoked.
func LookupSession(ctx context.Context, pool *pgxpool.Pool, token string) (sessID, userID uuid.UUID, tenantID *uuid.UUID, expiresAt time.Time, err error) {
	hash := hashToken(token)
	row := pool.QueryRow(ctx, `
		SELECT id, user_id, tenant_id, expires_at
		FROM sessions
		WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
	`, hash)
	err = row.Scan(&sessID, &userID, &tenantID, &expiresAt)
	return
}

// TouchSession bumps last_seen_at and (if past refresh threshold) extends
// expires_at — sliding expiry.
func TouchSession(ctx context.Context, pool *pgxpool.Pool, sessID uuid.UUID, expiresAt time.Time) {
	now := time.Now()
	if expiresAt.Sub(now) > SessionTTL-SessionRefreshAge {
		_, _ = pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, sessID)
		return
	}
	_, _ = pool.Exec(ctx, `
		UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1
	`, sessID, now.Add(SessionTTL))
}

// SetTenant associates a session with a tenant (for the workspace-pick flow).
func SetTenant(ctx context.Context, pool *pgxpool.Pool, sessID, tenantID uuid.UUID) error {
	_, err := pool.Exec(ctx, `UPDATE sessions SET tenant_id = $1 WHERE id = $2`, tenantID, sessID)
	return err
}

// Revoke marks a session revoked (logout).
func Revoke(ctx context.Context, pool *pgxpool.Pool, sessID uuid.UUID) error {
	_, err := pool.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE id = $1`, sessID)
	return err
}

// SetCookie writes the session cookie on a response.
//
// In production (rootDomain has at least one dot, e.g. "cafe.app"), the
// cookie's Domain is set to ".rootDomain" so it's shared across subdomains.
// In dev (rootDomain="localhost" or any single-label name), the cookie is
// host-only — curl and many browsers reject Domain=.localhost cookies due
// to PSL restrictions.
func SetCookie(w http.ResponseWriter, token, rootDomain string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		Domain:   cookieDomain(rootDomain),
		MaxAge:   int(SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: sessionSameSite,
	})
}

// ClearCookie expires the session cookie.
func ClearCookie(w http.ResponseWriter, rootDomain string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		Domain:   cookieDomain(rootDomain),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: sessionSameSite,
	})
}

// cookieDomain returns the Domain attribute for the session cookie.
//
// Notes:
//   - For real domains ("cafe.app"), use ".cafe.app" so the cookie is sent
//     for all subdomains (sahan.cafe.app, brews.cafe.app).
//   - For "localhost" / single-label dev hosts, the cookie spec + curl's PSL
//     refuses cross-subdomain sharing. We return host-only (no Domain) and
//     callers should rely on the X-Tenant-ID header in dev. For real
//     subdomain testing locally, use a multi-label hostname like cafe.test
//     in /etc/hosts (sahan.cafe.test, brews.cafe.test).
func cookieDomain(rootDomain string) string {
	if !strings.Contains(rootDomain, ".") {
		return ""
	}
	return "." + rootDomain
}

// LookupOrCreateUser finds a user by google_sub or email; creates if missing.
func LookupOrCreateUser(ctx context.Context, pool *pgxpool.Pool, googleSub, email, name, avatar string) (uuid.UUID, error) {
	var id uuid.UUID
	if googleSub != "" {
		row := pool.QueryRow(ctx, `SELECT id FROM users WHERE google_sub = $1`, googleSub)
		if err := row.Scan(&id); err == nil {
			_, _ = pool.Exec(ctx, `UPDATE users SET name = $1, avatar_url = $2 WHERE id = $3`, name, nullIfEmpty(avatar), id)
			return id, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, err
		}
	}
	row := pool.QueryRow(ctx, `SELECT id FROM users WHERE email = $1`, email)
	if err := row.Scan(&id); err == nil {
		if googleSub != "" {
			_, _ = pool.Exec(ctx, `UPDATE users SET google_sub = $1, name = $2, avatar_url = $3 WHERE id = $4`,
				googleSub, name, nullIfEmpty(avatar), id)
		}
		return id, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, err
	}
	row = pool.QueryRow(ctx, `
		INSERT INTO users (email, name, avatar_url, google_sub)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, email, name, nullIfEmpty(avatar), nullIfEmpty(googleSub))
	if err := row.Scan(&id); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

// LookupUserByID returns the public user fields.
func LookupUserByID(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) (email, name string, err error) {
	row := pool.QueryRow(ctx, `SELECT email::text, name FROM users WHERE id = $1`, id)
	err = row.Scan(&email, &name)
	return
}

func newToken() (raw, hash string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return
	}
	raw = hex.EncodeToString(b)
	hash = hashToken(raw)
	return
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
