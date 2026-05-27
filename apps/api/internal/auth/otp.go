package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	netmail "net/mail"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
)

// OTPParams threads the env-tunable knobs from config into the handlers.
type OTPParams struct {
	CodeLength     int
	TTLSeconds     int
	ResendCooldown int
	MaxAttempts    int
	IPHourlyCap    int
}

// RequestOTPHandler issues a code for the supplied email and emails it.
//
//	POST /auth/request-otp
//	{ "email": "user@example.com" }
//
// Response is always shaped as success ({sent:true,...}) regardless of
// whether the email exists — never leak account presence. The send itself
// can still fail silently (mailer down, bad address) and that's by design.
func RequestOTPHandler(pool *pgxpool.Pool, mailer *mail.Mailer, p OTPParams, devMode bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
			return
		}
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid body")
			return
		}
		email, err := normalizeEmail(body.Email)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_email", "enter a valid email address")
			return
		}

		ctx := r.Context()
		log := appctx.Logger(ctx)

		// Cooldown: reject if the most-recent un-consumed code was issued
		// within the cooldown window. We compare timestamps in SQL so the
		// API and DB clocks don't drift apart.
		var lastCreated *time.Time
		err = pool.QueryRow(ctx, `
			SELECT created_at FROM email_otps
			WHERE email = $1 AND consumed_at IS NULL
			ORDER BY created_at DESC LIMIT 1
		`, email).Scan(&lastCreated)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			log.ErrorContext(ctx, "otp.request.lookup_failed", "err", err.Error(), "email", email)
			writeErr(w, http.StatusInternalServerError, "internal_error", "otp lookup failed")
			return
		}
		if lastCreated != nil {
			elapsed := time.Since(*lastCreated)
			if elapsed < time.Duration(p.ResendCooldown)*time.Second {
				retry := int((time.Duration(p.ResendCooldown)*time.Second - elapsed).Seconds())
				if retry < 1 {
					retry = 1
				}
				writeJSONErr(w, http.StatusTooManyRequests, map[string]any{
					"code":                "otp_cooldown",
					"message":             "Hold on — wait before requesting another code.",
					"retry_after_seconds": retry,
				})
				return
			}
		}

		// Per-IP cap over the trailing hour. Catches mass abuse from a
		// single host even when each individual email is under cooldown.
		ipStr, _ := appctx.IP(ctx)
		ip := stripPort(ipStr)
		if ip != "" && p.IPHourlyCap > 0 {
			var count int
			if err := pool.QueryRow(ctx, `
				SELECT count(*) FROM email_otps
				WHERE request_ip = $1 AND created_at > now() - interval '1 hour'
			`, ip).Scan(&count); err != nil {
				// IP-cap check is best-effort; log and continue rather than
				// blocking the user on a query that probably indicates a
				// deeper problem we'll catch on the next write below.
				log.ErrorContext(ctx, "otp.request.ip_cap_query_failed", "err", err.Error(), "ip", ip)
			} else if count >= p.IPHourlyCap {
				log.WarnContext(ctx, "otp.ip_throttle_rejected", "ip", ip, "count", count)
				LogAuthEvent(ctx, AuthOTPRateLimit, "email_otp", email, nil, r.RemoteAddr, r.UserAgent(), "ip_hourly_cap")
				writeJSONErr(w, http.StatusTooManyRequests, map[string]any{
					"code":    "otp_ip_throttle",
					"message": "Too many code requests from this network. Try again later.",
				})
				return
			}
		}

		code, err := generateOTPCode(p.CodeLength)
		if err != nil {
			log.ErrorContext(ctx, "otp.request.code_gen_failed", "err", err.Error())
			writeErr(w, http.StatusInternalServerError, "internal_error", "code generation failed")
			return
		}
		ttl := time.Duration(p.TTLSeconds) * time.Second

		// Supersede any prior un-consumed row and insert the new code in
		// one transaction so we never have two active codes for the same
		// email.
		tx, err := pool.Begin(ctx)
		if err != nil {
			log.ErrorContext(ctx, "otp.request.tx_begin_failed", "err", err.Error())
			writeErr(w, http.StatusInternalServerError, "internal_error", "tx begin failed")
			return
		}
		defer tx.Rollback(ctx)

		if _, err := tx.Exec(ctx,
			`UPDATE email_otps SET consumed_at = now()
			 WHERE email = $1 AND consumed_at IS NULL`, email); err != nil {
			log.ErrorContext(ctx, "otp.request.supersede_failed", "err", err.Error(), "email", email)
			writeErr(w, http.StatusInternalServerError, "internal_error", "otp supersede failed")
			return
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO email_otps (email, code_hash, expires_at, max_attempts, request_ip, request_ua)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, email, hashOTP(code), time.Now().Add(ttl), p.MaxAttempts, nullIfEmpty(ip), nullIfEmpty(r.UserAgent())); err != nil {
			log.ErrorContext(ctx, "otp.request.insert_failed", "err", err.Error(), "email", email)
			writeErr(w, http.StatusInternalServerError, "internal_error", "otp insert failed")
			return
		}
		if err := tx.Commit(ctx); err != nil {
			log.ErrorContext(ctx, "otp.request.commit_failed", "err", err.Error())
			writeErr(w, http.StatusInternalServerError, "internal_error", "tx commit failed")
			return
		}

		// Fire-and-forget delivery. The request returns immediately; SMTP
		// failures are logged but never bubble up to the client.
		if mailer != nil {
			go sendOTP(log, mailer, email, code, p.TTLSeconds/60)
		} else if devMode {
			// No mailer in dev — surface the code in the server log so the
			// developer can copy it. NEVER do this in prod (devMode guard).
			log.InfoContext(ctx, "otp.dev_code", "email", email, "code", code,
				"expires_in_seconds", p.TTLSeconds)
		} else {
			log.WarnContext(ctx, "otp.no_mailer_configured", "email", email)
		}

		LogAuthEvent(ctx, AuthOTPRequest, "email_otp", email, nil, r.RemoteAddr, r.UserAgent(), "")
		writeJSON(w, http.StatusOK, map[string]any{
			"sent":               true,
			"expires_in_seconds": p.TTLSeconds,
			"resend_in_seconds":  p.ResendCooldown,
		})
	}
}

