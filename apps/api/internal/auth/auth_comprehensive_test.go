package auth

// auth_comprehensive_test.go — exhaustive tests for the internal/auth package.
//
// Layout
//   ── Pure / crypto (no DB) ──────────────────────────────────────────────────
//     JWT: SetTokenConfig, MintAccessToken, ParseAccessToken (all error paths)
//     Token helpers: newToken, hashToken, hashOTP, nullIfEmpty
//     OTP helpers: generateOTPCode, normalizeEmail, stripPort
//     Platform allowlist: SetPlatformAllowlist, inAllowlist
//     bearerToken extractor
//     ConfigHandler
//
//   ── Middleware (httptest, no DB required except BearerMiddleware tv check) ──
//     BearerMiddleware: no header, bad token, expired, wrong alg, tv-mismatch
//     RequireAuth: unauthenticated, authenticated pass-through
//     Require / RequireAny: missing/granted permissions
//     HasPermission / HasAnyPermission
//
//   ── DB-backed integration (skip when no DB) ─────────────────────────────────
//     Session: CreateSession, Revoke, RevokeAllForUser, RevokeByRefreshToken
//     RotateRefresh: normal rotation, grace replay, reuse → chain revocation
//     GetTokenVersion / BumpTokenVersion (cache coverage)
//     WSTicket: create → consume, double-consume, expired
//     Handoff: CreateHandoffCode → consumeHandoffCode, double-consume, expired
//     IssueTokensForUser / writeTokenPair round-trip
//     RefreshHandler HTTP: missing body, invalid token, reuse, DB error → 500
//     LogoutHandler HTTP: by refresh token, by bearer sid
//     LogoutAllHandler HTTP: revoke all + bump version
//     DevLoginHandler HTTP: success, method-not-allowed, missing email
//     ExchangeHandler HTTP: success, missing code, invalid code
//     SyncPlatformAdmin: non-allowlisted, allowlisted
//     RequirePlatformAdmin HTTP: not-admin, DB-admin, allowlist-only admin
//     OTP lifecycle: request → cooldown → wrong code → max-attempts lockout
//                    → correct code → consumed (+ IP-cap path)

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// ─────────────────────────────────────────────────────────────────────────────
// TestMain – load .env so DATABASE_URL is available when running `go test ./...`
// ─────────────────────────────────────────────────────────────────────────────

func TestMain(m *testing.M) {
	loadAuthDotEnv()
	os.Exit(m.Run())
}

func loadAuthDotEnv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	var envPath string
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			envPath = filepath.Join(dir, ".env")
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if envPath == "" {
		return
	}
	f, err := os.Open(envPath)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if key == "" {
			continue
		}
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, val)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers shared across tests
// ─────────────────────────────────────────────────────────────────────────────

