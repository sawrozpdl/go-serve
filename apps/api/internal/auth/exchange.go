package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// handoffTTL is how long a Google login handoff code is valid. Short — it's
// consumed by the SPA immediately on landing at /auth/callback.
const handoffTTL = 60 * time.Second

// CreateHandoffCode mints a single-use code for the OAuth → SPA token handoff.
// The Google callback can't return JSON (it's a redirect), so it stores this
// code and redirects to the SPA, which exchanges it for tokens via /auth/exchange.
func CreateHandoffCode(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, ip string) (rawCode string, err error) {
	raw, hash, err := newToken()
	if err != nil {
		return "", err
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_handoff (code_hash, user_id, created_ip, expires_at)
		VALUES ($1, $2, $3, $4)
	`, hash, userID, nullIfEmpty(ip), time.Now().Add(handoffTTL)); err != nil {
		return "", err
	}
	return raw, nil
}

// consumeHandoffCode validates + single-use-consumes a handoff code, returning
// the user it was minted for. Locked FOR UPDATE so a code can't be redeemed twice.
func consumeHandoffCode(ctx context.Context, pool *pgxpool.Pool, rawCode string) (userID uuid.UUID, err error) {
	hash := hashToken(rawCode)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		id         uuid.UUID
		uid        uuid.UUID
		expiresAt  time.Time
		consumedAt *time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT id, user_id, expires_at, consumed_at
		FROM auth_handoff WHERE code_hash = $1 FOR UPDATE
	`, hash).Scan(&id, &uid, &expiresAt, &consumedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrRefreshInvalid
	}
	if err != nil {
		return uuid.Nil, err
	}
	if consumedAt != nil || time.Now().After(expiresAt) {
		return uuid.Nil, ErrRefreshInvalid
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_handoff SET consumed_at = now() WHERE id = $1`, id); err != nil {
		return uuid.Nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return uid, nil
}

// ExchangeHandler swaps a one-time Google handoff code for an access+refresh
// token pair.
//
//	POST /auth/exchange  { "code": "..." }
func ExchangeHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Code) == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "code required")
			return
		}
		userID, err := consumeHandoffCode(r.Context(), pool, strings.TrimSpace(body.Code))
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "code_invalid", "login code invalid or expired")
			return
		}
		if err := IssueTokensForUser(r.Context(), pool, w, userID, r.RemoteAddr, r.UserAgent()); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "token mint failed")
		}
	}
}
