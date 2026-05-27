package auth

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// AuthEventKind is a fixed set of pre-tenant auth events recorded via slog
// so SIEM / log aggregators get a stable schema. Tenant-scoped events
// (workspace selection, role changes) are written to the audit_log table
// via the audit package instead.
type AuthEventKind string

const (
	AuthLoginSuccess AuthEventKind = "auth.login.success"
	AuthLoginFailure AuthEventKind = "auth.login.failure"
	AuthLogout       AuthEventKind = "auth.logout"
	AuthOTPRequest   AuthEventKind = "auth.otp.request"
	AuthOTPRateLimit AuthEventKind = "auth.otp.rate_limited"
)

// LogAuthEvent emits a structured slog record. The record carries the
// stable fields we want in every centralized log entry for auth: kind,
// method, email (lowercased, hashable downstream), user_id (when known),
// remote_ip, user_agent, and a free-form `reason` for failures.
//
// Use the request's logger when available so the entry inherits req_id +
// path; otherwise fall back to the default logger.
func LogAuthEvent(
	ctx context.Context,
	kind AuthEventKind,
	method, email string,
	userID *uuid.UUID,
	remoteIP, userAgent, reason string,
) {
	log := appctx.Logger(ctx)
	if log == nil {
		log = slog.Default()
	}
	args := []any{
		"kind", string(kind),
		"method", method,
		"email", strings.ToLower(strings.TrimSpace(email)),
	}
	if userID != nil && *userID != uuid.Nil {
		args = append(args, "user_id", userID.String())
	}
	if remoteIP != "" {
		args = append(args, "remote_ip", remoteIP)
	}
	if userAgent != "" {
		args = append(args, "user_agent", userAgent)
	}
	if reason != "" {
		args = append(args, "reason", reason)
	}
	if kind == AuthLoginFailure || kind == AuthOTPRateLimit {
		log.WarnContext(ctx, string(kind), args...)
		return
	}
	log.InfoContext(ctx, string(kind), args...)
}

// RemoteIP plucks the client IP off the request, preferring chi's
// RealIP middleware result via RemoteAddr.
func RemoteIP(r *http.Request) string {
	return r.RemoteAddr
}