// freshPool returns a superuser pool, skipping when no DB is reachable.
// Reuses the same env-var convention as refresh_db_test.go's dbPool helper.
func freshPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = os.Getenv("APP_DATABASE_URL")
	}
	if url == "" {
		t.Skip("DATABASE_URL/APP_DATABASE_URL not set; skipping DB integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("freshPool: new: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("freshPool: ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// insertTestUser creates a minimal user row and registers cleanup.
func insertTestUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	email := "auth-test-" + uuid.NewString()[:8] + "@test.local"
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (email, name) VALUES ($1, 'Auth Test') RETURNING id`, email).Scan(&id); err != nil {
		t.Fatalf("insertTestUser: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// insertTestTenant creates a minimal tenant and returns its ID.
func insertTestTenant(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	slug := "auth-tenant-" + uuid.NewString()[:8]
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO tenants (slug, name) VALUES ($1, 'Auth Test Tenant') RETURNING id`, slug).Scan(&id); err != nil {
		t.Fatalf("insertTestTenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id
}

// mintValidToken mints a fresh valid access token using the test key.
func mintValidToken(t *testing.T, uid uuid.UUID, tv int) string {
	t.Helper()
	tok, _, err := MintAccessToken(uid, "user@test.local", "Test User", uuid.New(), tv)
	if err != nil {
		t.Fatalf("mintValidToken: %v", err)
	}
	return tok
}

// okHandler is a trivial http.Handler that records whether it was called.
type okHandler struct{ called bool }

func (h *okHandler) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	h.called = true
	w.WriteHeader(http.StatusOK)
}

// jsonBody serialises v and returns an io.Reader for use in http.NewRequest.
func jsonBody(v any) *bytes.Buffer {
	b, _ := json.Marshal(v)
	return bytes.NewBuffer(b)
}

// ─────────────────────────────────────────────────────────────────────────────
// SetTokenConfig
// ─────────────────────────────────────────────────────────────────────────────

func TestSetTokenConfig_EmptySecretKeepsExisting(t *testing.T) {
	// The init() in jwt_test.go already set the key; calling with empty string
	// must not overwrite it.
	prev := string(tokenSigningKey)
	SetTokenConfig("", 0, 0)
	if string(tokenSigningKey) != prev {
		t.Fatal("empty secret should not overwrite existing key")
	}
}

func TestSetTokenConfig_ZeroTTLsKeepExisting(t *testing.T) {
	prevAccess := accessTokenTTL
	prevRefresh := refreshTokenTTL
	SetTokenConfig("", 0, 0)
	if accessTokenTTL != prevAccess || refreshTokenTTL != prevRefresh {
		t.Fatal("zero TTLs should not overwrite existing durations")
	}
}

func TestSetTokenConfig_OverridesAll(t *testing.T) {
	SetTokenConfig("new-test-key-at-least-32-bytes-long!!", 5*time.Minute, 7*24*time.Hour)
	if string(tokenSigningKey) != "new-test-key-at-least-32-bytes-long!!" {
		t.Fatal("key not updated")
	}
	if accessTokenTTL != 5*time.Minute {
		t.Fatal("accessTokenTTL not updated")
	}
	if refreshTokenTTL != 7*24*time.Hour {
		t.Fatal("refreshTokenTTL not updated")
	}
	// Restore for subsequent tests.
	SetTokenConfig("test-signing-key-at-least-32-bytes-long!!", 15*time.Minute, 30*24*time.Hour)
}

func TestRefreshTTL(t *testing.T) {
	if RefreshTTL() <= 0 {
		t.Fatal("RefreshTTL should be positive")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT: additional ParseAccessToken coverage beyond jwt_test.go
// ─────────────────────────────────────────────────────────────────────────────

func TestParseAccessToken_MalformedToken(t *testing.T) {
	cases := []string{"", "not.a.jwt", "eyJhbGciOiJIUzI1NiJ9", "a.b.c.d.e"}
	for _, raw := range cases {
		if _, err := ParseAccessToken(raw); err == nil {
			t.Errorf("expected error for malformed token %q", raw)
		}
	}
}

func TestParseAccessToken_WrongSecret(t *testing.T) {
	// Mint with a different key, then verify with the test key.
	wrongKey := []byte("wrong-key-wrong-key-wrong-key!!!")
	uid := uuid.New()
	sid := uuid.New()
	claims := AccessClaims{
		Email: "bad@actor.com",
		TV:    0,
		SID:   sid.String(),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uid.String(),
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	raw, _ := tok.SignedString(wrongKey)
	if _, err := ParseAccessToken(raw); err == nil {
		t.Fatal("expected error for token signed with wrong key")
	}
}

func TestParseAccessToken_NotYetValid(t *testing.T) {
	uid := uuid.New()
	future := time.Now().Add(1 * time.Hour)
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uid.String(),
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(future),
			ExpiresAt: jwt.NewNumericDate(future.Add(time.Hour)),
		},
	})
	raw, _ := tok.SignedString(tokenSigningKey)
	// nbf is 1hr in the future; leeway is 30s so it should still fail.
	if _, err := ParseAccessToken(raw); err == nil {
		t.Fatal("expected error for not-yet-valid token")
	}
}

func TestParseAccessToken_ClaimsPopulated(t *testing.T) {
	uid := uuid.New()
	sid := uuid.New()
	tok, _, err := MintAccessToken(uid, "claims@test.local", "Claims User", sid, 7)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	c, err := ParseAccessToken(tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if c.Email != "claims@test.local" {
		t.Errorf("email: got %q", c.Email)
	}
	if c.Name != "Claims User" {
		t.Errorf("name: got %q", c.Name)
	}
	if c.TV != 7 {
		t.Errorf("tv: got %d", c.TV)
	}
	if c.SID != sid.String() {
		t.Errorf("sid: got %q want %q", c.SID, sid.String())
	}
	if c.Subject != uid.String() {
		t.Errorf("sub: got %q want %q", c.Subject, uid.String())
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Token helpers
// ─────────────────────────────────────────────────────────────────────────────

func TestNewToken_Uniqueness(t *testing.T) {
	raw1, hash1, err1 := newToken()
	raw2, hash2, err2 := newToken()
	if err1 != nil || err2 != nil {
		t.Fatalf("newToken errors: %v %v", err1, err2)
	}
	if raw1 == raw2 {
		t.Fatal("newToken produced identical raws")
	}
	if hash1 == hash2 {
		t.Fatal("newToken produced identical hashes")
	}
}

func TestNewToken_HashMatchesRaw(t *testing.T) {
	raw, hash, err := newToken()
	if err != nil {
		t.Fatalf("newToken: %v", err)
	}
	if hashToken(raw) != hash {
		t.Fatal("hashToken(raw) != returned hash")
	}
}

func TestHashToken_Deterministic(t *testing.T) {
	h1 := hashToken("some-fixed-token")
	h2 := hashToken("some-fixed-token")
	if h1 != h2 {
		t.Fatal("hashToken not deterministic")
	}
	if h1 == "some-fixed-token" {
		t.Fatal("hashToken returned raw unchanged")
	}
}

func TestHashToken_DifferentInputs(t *testing.T) {
	if hashToken("aaa") == hashToken("bbb") {
		t.Fatal("hashToken collision for different inputs")
	}
}

func TestNullIfEmpty(t *testing.T) {
	if nullIfEmpty("") != nil {
		t.Fatal("nullIfEmpty(\"\") should return nil")
	}
	if nullIfEmpty("x") != any("x") {
		t.Fatal("nullIfEmpty(\"x\") should return \"x\"")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// OTP helpers: generateOTPCode, hashOTP, normalizeEmail, stripPort
// ─────────────────────────────────────────────────────────────────────────────

func TestGenerateOTPCode_Length(t *testing.T) {
	for _, l := range []int{4, 5, 6, 7, 8} {
		code, err := generateOTPCode(l)
		if err != nil {
			t.Fatalf("generateOTPCode(%d): %v", l, err)
		}
		if len(code) != l {
			t.Errorf("generateOTPCode(%d): got len %d", l, len(code))
		}
		for _, ch := range code {
			if ch < '0' || ch > '9' {
				t.Errorf("generateOTPCode(%d): non-digit char %q", l, ch)
			}
		}
	}
}

func TestGenerateOTPCode_ClampMin(t *testing.T) {
	// length < 4 should be clamped to 4
	code, err := generateOTPCode(1)
	if err != nil {
		t.Fatalf("generateOTPCode(1): %v", err)
	}
	if len(code) != 4 {
		t.Errorf("expected len 4 (clamped), got %d", len(code))
	}
}

func TestGenerateOTPCode_ClampMax(t *testing.T) {
	// length > 8 should be clamped to 8
	code, err := generateOTPCode(20)
	if err != nil {
		t.Fatalf("generateOTPCode(20): %v", err)
	}
	if len(code) != 8 {
		t.Errorf("expected len 8 (clamped), got %d", len(code))
	}
}

func TestGenerateOTPCode_Uniqueness(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 20; i++ {
		code, err := generateOTPCode(6)
		if err != nil {
			t.Fatalf("generateOTPCode: %v", err)
		}
		// Not guaranteed unique (math), just checking it produces varied output.
		seen[code] = true
	}
	if len(seen) < 3 {
		t.Errorf("generateOTPCode suspiciously low variety: %v", seen)
	}
}

func TestHashOTP_Deterministic(t *testing.T) {
	h1 := hashOTP("123456")
	h2 := hashOTP("123456")
	if h1 != h2 {
		t.Fatal("hashOTP not deterministic")
	}
}

func TestHashOTP_DifferentCodes(t *testing.T) {
	if hashOTP("123456") == hashOTP("654321") {
		t.Fatal("hashOTP collision")
	}
}

func TestNormalizeEmail_Valid(t *testing.T) {
	cases := []struct{ in, want string }{
		{"user@example.com", "user@example.com"},
		{"  User@Example.COM  ", "user@example.com"},
		{"USER@DOMAIN.ORG", "user@domain.org"},
	}
	for _, c := range cases {
		got, err := normalizeEmail(c.in)
		if err != nil {
			t.Errorf("normalizeEmail(%q): unexpected error: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("normalizeEmail(%q): got %q want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeEmail_Invalid(t *testing.T) {
	cases := []string{"", "   ", "not-an-email", "@nodomain", "user@", "user@@double.com"}
	for _, c := range cases {
		if _, err := normalizeEmail(c); err == nil {
			t.Errorf("normalizeEmail(%q): expected error", c)
		}
	}
}

func TestStripPort(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"192.168.1.1", "192.168.1.1"},
		{"192.168.1.1:8080", "192.168.1.1"},
		{"[::1]:5000", "::1"},
		{"::1", "::1"},
		{"localhost:9090", "localhost"},
	}
	for _, c := range cases {
		got := stripPort(c.in)
		if got != c.want {
			t.Errorf("stripPort(%q): got %q want %q", c.in, got, c.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform allowlist
// ─────────────────────────────────────────────────────────────────────────────

func TestSetPlatformAllowlist_BasicOps(t *testing.T) {
	t.Cleanup(func() { SetPlatformAllowlist(nil) }) // restore

	SetPlatformAllowlist([]string{"Admin@Example.COM", "  super@test.local  ", ""})
	if !inAllowlist("admin@example.com") {
		t.Error("admin@example.com should be in allowlist")
	}
	if !inAllowlist("ADMIN@EXAMPLE.COM") {
		t.Error("case-insensitive check failed")
	}
	if !inAllowlist("super@test.local") {
		t.Error("super@test.local should be in allowlist")
	}
	if inAllowlist("other@example.com") {
		t.Error("other@example.com should not be in allowlist")
	}
}

func TestSetPlatformAllowlist_EmptyInput(t *testing.T) {
	SetPlatformAllowlist([]string{"admin@example.com"})
	SetPlatformAllowlist(nil)
	if inAllowlist("admin@example.com") {
		t.Error("allowlist should be cleared after SetPlatformAllowlist(nil)")
	}
}

func TestInAllowlist_EmptyEmail(t *testing.T) {
	SetPlatformAllowlist([]string{"admin@example.com"})
	if inAllowlist("") {
		t.Error("empty email should never match")
	}
	SetPlatformAllowlist(nil)
}

func TestSetPlatformAllowlist_Idempotent(t *testing.T) {
	defer SetPlatformAllowlist(nil)
	SetPlatformAllowlist([]string{"a@b.com"})
	SetPlatformAllowlist([]string{"a@b.com"})
	if !inAllowlist("a@b.com") {
		t.Error("idempotent set broke the allowlist")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// bearerToken extractor
// ─────────────────────────────────────────────────────────────────────────────

func TestBearerToken_Extraction(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"Bearer abc123", "abc123"},
		{"bearer abc123", "abc123"},
		{"BEARER abc123", "abc123"},
		{"Bearer  spaced  ", "spaced"},
		{"", ""},
		{"Basic abc123", ""},
		{"abc123", ""},
		{"Bearer", ""},
	}
	for _, c := range cases {
		r := &http.Request{Header: http.Header{}}
		if c.header != "" {
			r.Header.Set("Authorization", c.header)
		}
		if got := bearerToken(r); got != c.want {
			t.Errorf("bearerToken(%q): got %q want %q", c.header, got, c.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfigHandler
// ─────────────────────────────────────────────────────────────────────────────

func TestConfigHandler_ResponseShape(t *testing.T) {
	cases := []struct {
		google, dev, otp bool
	}{
		{true, false, true},
		{false, true, false},
		{false, false, false},
	}
	for _, c := range cases {
		h := ConfigHandler(c.google, c.dev, c.otp)
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/auth/config", nil)
		h(w, r)

		if w.Code != http.StatusOK {
			t.Errorf("status: got %d", w.Code)
		}
		var body struct {
			GoogleEnabled   bool `json:"google_enabled"`
			DevLoginEnabled bool `json:"dev_login_enabled"`
			EmailOtpEnabled bool `json:"email_otp_enabled"`
		}
		if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body.GoogleEnabled != c.google || body.DevLoginEnabled != c.dev || body.EmailOtpEnabled != c.otp {
			t.Errorf("mismatch: got %+v want %+v", body, c)
		}
	}
}

func TestConfigHandler_ContentType(t *testing.T) {
	h := ConfigHandler(false, false, false)
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodGet, "/auth/config", nil))
	ct := w.Header().Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("content-type: got %q", ct)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: BearerMiddleware (pure — no DB for most cases)
// ─────────────────────────────────────────────────────────────────────────────

// mockPool is a pgxpool.Pool stand-in for middleware that normally never hits
// the DB when the token is invalid / missing. Since Go doesn't let us mock the
// pool interface directly, we pass nil and rely on the middleware bailing out
// before the DB call for invalid tokens.
//
// For the tv-version path we need a real pool, so those are in DB tests below.

func TestBearerMiddleware_NoHeader(t *testing.T) {
	inner := &okHandler{}
	// nil pool is safe here — bearer is empty so we never reach GetTokenVersion
	h := BearerMiddleware(nil)(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	h.ServeHTTP(w, r)
	if !inner.called {
		t.Fatal("inner handler should be called when no Authorization header")
	}
	if _, ok := appctx.UserFromContext(r.Context()); ok {
		t.Fatal("user should not be set in context when no header")
	}
}

func TestBearerMiddleware_InvalidToken(t *testing.T) {
	inner := &okHandler{}
	h := BearerMiddleware(nil)(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer not.a.valid.jwt")
	h.ServeHTTP(w, r)
	if !inner.called {
		t.Fatal("inner handler should be called (middleware is permissive)")
	}
	// Context must NOT have user set.
	if _, ok := appctx.UserFromContext(r.Context()); ok {
		t.Fatal("user should not be set for invalid token")
	}
}

func TestBearerMiddleware_ExpiredToken(t *testing.T) {
	inner := &okHandler{}
	h := BearerMiddleware(nil)(inner)

	// Hand-craft an expired but validly-signed token.
	uid := uuid.New()
	sid := uuid.New()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, AccessClaims{
		Email: "x@y.com",
		TV:    1,
		SID:   sid.String(),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uid.String(),
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-3 * time.Hour)),
			NotBefore: jwt.NewNumericDate(time.Now().Add(-3 * time.Hour)),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)),
		},
	})
	raw, _ := tok.SignedString(tokenSigningKey)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+raw)
	h.ServeHTTP(w, r)
	if _, ok := appctx.UserFromContext(r.Context()); ok {
		t.Fatal("user should not be set for expired token")
	}
}

func TestBearerMiddleware_AlgNone_Rejected(t *testing.T) {
	inner := &okHandler{}
	h := BearerMiddleware(nil)(inner)

	tok := jwt.NewWithClaims(jwt.SigningMethodNone, AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uuid.New().String(),
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	})
	raw, _ := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+raw)
	h.ServeHTTP(w, r)
	if _, ok := appctx.UserFromContext(r.Context()); ok {
		t.Fatal("user should not be set for alg:none token")
	}
}

func TestBearerMiddleware_WrongIssuerAudience(t *testing.T) {
	inner := &okHandler{}
	h := BearerMiddleware(nil)(inner)

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uuid.New().String(),
			Issuer:    "evil-issuer",
			Audience:  jwt.ClaimStrings{"evil-aud"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	})
	raw, _ := tok.SignedString(tokenSigningKey)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+raw)
	h.ServeHTTP(w, r)
	if _, ok := appctx.UserFromContext(r.Context()); ok {
		t.Fatal("user should not be set for wrong iss/aud token")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// RequireAuth middleware
// ─────────────────────────────────────────────────────────────────────────────

func TestRequireAuth_Unauthenticated(t *testing.T) {
	inner := &okHandler{}
	h := RequireAuth(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/protected", nil)
	// Context has no user — BearerMiddleware was not run (or token was invalid).
	h.ServeHTTP(w, r)
	if inner.called {
		t.Fatal("inner handler should NOT be called without auth")
	}
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestRequireAuth_Authenticated(t *testing.T) {
	inner := &okHandler{}
	h := RequireAuth(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/protected", nil)
	// Inject a user directly (same as BearerMiddleware would do).
	ctx := appctx.WithUser(r.Context(), appctx.User{ID: uuid.New(), Email: "u@t.com"})
	h.ServeHTTP(w, r.WithContext(ctx))
	if !inner.called {
		t.Fatal("inner handler should be called with user in context")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Require / RequireAny / HasPermission / HasAnyPermission
// ─────────────────────────────────────────────────────────────────────────────

func ctxWithPermissions(parent context.Context, perms ...string) context.Context {
	set := make(map[string]struct{}, len(perms))
	for _, p := range perms {
		set[p] = struct{}{}
	}
	return appctx.WithPermissions(parent, set)
}

func TestRequire_MissingPermission(t *testing.T) {
	inner := &okHandler{}
	h := Require("menu:create")(inner)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/items", nil)
	// Populate permissions but without the required one.
	ctx := ctxWithPermissions(r.Context(), "order:create", "shift:open")
	h.ServeHTTP(w, r.WithContext(ctx))

	if inner.called {
		t.Fatal("inner should not be called without required permission")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status: got %d want %d", w.Code, http.StatusForbidden)
	}
}

func TestRequire_HasPermission(t *testing.T) {
	inner := &okHandler{}
	h := Require("menu:create")(inner)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/items", nil)
	ctx := ctxWithPermissions(r.Context(), "menu:create")
	h.ServeHTTP(w, r.WithContext(ctx))

	if !inner.called {
		t.Fatal("inner should be called with required permission")
	}
	if w.Code != http.StatusOK {
		t.Errorf("status: got %d want %d", w.Code, http.StatusOK)
	}
}

func TestRequire_NoPermissionContext(t *testing.T) {
	inner := &okHandler{}
	h := Require("menu:create")(inner)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/items", nil)
	// No permissions in context at all.
	h.ServeHTTP(w, r)
	if inner.called {
		t.Fatal("inner should not be called with no permission context")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status: got %d want %d", w.Code, http.StatusForbidden)
	}
}

func TestRequireAny_NoneHeld(t *testing.T) {
	inner := &okHandler{}
	h := RequireAny("menu:create", "menu:edit")(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	ctx := ctxWithPermissions(r.Context(), "order:create")
	h.ServeHTTP(w, r.WithContext(ctx))
	if inner.called {
		t.Fatal("inner should not be called when none of the required permissions are held")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status: got %d want %d", w.Code, http.StatusForbidden)
	}
}

func TestRequireAny_FirstHeld(t *testing.T) {
	inner := &okHandler{}
	h := RequireAny("menu:create", "menu:edit")(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	ctx := ctxWithPermissions(r.Context(), "menu:create")
	h.ServeHTTP(w, r.WithContext(ctx))
	if !inner.called {
		t.Fatal("inner should be called when first permission is held")
	}
}

func TestRequireAny_SecondHeld(t *testing.T) {
	inner := &okHandler{}
	h := RequireAny("menu:create", "menu:edit")(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	ctx := ctxWithPermissions(r.Context(), "menu:edit")
	h.ServeHTTP(w, r.WithContext(ctx))
	if !inner.called {
		t.Fatal("inner should be called when second permission is held")
	}
}

func TestHasPermission_True(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = r.WithContext(ctxWithPermissions(r.Context(), "shift:open"))
	if !HasPermission(r, "shift:open") {
		t.Fatal("HasPermission should return true")
	}
}

func TestHasPermission_False(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = r.WithContext(ctxWithPermissions(r.Context(), "shift:open"))
	if HasPermission(r, "menu:delete") {
		t.Fatal("HasPermission should return false for absent permission")
	}
}

func TestHasPermission_NoContext(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if HasPermission(r, "anything") {
		t.Fatal("HasPermission should return false when no permission context")
	}
}

func TestHasAnyPermission_OneHeld(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = r.WithContext(ctxWithPermissions(r.Context(), "shift:open"))
	if !HasAnyPermission(r, "menu:create", "shift:open") {
		t.Fatal("HasAnyPermission should return true when one perm matches")
	}
}

func TestHasAnyPermission_NoneHeld(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = r.WithContext(ctxWithPermissions(r.Context(), "shift:open"))
	if HasAnyPermission(r, "menu:create", "menu:edit") {
		t.Fatal("HasAnyPermission should return false when no perm matches")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: Session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

func TestCreateSession_Basic(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, sid, err := CreateSession(ctx, pool, uid, "127.0.0.1", "Go-Test/1.0")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if raw == "" {
		t.Fatal("expected non-empty raw token")
	}
	if sid == uuid.Nil {
		t.Fatal("expected non-nil session ID")
	}
	// Verify row exists in DB.
	var count int
	pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id = $1 AND revoked_at IS NULL`, sid).Scan(&count)
	if count != 1 {
		t.Fatalf("expected 1 active session row, got %d", count)
	}
}

func TestCreateSession_TokenHash_Stored(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, sid, _ := CreateSession(ctx, pool, uid, "", "")
	expected := hashToken(raw)
	var storedHash string
	pool.QueryRow(ctx, `SELECT token_hash FROM sessions WHERE id = $1`, sid).Scan(&storedHash)
	if storedHash != expected {
		t.Fatalf("stored hash mismatch: got %q want %q", storedHash, expected)
	}
}

func TestRevoke_Session(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	_, sid, _ := CreateSession(ctx, pool, uid, "", "")
	if err := Revoke(ctx, pool, sid); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	var revokedAt *time.Time
	pool.QueryRow(ctx, `SELECT revoked_at FROM sessions WHERE id = $1`, sid).Scan(&revokedAt)
	if revokedAt == nil {
		t.Fatal("expected revoked_at to be set")
	}
}

func TestRevokeAllForUser_RevokesAll(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	// Create 3 sessions.
	for i := 0; i < 3; i++ {
		if _, _, err := CreateSession(ctx, pool, uid, "", ""); err != nil {
			t.Fatalf("CreateSession[%d]: %v", i, err)
		}
	}
	if err := RevokeAllForUser(ctx, pool, uid); err != nil {
		t.Fatalf("RevokeAllForUser: %v", err)
	}
	var active int
	pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, uid).Scan(&active)
	if active != 0 {
		t.Fatalf("expected 0 active sessions, got %d", active)
	}
}

func TestRevokeByRefreshToken_Success(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, sid, _ := CreateSession(ctx, pool, uid, "", "")
	gotSid, gotUID, err := RevokeByRefreshToken(ctx, pool, raw)
	if err != nil {
		t.Fatalf("RevokeByRefreshToken: %v", err)
	}
	if gotSid != sid {
		t.Errorf("sid mismatch: got %s want %s", gotSid, sid)
	}
	if gotUID != uid {
		t.Errorf("uid mismatch: got %s want %s", gotUID, uid)
	}
}

func TestRevokeByRefreshToken_InvalidToken(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	if _, _, err := RevokeByRefreshToken(ctx, pool, "totally-bogus-token"); err == nil {
		t.Fatal("expected error for unknown token")
	}
}

func TestSetTenant_UpdatesRow(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)
	tid := insertTestTenant(t, pool)

	_, sid, _ := CreateSession(ctx, pool, uid, "", "")
	if err := SetTenant(ctx, pool, sid, tid); err != nil {
		t.Fatalf("SetTenant: %v", err)
	}
	var storedTid *uuid.UUID
	pool.QueryRow(ctx, `SELECT tenant_id FROM sessions WHERE id = $1`, sid).Scan(&storedTid)
	if storedTid == nil || *storedTid != tid {
		t.Fatalf("tenant_id mismatch: got %v want %s", storedTid, tid)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: token_version cache
// ─────────────────────────────────────────────────────────────────────────────

func TestGetTokenVersion_CacheHit(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	// Populate cache via first call.
	v1, err := GetTokenVersion(ctx, pool, uid)
	if err != nil {
		t.Fatalf("GetTokenVersion: %v", err)
	}
	// Inject a stale value directly into the cache.
	tvMu.Lock()
	tvCache[uid] = tvEntry{version: v1, fetched: time.Now()}
	tvMu.Unlock()
	// Should return cached value without hitting DB.
	v2, err := GetTokenVersion(ctx, pool, uid)
	if err != nil {
		t.Fatalf("GetTokenVersion (cached): %v", err)
	}
	if v1 != v2 {
		t.Errorf("cache hit returned different version: %d vs %d", v1, v2)
	}
}

func TestGetTokenVersion_CacheExpiry(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	v0, _ := GetTokenVersion(ctx, pool, uid)

	// Manually bump in DB without going through BumpTokenVersion (so cache stays stale).
	pool.Exec(ctx, `UPDATE users SET token_version = token_version + 5 WHERE id = $1`, uid)

	// Expire the cache entry.
	tvMu.Lock()
	tvCache[uid] = tvEntry{version: v0, fetched: time.Now().Add(-tokenVersionCacheTTL - time.Second)}
	tvMu.Unlock()

	v2, err := GetTokenVersion(ctx, pool, uid)
	if err != nil {
		t.Fatalf("GetTokenVersion after expiry: %v", err)
	}
	if v2 != v0+5 {
		t.Errorf("expected fresh version %d, got %d", v0+5, v2)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: BearerMiddleware token_version enforcement
// ─────────────────────────────────────────────────────────────────────────────

func TestBearerMiddleware_TokenVersionMismatch(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	// Get current tv, then mint a token with tv+1 (which won't match DB).
	tv, _ := GetTokenVersion(ctx, pool, uid)

	// Expire cache so middleware always hits DB.
	tvMu.Lock()
	delete(tvCache, uid)
	tvMu.Unlock()

	tok, _, _ := MintAccessToken(uid, "u@t.com", "U", uuid.New(), tv+99)
	inner := &okHandler{}
	h := BearerMiddleware(pool)(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	h.ServeHTTP(w, r)
	if _, ok := appctx.UserFromContext(r.Context()); ok {
		t.Fatal("user should not be set when token_version mismatches DB")
	}
}

func TestBearerMiddleware_TokenVersionMatch(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	// Expire any cached entry so middleware reads from DB.
	tvMu.Lock()
	delete(tvCache, uid)
	tvMu.Unlock()

	tv, err := GetTokenVersion(ctx, pool, uid)
	if err != nil {
		t.Fatalf("GetTokenVersion: %v", err)
	}

	tok, _, _ := MintAccessToken(uid, "u@t.com", "U", uuid.New(), tv)
	inner := &okHandler{}
	h := BearerMiddleware(pool)(inner)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	h.ServeHTTP(w, r)
	if !inner.called {
		t.Fatal("inner handler should be called with matching token_version")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: WSTicket
// ─────────────────────────────────────────────────────────────────────────────

func TestCreateAndConsumeWSTicket_Success(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)
	tid := insertTestTenant(t, pool)

	raw, err := CreateWSTicket(ctx, pool, uid, tid)
	if err != nil {
		t.Fatalf("CreateWSTicket: %v", err)
	}
	gotUID, gotTID, err := ConsumeWSTicket(ctx, pool, raw)
	if err != nil {
		t.Fatalf("ConsumeWSTicket: %v", err)
	}
	if gotUID != uid {
		t.Errorf("uid mismatch: got %s want %s", gotUID, uid)
	}
	if gotTID != tid {
		t.Errorf("tid mismatch: got %s want %s", gotTID, tid)
	}
}

func TestConsumeWSTicket_DoubleConsume(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)
	tid := insertTestTenant(t, pool)

	raw, _ := CreateWSTicket(ctx, pool, uid, tid)
	if _, _, err := ConsumeWSTicket(ctx, pool, raw); err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if _, _, err := ConsumeWSTicket(ctx, pool, raw); err == nil {
		t.Fatal("expected error on double-consume of WS ticket")
	}
}

func TestConsumeWSTicket_Expired(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)
	tid := insertTestTenant(t, pool)

	raw, err := CreateWSTicket(ctx, pool, uid, tid)
	if err != nil {
		t.Fatalf("CreateWSTicket: %v", err)
	}
	// Backdate expires_at so it's already expired.
	pool.Exec(ctx, `UPDATE ws_tickets SET expires_at = now() - interval '1 minute' WHERE ticket_hash = $1`, hashToken(raw))

	if _, _, err := ConsumeWSTicket(ctx, pool, raw); err == nil {
		t.Fatal("expected error for expired WS ticket")
	}
}

func TestConsumeWSTicket_UnknownTicket(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	if _, _, err := ConsumeWSTicket(ctx, pool, "completely-unknown-ticket-raw"); err == nil {
		t.Fatal("expected error for unknown WS ticket")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: Handoff code (Google → SPA token exchange)
// ─────────────────────────────────────────────────────────────────────────────

func TestHandoffCode_CreateAndConsume(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, err := CreateHandoffCode(ctx, pool, uid, "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateHandoffCode: %v", err)
	}
	gotUID, err := consumeHandoffCode(ctx, pool, raw)
	if err != nil {
		t.Fatalf("consumeHandoffCode: %v", err)
	}
	if gotUID != uid {
		t.Errorf("uid mismatch: got %s want %s", gotUID, uid)
	}
}

func TestHandoffCode_DoubleConsume(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, _ := CreateHandoffCode(ctx, pool, uid, "")
	if _, err := consumeHandoffCode(ctx, pool, raw); err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if _, err := consumeHandoffCode(ctx, pool, raw); err == nil {
		t.Fatal("expected error on double-consume of handoff code")
	}
}

func TestHandoffCode_Expired(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, _ := CreateHandoffCode(ctx, pool, uid, "")
	pool.Exec(ctx, `UPDATE auth_handoff SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, hashToken(raw))

	if _, err := consumeHandoffCode(ctx, pool, raw); err == nil {
		t.Fatal("expected error for expired handoff code")
	}
}

func TestHandoffCode_Unknown(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	if _, err := consumeHandoffCode(ctx, pool, "bogus-raw-code"); err == nil {
		t.Fatal("expected error for unknown handoff code")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: LookupOrCreateUser, LookupUserByID
// ─────────────────────────────────────────────────────────────────────────────

func TestLookupOrCreateUser_CreateNew(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	email := "new-" + uuid.NewString()[:8] + "@create.test"

	id, err := LookupOrCreateUser(ctx, pool, "", email, "New User", "")
	if err != nil {
		t.Fatalf("LookupOrCreateUser: %v", err)
	}
	if id == uuid.Nil {
		t.Fatal("expected non-nil uuid")
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id) })
}

func TestLookupOrCreateUser_Idempotent(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	email := "idem-" + uuid.NewString()[:8] + "@create.test"

	id1, err1 := LookupOrCreateUser(ctx, pool, "", email, "User", "")
	id2, err2 := LookupOrCreateUser(ctx, pool, "", email, "User", "")
	if err1 != nil || err2 != nil {
		t.Fatalf("errors: %v %v", err1, err2)
	}
	if id1 != id2 {
		t.Fatalf("idempotency failed: %s vs %s", id1, id2)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id1) })
}

func TestLookupOrCreateUser_ByGoogleSub(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	email := "gsub-" + uuid.NewString()[:8] + "@create.test"
	sub := "google-sub-" + uuid.NewString()[:8]

	id1, _ := LookupOrCreateUser(ctx, pool, sub, email, "GUser", "https://avatar.url/pic.jpg")
	id2, _ := LookupOrCreateUser(ctx, pool, sub, email, "GUser Updated", "")
	if id1 != id2 {
		t.Fatalf("google sub lookup should return same user: %s vs %s", id1, id2)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id1) })
}

func TestLookupUserByID_Success(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	email, name, err := LookupUserByID(ctx, pool, uid)
	if err != nil {
		t.Fatalf("LookupUserByID: %v", err)
	}
	if email == "" {
		t.Fatal("expected non-empty email")
	}
	if name != "Auth Test" {
		t.Errorf("name: got %q want %q", name, "Auth Test")
	}
}

func TestLookupUserByID_NotFound(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	if _, _, err := LookupUserByID(ctx, pool, uuid.New()); err == nil {
		t.Fatal("expected error for non-existent user")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: SyncPlatformAdmin
// ─────────────────────────────────────────────────────────────────────────────

func TestSyncPlatformAdmin_NonAllowlisted(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	SetPlatformAllowlist(nil) // empty allowlist
	SyncPlatformAdmin(ctx, pool, uid, "not-admin@example.com")

	var count int
	pool.QueryRow(ctx, `SELECT count(*) FROM platform_admins WHERE user_id = $1`, uid).Scan(&count)
	if count != 0 {
		t.Fatalf("expected no platform_admin row for non-allowlisted email, got %d", count)
	}
}

func TestSyncPlatformAdmin_Allowlisted(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()

	adminEmail := "platform-admin-" + uuid.NewString()[:8] + "@admin.test"
	uid := uuid.Nil
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, 'Platform Admin Test') RETURNING id`, adminEmail).Scan(&uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, uid) })

	SetPlatformAllowlist([]string{adminEmail})
	t.Cleanup(func() { SetPlatformAllowlist(nil) })

	SyncPlatformAdmin(ctx, pool, uid, adminEmail)

	var count int
	pool.QueryRow(ctx, `SELECT count(*) FROM platform_admins WHERE user_id = $1`, uid).Scan(&count)
	if count != 1 {
		t.Fatalf("expected 1 platform_admin row for allowlisted email, got %d", count)
	}
}

func TestSyncPlatformAdmin_Idempotent(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()

	adminEmail := "platform-idem-" + uuid.NewString()[:8] + "@admin.test"
	var uid uuid.UUID
	pool.QueryRow(ctx, `INSERT INTO users (email, name) VALUES ($1, 'Idem Admin') RETURNING id`, adminEmail).Scan(&uid)
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, uid) })

	SetPlatformAllowlist([]string{adminEmail})
	t.Cleanup(func() { SetPlatformAllowlist(nil) })

	SyncPlatformAdmin(ctx, pool, uid, adminEmail)
	SyncPlatformAdmin(ctx, pool, uid, adminEmail) // must not fail on duplicate

	var count int
	pool.QueryRow(ctx, `SELECT count(*) FROM platform_admins WHERE user_id = $1`, uid).Scan(&count)
	if count != 1 {
		t.Fatalf("idempotent upsert failed: got %d rows", count)
	}
}

func TestSyncPlatformAdmin_NilUserID(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	SetPlatformAllowlist([]string{"admin@example.com"})
	t.Cleanup(func() { SetPlatformAllowlist(nil) })
	// uuid.Nil should be a no-op.
	SyncPlatformAdmin(ctx, pool, uuid.Nil, "admin@example.com") // must not panic or error
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: RequirePlatformAdmin HTTP middleware
// ─────────────────────────────────────────────────────────────────────────────

func TestRequirePlatformAdmin_Unauthenticated(t *testing.T) {
	pool := freshPool(t)
	inner := &okHandler{}
	h := RequirePlatformAdmin(pool)(inner)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/super", nil)
	// No user in context.
	h.ServeHTTP(w, r)
	if inner.called {
		t.Fatal("inner should not be called without user in context")
	}
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestRequirePlatformAdmin_NotAdmin(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)
	email := "nonplatform-" + uuid.NewString()[:8] + "@test.local"
	// Update the test user's email.
	pool.Exec(ctx, `UPDATE users SET email = $1 WHERE id = $2`, email, uid)

	inner := &okHandler{}
	h := RequirePlatformAdmin(pool)(inner)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/super", nil)
	r = r.WithContext(appctx.WithUser(r.Context(), appctx.User{ID: uid, Email: email}))
	h.ServeHTTP(w, r)
	if inner.called {
		t.Fatal("inner should not be called for non-admin user")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status: got %d want %d", w.Code, http.StatusForbidden)
	}
}

func TestRequirePlatformAdmin_AllowlistFallback(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	adminEmail := "allowlist-admin-" + uuid.NewString()[:8] + "@admin.test"

	var uid uuid.UUID
	pool.QueryRow(ctx, `INSERT INTO users (email, name) VALUES ($1, 'Allowlist Admin') RETURNING id`, adminEmail).Scan(&uid)
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, uid) })

	SetPlatformAllowlist([]string{adminEmail})
	t.Cleanup(func() { SetPlatformAllowlist(nil) })

	inner := &okHandler{}
	h := RequirePlatformAdmin(pool)(inner)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/super", nil)
	r = r.WithContext(appctx.WithUser(r.Context(), appctx.User{ID: uid, Email: adminEmail}))
	h.ServeHTTP(w, r)
	if !inner.called {
		t.Fatal("inner should be called for user in allowlist")
	}
	if w.Code != http.StatusOK {
		t.Errorf("status: got %d want %d", w.Code, http.StatusOK)
	}
}

func TestRequirePlatformAdmin_DBAdmin(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()

	adminEmail := "db-admin-" + uuid.NewString()[:8] + "@admin.test"
	var uid uuid.UUID
	pool.QueryRow(ctx, `INSERT INTO users (email, name) VALUES ($1, 'DB Admin') RETURNING id`, adminEmail).Scan(&uid)
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, uid) })

	// Insert directly into platform_admins (NOT via allowlist).
	pool.Exec(ctx, `INSERT INTO platform_admins (user_id, source) VALUES ($1, 'manual')`, uid)

	SetPlatformAllowlist(nil) // make sure allowlist doesn't help

	inner := &okHandler{}
	h := RequirePlatformAdmin(pool)(inner)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/super", nil)
	r = r.WithContext(appctx.WithUser(r.Context(), appctx.User{ID: uid, Email: adminEmail}))
	h.ServeHTTP(w, r)
	if !inner.called {
		t.Fatal("inner should be called for DB platform admin")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: RefreshHandler HTTP
// ─────────────────────────────────────────────────────────────────────────────

func TestRefreshHandler_MissingBody(t *testing.T) {
	pool := freshPool(t)
	h := RefreshHandler(pool)

	for _, body := range []string{`{}`, `{"refresh_token":""}`, `not json`} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/auth/refresh", strings.NewReader(body))
		h(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("body %q: status got %d want %d", body, w.Code, http.StatusUnauthorized)
		}
	}
}

func TestRefreshHandler_InvalidToken(t *testing.T) {
	pool := freshPool(t)
	h := RefreshHandler(pool)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/refresh",
		jsonBody(map[string]string{"refresh_token": "invalid-token-value"}))
	h(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestRefreshHandler_Success(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, _, _ := CreateSession(ctx, pool, uid, "", "")

	h := RefreshHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/refresh",
		jsonBody(map[string]string{"refresh_token": raw}))
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d want %d; body: %s", w.Code, http.StatusOK, w.Body.String())
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["access_token"] == nil {
		t.Fatal("access_token missing from response")
	}
	if resp["refresh_token"] == nil {
		t.Fatal("refresh_token missing from response")
	}
}

func TestRefreshHandler_ReuseDetected(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, sid, _ := CreateSession(ctx, pool, uid, "", "")
	// Rotate once.
	if _, _, _, err := RotateRefresh(ctx, pool, raw, "", ""); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	// Backdate replaced_at to outside grace window.
	pool.Exec(ctx, `UPDATE sessions SET replaced_at = now() - interval '1 hour' WHERE id = $1`, sid)

	h := RefreshHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/refresh",
		jsonBody(map[string]string{"refresh_token": raw}))
	h(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("reuse: status got %d want %d", w.Code, http.StatusUnauthorized)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: LogoutHandler HTTP
// ─────────────────────────────────────────────────────────────────────────────

func TestLogoutHandler_ByRefreshToken(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	raw, sid, _ := CreateSession(ctx, pool, uid, "", "")
	h := LogoutHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/logout",
		jsonBody(map[string]string{"refresh_token": raw}))
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d", w.Code)
	}
	var revokedAt *time.Time
	pool.QueryRow(ctx, `SELECT revoked_at FROM sessions WHERE id = $1`, sid).Scan(&revokedAt)
	if revokedAt == nil {
		t.Fatal("session should be revoked after logout")
	}
}

func TestLogoutHandler_ByBearerSID(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	tv, _ := GetTokenVersion(ctx, pool, uid)
	_, sid, _ := CreateSession(ctx, pool, uid, "", "")
	tok, _, _ := MintAccessToken(uid, "u@test.local", "U", sid, tv)

	h := LogoutHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/logout", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+tok)
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d", w.Code)
	}
	var revokedAt *time.Time
	pool.QueryRow(ctx, `SELECT revoked_at FROM sessions WHERE id = $1`, sid).Scan(&revokedAt)
	if revokedAt == nil {
		t.Fatal("session should be revoked after logout via bearer sid")
	}
}

func TestLogoutHandler_EmptyBody(t *testing.T) {
	pool := freshPool(t)
	h := LogoutHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/logout", strings.NewReader(`{}`))
	h(w, r)
	// Empty body is a no-op but must return 200 ok.
	if w.Code != http.StatusOK {
		t.Errorf("status: got %d want 200", w.Code)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: LogoutAllHandler HTTP
// ─────────────────────────────────────────────────────────────────────────────

func TestLogoutAllHandler_RevokesAllAndBumpsTV(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	tv0, _ := GetTokenVersion(ctx, pool, uid)

	// Create 2 sessions.
	for i := 0; i < 2; i++ {
		CreateSession(ctx, pool, uid, "", "")
	}

	// Clear TV cache so middleware reads fresh.
	tvMu.Lock()
	delete(tvCache, uid)
	tvMu.Unlock()

	tok := mintValidToken(t, uid, tv0)

	// Chain: BearerMiddleware → RequireAuth → LogoutAllHandler
	inner := LogoutAllHandler(pool)
	h := BearerMiddleware(pool)(RequireAuth(inner))

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/logout-all", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+tok)
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d; body: %s", w.Code, w.Body.String())
	}
	// All sessions should be revoked.
	var active int
	pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, uid).Scan(&active)
	if active != 0 {
		t.Errorf("expected 0 active sessions after logout-all, got %d", active)
	}
	// tv should be bumped.
	var tv1 int
	pool.QueryRow(ctx, `SELECT token_version FROM users WHERE id = $1`, uid).Scan(&tv1)
	if tv1 != tv0+1 {
		t.Errorf("token_version: got %d want %d", tv1, tv0+1)
	}
}

func TestLogoutAllHandler_Unauthenticated(t *testing.T) {
	pool := freshPool(t)
	h := RequireAuth(LogoutAllHandler(pool))
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/logout-all", strings.NewReader(`{}`))
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d want 401", w.Code)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: DevLoginHandler HTTP
// ─────────────────────────────────────────────────────────────────────────────

func TestDevLoginHandler_Success(t *testing.T) {
	pool := freshPool(t)
	email := "devlogin-" + uuid.NewString()[:8] + "@dev.test"

	h := DevLoginHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/dev-login",
		jsonBody(map[string]string{"email": email, "name": "Dev User"}))
	h(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["access_token"] == nil || resp["refresh_token"] == nil {
		t.Fatal("expected access_token and refresh_token in response")
	}
	// Cleanup
	pool.Exec(context.Background(), `DELETE FROM users WHERE email = $1`, email)
}

func TestDevLoginHandler_MethodNotAllowed(t *testing.T) {
	pool := freshPool(t)
	h := DevLoginHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/auth/dev-login", nil)
	h(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status: got %d want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestDevLoginHandler_MissingEmail(t *testing.T) {
	pool := freshPool(t)
	h := DevLoginHandler(pool)

	cases := []string{`{}`, `{"name":"X"}`, `not json`}
	for _, body := range cases {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/auth/dev-login", strings.NewReader(body))
		h(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("body %q: status got %d want 400", body, w.Code)
		}
	}
}

func TestDevLoginHandler_Idempotent(t *testing.T) {
	pool := freshPool(t)
	email := "devlogin-idem-" + uuid.NewString()[:8] + "@dev.test"
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE email = $1`, email) })

	h := DevLoginHandler(pool)
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/auth/dev-login",
			jsonBody(map[string]string{"email": email}))
		h(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("call %d: status got %d", i, w.Code)
		}
	}
	var count int
	pool.QueryRow(context.Background(), `SELECT count(*) FROM users WHERE email = $1`, email).Scan(&count)
	if count != 1 {
		t.Fatalf("expected 1 user row after 2 dev-logins, got %d", count)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: ExchangeHandler HTTP
// ─────────────────────────────────────────────────────────────────────────────

func TestExchangeHandler_Success(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	code, _ := CreateHandoffCode(ctx, pool, uid, "")
	h := ExchangeHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/exchange",
		jsonBody(map[string]string{"code": code}))
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["access_token"] == nil {
		t.Fatal("expected access_token in response")
	}
}

func TestExchangeHandler_MissingCode(t *testing.T) {
	pool := freshPool(t)
	h := ExchangeHandler(pool)
	for _, body := range []string{`{}`, `{"code":""}`, `not json`} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/auth/exchange", strings.NewReader(body))
		h(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("body %q: status got %d want 400", body, w.Code)
		}
	}
}

func TestExchangeHandler_InvalidCode(t *testing.T) {
	pool := freshPool(t)
	h := ExchangeHandler(pool)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/exchange",
		jsonBody(map[string]string{"code": "totally-invalid-exchange-code"}))
	h(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d want 401", w.Code)
	}
}

func TestExchangeHandler_DoubleConsume(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()
	uid := insertTestUser(t, pool)

	code, _ := CreateHandoffCode(ctx, pool, uid, "")
	h := ExchangeHandler(pool)
	doExchange := func() int {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/auth/exchange",
			jsonBody(map[string]string{"code": code}))
		h(w, r)
		return w.Code
	}
	if doExchange() != http.StatusOK {
		t.Fatal("first exchange should succeed")
	}
	if doExchange() != http.StatusUnauthorized {
		t.Fatal("second exchange should fail (already consumed)")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed: OTP lifecycle
// ─────────────────────────────────────────────────────────────────────────────

// otpParams returns a tightly-windowed OTPParams for test speed. The caps are
// set high so the throttle-specific tests can lower them explicitly.
func otpParams() OTPParams {
	return OTPParams{
		CodeLength:     6,
		TTLSeconds:     60,
		ResendCooldown: 0, // no cooldown in tests (we control time via DB)
		MaxAttempts:    5,
		EmailHourlyCap: 100,
		IPHourlyCap:    100,
	}
}

func TestRequestOTPHandler_MethodNotAllowed(t *testing.T) {
	pool := freshPool(t)
	h := RequestOTPHandler(pool, nil, otpParams(), true)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/auth/request-otp", nil)
	h(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status: got %d want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestRequestOTPHandler_InvalidEmail(t *testing.T) {
	pool := freshPool(t)
	h := RequestOTPHandler(pool, nil, otpParams(), true)
	cases := []string{`{}`, `{"email":""}`, `{"email":"not-an-email"}`, `not json`}
	for _, body := range cases {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/auth/request-otp", strings.NewReader(body))
		h(w, r)
		if w.Code < 400 {
			t.Errorf("body %q: status got %d (expected >= 400)", body, w.Code)
		}
	}
}

func TestRequestOTPHandler_Success(t *testing.T) {
	pool := freshPool(t)
	email := "otp-req-" + uuid.NewString()[:8] + "@otp.test"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM email_otps WHERE email = $1`, email)
	})

	h := RequestOTPHandler(pool, nil, otpParams(), true)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/request-otp",
		jsonBody(map[string]string{"email": email}))
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["sent"] != true {
		t.Fatal("expected sent:true in response")
	}
}

func TestRequestOTPHandler_Cooldown(t *testing.T) {
	pool := freshPool(t)
	email := "otp-cool-" + uuid.NewString()[:8] + "@otp.test"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM email_otps WHERE email = $1`, email)
	})

	params := otpParams()
	params.ResendCooldown = 30 // 30s cooldown

	h := RequestOTPHandler(pool, nil, params, true)

	// First request succeeds.
	w1 := httptest.NewRecorder()
	r1 := httptest.NewRequest(http.MethodPost, "/auth/request-otp",
		jsonBody(map[string]string{"email": email}))
	h(w1, r1)
	if w1.Code != http.StatusOK {
		t.Fatalf("first request failed: %d", w1.Code)
	}

	// Second request within cooldown should be 429.
	w2 := httptest.NewRecorder()
	r2 := httptest.NewRequest(http.MethodPost, "/auth/request-otp",
		jsonBody(map[string]string{"email": email}))
	h(w2, r2)
	if w2.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 on second request within cooldown, got %d", w2.Code)
	}
	var resp map[string]any
	json.NewDecoder(w2.Body).Decode(&resp)
	if resp["code"] != "otp_cooldown" {
		t.Errorf("expected code otp_cooldown, got %v", resp["code"])
	}
	if resp["retry_after_seconds"] == nil {
		t.Error("expected retry_after_seconds in cooldown response")
	}
	// The retry hint must also ride the standard Retry-After header, matching
	// the body so HTTP-aware clients and our FE agree on the wait.
	hdr := w2.Header().Get("Retry-After")
	if hdr == "" {
		t.Error("expected Retry-After header on cooldown response")
	}
	if got, _ := resp["retry_after_seconds"].(float64); hdr != strconv.Itoa(int(got)) {
		t.Errorf("Retry-After header %q should match body retry_after_seconds %v", hdr, got)
	}
}

func TestRequestOTPHandler_EmailHourlyCap(t *testing.T) {
	pool := freshPool(t)
	email := "otp-ecap-" + uuid.NewString()[:8] + "@otp.test"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM email_otps WHERE email = $1`, email)
	})

	params := otpParams()
	params.ResendCooldown = 0 // isolate the email cap from the cooldown
	params.EmailHourlyCap = 3

	h := RequestOTPHandler(pool, nil, params, true)
	send := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(http.MethodPost, "/auth/request-otp",
			jsonBody(map[string]string{"email": email})))
		return w
	}

	// The first EmailHourlyCap sends succeed.
	for i := 0; i < params.EmailHourlyCap; i++ {
		if w := send(); w.Code != http.StatusOK {
			t.Fatalf("send %d: got %d; body: %s", i+1, w.Code, w.Body.String())
		}
	}
	// The next one is rejected with the email-specific code.
	w := send()
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("over-cap send: got %d want 429; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["code"] != "otp_email_cap" {
		t.Errorf("expected code otp_email_cap, got %v", resp["code"])
	}
	if resp["retry_after_seconds"] == nil {
		t.Error("expected retry_after_seconds on email-cap response")
	}
}

// The core fix: two DIFFERENT mailboxes never gate each other. This mirrors
// co-located café staff — even sharing one NAT IP, each staffer's first code
// request must succeed regardless of how many codes other staff requested.
func TestRequestOTPHandler_DifferentEmailsIndependent(t *testing.T) {
	pool := freshPool(t)
	emailA := "otp-indepA-" + uuid.NewString()[:8] + "@otp.test"
	emailB := "otp-indepB-" + uuid.NewString()[:8] + "@otp.test"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM email_otps WHERE email = ANY($1)`, []string{emailA, emailB})
	})

	params := otpParams()
	params.ResendCooldown = 0
	params.EmailHourlyCap = 1 // A can only get one code

	h := RequestOTPHandler(pool, nil, params, true)
	send := func(email string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(http.MethodPost, "/auth/request-otp",
			jsonBody(map[string]string{"email": email})))
		return w
	}

	// Exhaust A's per-email budget.
	if w := send(emailA); w.Code != http.StatusOK {
		t.Fatalf("A first send: got %d; body: %s", w.Code, w.Body.String())
	}
	if w := send(emailA); w.Code != http.StatusTooManyRequests {
		t.Fatalf("A second send: got %d want 429 (its own cap)", w.Code)
	}
	// B's first request must still succeed — it is not blocked by A.
	if w := send(emailB); w.Code != http.StatusOK {
		t.Fatalf("B first send: got %d want 200 (must be independent of A); body: %s", w.Code, w.Body.String())
	}
}

func TestVerifyOTPHandler_MethodNotAllowed(t *testing.T) {
	pool := freshPool(t)
	h := VerifyOTPHandler(pool, otpParams())
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/auth/verify-otp", nil)
	h(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status: got %d want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestVerifyOTPHandler_InvalidEmail(t *testing.T) {
	pool := freshPool(t)
	h := VerifyOTPHandler(pool, otpParams())
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": "bad-email", "code": "123456"}))
	h(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d want 400", w.Code)
	}
}

func TestVerifyOTPHandler_MissingCode(t *testing.T) {
	pool := freshPool(t)
	h := VerifyOTPHandler(pool, otpParams())
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": "good@email.com", "code": ""}))
	h(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status: got %d want 400", w.Code)
	}
}

func TestVerifyOTPHandler_NoActiveCode(t *testing.T) {
	pool := freshPool(t)
	h := VerifyOTPHandler(pool, otpParams())
	email := "otp-noactive-" + uuid.NewString()[:8] + "@otp.test"
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": email, "code": "123456"}))
	h(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d want 401", w.Code)
	}
}

// seedOTP directly inserts an OTP row and returns its raw code (un-hashed).
func seedOTP(t *testing.T, pool *pgxpool.Pool, email, code string, ttl time.Duration, maxAttempts int) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO email_otps (email, code_hash, expires_at, max_attempts)
		VALUES ($1, $2, $3, $4)
	`, email, hashOTP(code), time.Now().Add(ttl), maxAttempts); err != nil {
		t.Fatalf("seedOTP: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM email_otps WHERE email = $1`, email)
	})
}

func TestOTPFullLifecycle(t *testing.T) {
	pool := freshPool(t)
	ctx := context.Background()

	email := "otp-lifecycle-" + uuid.NewString()[:8] + "@otp.test"
	params := OTPParams{
		CodeLength:     6,
		TTLSeconds:     60,
		ResendCooldown: 0,
		MaxAttempts:    3,
		IPHourlyCap:    100,
	}
	verifyH := VerifyOTPHandler(pool, params)

	correctCode := "654321"
	seedOTP(t, pool, email, correctCode, time.Minute, params.MaxAttempts)

	// --- Wrong code (attempt 1 of 3) ---
	w1 := httptest.NewRecorder()
	r1 := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": email, "code": "000001"}))
	verifyH(w1, r1)
	if w1.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code #1: got %d", w1.Code)
	}
	var body1 map[string]any
	json.NewDecoder(w1.Body).Decode(&body1)
	if fmt.Sprint(body1["attempts_remaining"]) != "2" {
		t.Errorf("attempts_remaining: got %v want 2", body1["attempts_remaining"])
	}

	// --- Wrong code (attempt 2 of 3) ---
	w2 := httptest.NewRecorder()
	r2 := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": email, "code": "000002"}))
	verifyH(w2, r2)
	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code #2: got %d", w2.Code)
	}

	// --- Wrong code (attempt 3 of 3 → lockout) ---
	w3 := httptest.NewRecorder()
	r3 := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": email, "code": "000003"}))
	verifyH(w3, r3)
	if w3.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code #3 (lockout): got %d", w3.Code)
	}
	var body3 map[string]any
	json.NewDecoder(w3.Body).Decode(&body3)
	if fmt.Sprint(body3["attempts_remaining"]) != "0" {
		t.Errorf("expected 0 attempts_remaining at lockout, got %v", body3["attempts_remaining"])
	}
	// Row must be consumed (locked out).
	var consumedAt *time.Time
	pool.QueryRow(ctx, `SELECT consumed_at FROM email_otps WHERE email = $1`, email).Scan(&consumedAt)
	if consumedAt == nil {
		t.Fatal("OTP row should be consumed after max attempts exceeded")
	}

	// --- Correct code after lockout should still fail (row consumed) ---
	w4 := httptest.NewRecorder()
	r4 := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": email, "code": correctCode}))
	verifyH(w4, r4)
	if w4.Code != http.StatusUnauthorized {
		t.Errorf("correct code after lockout should fail, got %d", w4.Code)
	}
}

