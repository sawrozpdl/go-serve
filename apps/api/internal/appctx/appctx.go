// Package appctx holds the request-scoped values shared across middleware:
// the active database transaction, the resolved tenant, and the resolved user.
package appctx

import (
	"context"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ctxKey int

const (
	txKey ctxKey = iota
	tenantKey
	userKey
	sessionKey
	loggerKey
	requestIDKey
	ipKey
	rolesKey
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

// WithRequestID stashes the chi request id so audit rows can include it
// without taking *http.Request.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestID returns the request id if one was attached.
func RequestID(ctx context.Context) (string, bool) {
	s, ok := ctx.Value(requestIDKey).(string)
	return s, ok
}

// WithIP stashes the originating IP (already resolved by middleware.RealIP)
// so audit rows can include it without taking *http.Request.
func WithIP(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, ipKey, ip)
}

// IP returns the originating IP if one was attached.
func IP(ctx context.Context) (string, bool) {
	s, ok := ctx.Value(ipKey).(string)
	return s, ok
}

// WithRoles stashes the active member's roles on the resolved tenant so
// later handlers (audit logging in particular) don't need the *http.Request
// to read the X-Tenant-Roles header.
func WithRoles(ctx context.Context, roles []string) context.Context {
	return context.WithValue(ctx, rolesKey, roles)
}

// Roles returns the active member's roles, if RequireMember resolved them.
func Roles(ctx context.Context) ([]string, bool) {
	rs, ok := ctx.Value(rolesKey).([]string)
	return rs, ok
}

// WithLogger stashes a request-scoped logger (typically pre-tagged with
// req_id, method, path, tenant, user) so handlers can `appctx.Logger(ctx)`
// without re-deriving those fields.
func WithLogger(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey, l)
}

// Logger returns the request-scoped logger if one was attached, falling back
// to slog.Default() so callers never have to nil-check.
func Logger(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerKey).(*slog.Logger); ok && l != nil {
		return l
	}
	return slog.Default()
}