// VerifyOTPHandler validates the code and starts a session on success.
//
//	POST /auth/verify-otp
//	{ "email": "user@example.com", "code": "123456" }
//
// On success: sets the session cookie and returns {user_id, session_id}.
// On failure: 401 otp_invalid with attempts_remaining when applicable.
func VerifyOTPHandler(pool *pgxpool.Pool, p OTPParams, rootDomain string, secureCookies bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
			return
		}
		var body struct {
			Email string `json:"email"`
			Code  string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid body")
			return
		}
		email, err := normalizeEmail(body.Email)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_email", "enter a valid email address")
			return
		}
		code := strings.TrimSpace(body.Code)
		if code == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "code required")
			return
		}

		ctx := r.Context()
		log := appctx.Logger(ctx)

		// Most recent active (un-consumed, non-expired) row for this
		// email. ORDER BY created_at handles the rare case where a stale
		// row exists alongside a just-inserted one.
		var id uuid.UUID
		var storedHash string
		var attempts, maxAttempts int
		var expiresAt time.Time
		err = pool.QueryRow(ctx, `
			SELECT id, code_hash, attempts, max_attempts, expires_at
			FROM email_otps
			WHERE email = $1 AND consumed_at IS NULL AND expires_at > now()
			ORDER BY created_at DESC LIMIT 1
		`, email).Scan(&id, &storedHash, &attempts, &maxAttempts, &expiresAt)
		if errors.Is(err, pgx.ErrNoRows) {
			log.InfoContext(ctx, "otp.verify_no_active_code", "email", email)
			LogAuthEvent(ctx, AuthLoginFailure, "email_otp", email, nil, r.RemoteAddr, r.UserAgent(), "no_active_code")
			writeJSONErr(w, http.StatusUnauthorized, map[string]any{
				"code":    "otp_invalid",
				"message": "That code isn't valid or has expired — request a new one.",
			})
			return
		}
		if err != nil {
			log.ErrorContext(ctx, "otp.verify.lookup_failed", "err", err.Error(), "email", email)
			writeErr(w, http.StatusInternalServerError, "internal_error", "otp lookup failed")
			return
		}

		match := subtle.ConstantTimeCompare([]byte(hashOTP(code)), []byte(storedHash)) == 1
		if !match {
			// Bump attempts; force-consume on cap so a 6th-try-with-correct
			// code can't get past the wall.
			newAttempts := attempts + 1
			if newAttempts >= maxAttempts {
				_, _ = pool.Exec(ctx,
					`UPDATE email_otps SET attempts = $1, consumed_at = now() WHERE id = $2`,
					newAttempts, id)
			} else {
				_, _ = pool.Exec(ctx,
					`UPDATE email_otps SET attempts = $1 WHERE id = $2`,
					newAttempts, id)
			}
			remaining := maxAttempts - newAttempts
			if remaining < 0 {
				remaining = 0
			}
			log.InfoContext(ctx, "otp.verify_bad_code", "email", email, "attempts", newAttempts, "remaining", remaining)
			LogAuthEvent(ctx, AuthLoginFailure, "email_otp", email, nil, r.RemoteAddr, r.UserAgent(), "bad_code")
			writeJSONErr(w, http.StatusUnauthorized, map[string]any{
				"code":               "otp_invalid",
				"message":            "That code isn't right.",
				"attempts_remaining": remaining,
			})
			return
		}

		// Mark consumed before creating the session — single-use guarantee.
		if _, err := pool.Exec(ctx,
			`UPDATE email_otps SET consumed_at = now() WHERE id = $1`, id); err != nil {
			log.ErrorContext(ctx, "otp.verify.consume_failed", "err", err.Error(), "otp_id", id)
			writeErr(w, http.StatusInternalServerError, "internal_error", "otp consume failed")
			return
		}

		userID, err := LookupOrCreateUser(ctx, pool, "", email, "", "")
		if err != nil {
			log.ErrorContext(ctx, "otp.verify.user_upsert_failed", "err", err.Error(), "email", email)
			writeErr(w, http.StatusInternalServerError, "internal_error", "user upsert failed")
			return
		}
		_, _ = AcceptPendingInvites(ctx, pool, userID, email)

		token, sessID, err := CreateSession(ctx, pool, userID, r.RemoteAddr, r.UserAgent())
		if err != nil {
			log.ErrorContext(ctx, "otp.verify.session_create_failed", "err", err.Error(), "user_id", userID)
			writeErr(w, http.StatusInternalServerError, "internal_error", "session create failed")
			return
		}
		SetCookie(w, token, rootDomain, secureCookies)

		log.InfoContext(ctx, "otp.verify_ok", "email", email, "user_id", userID, "session_id", sessID)
		LogAuthEvent(ctx, AuthLoginSuccess, "email_otp", email, &userID, r.RemoteAddr, r.UserAgent(), "")
		writeJSON(w, http.StatusOK, map[string]any{
			"user_id":    userID,
			"session_id": sessID,
		})
	}
}

