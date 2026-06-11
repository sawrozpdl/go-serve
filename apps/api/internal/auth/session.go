// Package auth provides JWT access tokens, opaque rotating refresh tokens
// (stored in `sessions`), token-version based global logout, and the bearer
// middleware that resolves a request's user from the access token.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// refreshRotateGrace is how long a just-rotated refresh token keeps working as
// an idempotent replay. Normal multi-tab / network-retry refreshes present the
// same (now-rotated) token within this window and must NOT be treated as an
// attack; a presentation after it is treated as reuse and revokes the chain.
//
// Widened from 20s to 60s: on flaky mobile links a retry or a second tab could
// re-present the old token after the original 20s window and get the whole
// session revoked — bouncing the user to login mid-shift. 60s comfortably
// covers real retry/multi-tab races while keeping the theft-replay window short.
const refreshRotateGrace = 60 * time.Second

var (
	// ErrRefreshInvalid is returned for an unknown / expired refresh token.
	ErrRefreshInvalid = errors.New("refresh token invalid or expired")
	// ErrRefreshReuse is returned when a rotated/revoked refresh token is
	// presented outside the grace window — likely token theft. The user's
	// sessions are revoked as a side effect.
	ErrRefreshReuse = errors.New("refresh token reuse detected")
)

// rowQuerier is satisfied by both *pgxpool.Pool and pgx.Tx, so insertSession
// can run on the pool (login) or inside the rotation tx (refresh).
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// CreateSession inserts a new refresh-token row and returns the raw token plus
// the session ID. Used by the login flows (OTP, dev, Google exchange).
func CreateSession(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, ip, ua string) (token string, sessID uuid.UUID, err error) {
	return insertSession(ctx, pool, userID, ip, ua)
}

func insertSession(ctx context.Context, q rowQuerier, userID uuid.UUID, ip, ua string) (raw string, sid uuid.UUID, err error) {
	raw, hash, err := newToken()
	if err != nil {
		return "", uuid.Nil, err
	}
	err = q.QueryRow(ctx, `
		INSERT INTO sessions (user_id, token_hash, expires_at, ip, ua)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id
	`, userID, hash, time.Now().Add(refreshTokenTTL), nullIfEmpty(ip), nullIfEmpty(ua)).Scan(&sid)
	if err != nil {
		return "", uuid.Nil, err
	}
	return raw, sid, nil
}

// RotateRefresh validates a refresh token and rotates it in a single locked
// transaction. On success it returns a fresh refresh token + its session ID +
// the owning user. Sliding expiry is implicit: each rotation writes a new row
// with expires_at = now + RefreshTTL.
//
// Concurrency: the row is locked FOR UPDATE so two refreshes with the same
// token serialize. The first wins (normal rotation); a second arriving within
// refreshRotateGrace is treated as an idempotent replay and gets its own fresh
// token rather than tripping reuse detection. Outside the window a revoked
// token is treated as reuse → every session for the user is revoked.
func RotateRefresh(ctx context.Context, pool *pgxpool.Pool, rawToken, ip, ua string) (newRaw string, sid, userID uuid.UUID, err error) {
	hash := hashToken(rawToken)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", uuid.Nil, uuid.Nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		curID      uuid.UUID
		uid        uuid.UUID
		expiresAt  time.Time
		revokedAt  *time.Time
		replacedAt *time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT id, user_id, expires_at, revoked_at, replaced_at
		FROM sessions WHERE token_hash = $1 FOR UPDATE
	`, hash).Scan(&curID, &uid, &expiresAt, &revokedAt, &replacedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", uuid.Nil, uuid.Nil, ErrRefreshInvalid
	}
	if err != nil {
		return "", uuid.Nil, uuid.Nil, err
	}
	if time.Now().After(expiresAt) {
		return "", uuid.Nil, uuid.Nil, ErrRefreshInvalid
	}

	if revokedAt != nil {
		// Idempotent replay inside the grace window: hand out a fresh token
		// without revoking the chain (normal concurrent multi-tab refresh).
		if replacedAt != nil && time.Since(*replacedAt) <= refreshRotateGrace {
			newRaw, sid, err = insertSession(ctx, tx, uid, ip, ua)
			if err != nil {
				return "", uuid.Nil, uuid.Nil, err
			}
			if err = tx.Commit(ctx); err != nil {
				return "", uuid.Nil, uuid.Nil, err
			}
			return newRaw, sid, uid, nil
		}
		// Reuse outside the window (or a logged-out token) → revoke everything.
		_, _ = tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, uid)
		_ = tx.Commit(ctx)
		return "", uuid.Nil, uuid.Nil, ErrRefreshReuse
	}

	// Normal rotation: insert the successor, point the old row at it, revoke.
	newRaw, sid, err = insertSession(ctx, tx, uid, ip, ua)
	if err != nil {
		return "", uuid.Nil, uuid.Nil, err
	}
	if _, err = tx.Exec(ctx, `
		UPDATE sessions SET revoked_at = now(), replaced_by = $2, replaced_at = now() WHERE id = $1
	`, curID, sid); err != nil {
		return "", uuid.Nil, uuid.Nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", uuid.Nil, uuid.Nil, err
	}
	return newRaw, sid, uid, nil
}

// RevokeByRefreshToken revokes the session identified by a raw refresh token
// (logout). Returns the session + user IDs for audit logging.
func RevokeByRefreshToken(ctx context.Context, pool *pgxpool.Pool, rawToken string) (sid, userID uuid.UUID, err error) {
	err = pool.QueryRow(ctx, `
		UPDATE sessions SET revoked_at = now()
		WHERE token_hash = $1 AND revoked_at IS NULL
		RETURNING id, user_id
	`, hashToken(rawToken)).Scan(&sid, &userID)
	return
}

// Revoke marks a single session revoked by ID (logout via bearer sid).
func Revoke(ctx context.Context, pool *pgxpool.Pool, sessID uuid.UUID) error {
	_, err := pool.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE id = $1`, sessID)
	return err
}

