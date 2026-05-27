package auth

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// wsTicketTTL is how long a WebSocket ticket is valid. The SPA fetches one and
// connects immediately, so the window is short.
const wsTicketTTL = 60 * time.Second

// CreateWSTicket mints a single-use ticket for a (user, tenant) so the browser
// WebSocket — which can't send an Authorization header — can authenticate
// without putting a bearer token in the URL / proxy logs.
func CreateWSTicket(ctx context.Context, pool *pgxpool.Pool, userID, tenantID uuid.UUID) (rawTicket string, err error) {
	raw, hash, err := newToken()
	if err != nil {
		return "", err
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ws_tickets (ticket_hash, user_id, tenant_id, expires_at)
		VALUES ($1, $2, $3, $4)
	`, hash, userID, tenantID, time.Now().Add(wsTicketTTL)); err != nil {
		return "", err
	}
	return raw, nil
}

// ConsumeWSTicket validates + single-use-consumes a WS ticket, returning the
// user and tenant it authorizes.
func ConsumeWSTicket(ctx context.Context, pool *pgxpool.Pool, rawTicket string) (userID, tenantID uuid.UUID, err error) {
	hash := hashToken(rawTicket)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		id         uuid.UUID
		uid        uuid.UUID
		tid        uuid.UUID
		expiresAt  time.Time
		consumedAt *time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT id, user_id, tenant_id, expires_at, consumed_at
		FROM ws_tickets WHERE ticket_hash = $1 FOR UPDATE
	`, hash).Scan(&id, &uid, &tid, &expiresAt, &consumedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, ErrRefreshInvalid
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if consumedAt != nil || time.Now().After(expiresAt) {
		return uuid.Nil, uuid.Nil, ErrRefreshInvalid
	}
	if _, err = tx.Exec(ctx, `UPDATE ws_tickets SET consumed_at = now() WHERE id = $1`, id); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return uid, tid, nil
}