func generateOTPCode(length int) (string, error) {
	if length < 4 {
		length = 4
	}
	if length > 8 {
		length = 8
	}
	// 10^length upper bound, then zero-pad to `length` digits.
	max := big.NewInt(1)
	for i := 0; i < length; i++ {
		max.Mul(max, big.NewInt(10))
	}
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%0*d", length, n.Int64()), nil
}

func hashOTP(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

func normalizeEmail(s string) (string, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return "", errors.New("empty email")
	}
	if _, err := netmail.ParseAddress(s); err != nil {
		return "", err
	}
	return s, nil
}

func stripPort(s string) string {
	if s == "" {
		return ""
	}
	// net.SplitHostPort fails for bare IPs / hostnames, so try first and
	// fall through on error.
	if i := strings.LastIndex(s, ":"); i > 0 && strings.Count(s, ":") == 1 {
		return s[:i]
	}
	// IPv6 in [::1]:port form
	if strings.HasPrefix(s, "[") {
		if end := strings.Index(s, "]"); end > 0 {
			return s[1:end]
		}
	}
	return s
}

func sendOTP(log interface {
	Error(string, ...any)
	Info(string, ...any)
}, mailer *mail.Mailer, to, code string, ttlMinutes int) {
	defer func() {
		if r := recover(); r != nil {
			log.Error("otp.send_panic", "panic", r)
		}
	}()
	msg := mail.BuildOTPMessage(mail.OTPEmail{
		To:         to,
		Code:       code,
		TTLMinutes: ttlMinutes,
	})
	if err := mailer.Send(msg); err != nil {
		log.Error("otp.send_failed", "err", err, "to", to)
		return
	}
	log.Info("otp.sent", "to", to)
}

// writeJSONErr writes a structured JSON error with optional extra fields
// (retry_after_seconds, attempts_remaining, …). The base writeErr only
// supports {code, message}.
func writeJSONErr(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