// RevokeAllForUser revokes every active session for a user.
func RevokeAllForUser(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID) error {
	_, err := pool.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID)
	return err
}

// SetTenant associates a session with a tenant. Retained for completeness;
// per-request tenant resolution is header-based, so this is no longer on the
// hot path.
func SetTenant(ctx context.Context, pool *pgxpool.Pool, sessID, tenantID uuid.UUID) error {
	_, err := pool.Exec(ctx, `UPDATE sessions SET tenant_id = $1 WHERE id = $2`, tenantID, sessID)
	return err
}

// --- token_version (global-logout enforcement) -------------------------------

// Kept short: this TTL is the maximum window a revoked user (logout-all,
// account deletion, removed platform admin) keeps working on instances other
// than the one that processed the revocation.
const tokenVersionCacheTTL = 10 * time.Second

type tvEntry struct {
	version int
	fetched time.Time
}

var (
	tvMu    sync.RWMutex
	tvCache = map[uuid.UUID]tvEntry{}
)

// GetTokenVersion returns the user's current token_version, cached in-process
// for tokenVersionCacheTTL so the per-request `tv` check in BearerMiddleware is
// a map hit rather than a DB round-trip on the hot path.
func GetTokenVersion(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID) (int, error) {
	tvMu.RLock()
	e, ok := tvCache[userID]
	tvMu.RUnlock()
	if ok && time.Since(e.fetched) < tokenVersionCacheTTL {
		return e.version, nil
	}
	var v int
	if err := pool.QueryRow(ctx, `SELECT token_version FROM users WHERE id = $1`, userID).Scan(&v); err != nil {
		return 0, err
	}
	tvMu.Lock()
	tvCache[userID] = tvEntry{version: v, fetched: time.Now()}
	tvMu.Unlock()
	return v, nil
}

// BumpTokenVersion increments the user's token_version, invalidating every
// outstanding access token for them (within the cache TTL). The break-glass
// primitive behind logout-all and GDPR account deletion.
func BumpTokenVersion(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID) (int, error) {
	var v int
	if err := pool.QueryRow(ctx,
		`UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version`,
		userID).Scan(&v); err != nil {
		return 0, err
	}
	tvMu.Lock()
	tvCache[userID] = tvEntry{version: v, fetched: time.Now()}
	tvMu.Unlock()
	return v, nil
}

// --- user lookup -------------------------------------------------------------

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