func TestVerifyOTPHandler_CorrectCodeSuccess(t *testing.T) {
	pool := freshPool(t)
	email := "otp-correct-" + uuid.NewString()[:8] + "@otp.test"
	correctCode := "987654"
	seedOTP(t, pool, email, correctCode, time.Minute, 5)
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM users WHERE email = $1`, email) })

	params := otpParams()
	h := VerifyOTPHandler(pool, params)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": email, "code": correctCode}))
	h(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("correct code: status got %d; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["access_token"] == nil {
		t.Fatal("expected access_token in response after OTP verify")
	}
}

func TestVerifyOTPHandler_ExpiredCode(t *testing.T) {
	pool := freshPool(t)
	email := "otp-expired-" + uuid.NewString()[:8] + "@otp.test"
	// Insert an already-expired OTP.
	pool.Exec(context.Background(), `
		INSERT INTO email_otps (email, code_hash, expires_at, max_attempts)
		VALUES ($1, $2, now() - interval '1 hour', 5)
	`, email, hashOTP("123456"))
	t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM email_otps WHERE email = $1`, email) })

	h := VerifyOTPHandler(pool, otpParams())
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/verify-otp",
		jsonBody(map[string]any{"email": email, "code": "123456"}))
	h(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expired OTP: got %d want 401", w.Code)
	}
}

func TestRequestOTPHandler_Supersedes_PreviousCode(t *testing.T) {
	pool := freshPool(t)
	email := "otp-super-" + uuid.NewString()[:8] + "@otp.test"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM email_otps WHERE email = $1`, email)
	})

	// Plant an existing OTP.
	seedOTP(t, pool, email, "111111", time.Minute, 5)

	params := otpParams()
	h := RequestOTPHandler(pool, nil, params, true)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/request-otp",
		jsonBody(map[string]string{"email": email}))
	h(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("re-request: status got %d", w.Code)
	}

	// Old code should be consumed.
	var consumed int
	pool.QueryRow(context.Background(),
		`SELECT count(*) FROM email_otps WHERE email = $1 AND consumed_at IS NOT NULL`, email).Scan(&consumed)
	if consumed < 1 {
		t.Fatal("old OTP row should be marked consumed after re-request")
	}
}
