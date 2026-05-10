// Package appctx holds the request-scoped values shared across middleware:
// the active database transaction, the resolved tenant, and the resolved user.
package appctx

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ctxKey int

const (
	txKey ctxKey = iota
	tenantKey
	userKey
	sessionKey
)

// Tenant is the minimal slice of a tenant carried on every request.
type Tenant struct {
	ID       uuid.UUID
	Slug     string
	Name     string
	Timezone string
}

// User is the slice of a user carried on every request.
type User struct {
	ID    uuid.UUID
	Email string
	Name  string
}

// Session is the active session data.
type Session struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	TenantID  uuid.UUID // zero if no workspace picked yet
	ExpiresAt int64     // unix
}

func WithTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, txKey, tx)
}

// Tx returns the request-scoped transaction. Panics if missing — callers
// must mount [TxMiddleware] before any handler that uses the database.
func Tx(ctx context.Context) pgx.Tx {
	tx, ok := ctx.Value(txKey).(pgx.Tx)
	if !ok {
		panic("appctx: no tx in context — TxMiddleware must wrap this handler")
	}
	return tx
}

func WithTenant(ctx context.Context, t Tenant) context.Context {
	return context.WithValue(ctx, tenantKey, t)
}

// TenantFromContext returns the tenant if one was resolved.
func TenantFromContext(ctx context.Context) (Tenant, bool) {
	t, ok := ctx.Value(tenantKey).(Tenant)
	return t, ok
}

// MustTenant panics if no tenant was resolved.
func MustTenant(ctx context.Context) Tenant {
	t, ok := TenantFromContext(ctx)
	if !ok {
		panic("appctx: no tenant in context")
	}
	return t
}

func WithUser(ctx context.Context, u User) context.Context {
	return context.WithValue(ctx, userKey, u)
}

func UserFromContext(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(userKey).(User)
	return u, ok
}

func WithSession(ctx context.Context, s Session) context.Context {
	return context.WithValue(ctx, sessionKey, s)
}

func SessionFromContext(ctx context.Context) (Session, bool) {
	s, ok := ctx.Value(sessionKey).(Session)
	return s, ok
}
