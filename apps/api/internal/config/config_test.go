package config

import (
	"net/http"
	"testing"
	"time"
)

// baseEnv sets the minimum valid env for a "dev" build so we can exercise
// individual knobs without re-specifying everything.
//
// It explicitly sets (and thus overrides via t.Setenv) every env var that has
// a default in Load(), so tests that care about a specific default don't see
// stale values from a local .env file that loadDotEnv() would otherwise inject.
// APP_ENV=dev causes loadDotEnv to run, but all keys are already set so it
// becomes a no-op.
func baseEnv(t *testing.T) {
	t.Helper()
	t.Setenv("APP_ENV", "dev")
	t.Setenv("DATABASE_URL", "postgresql://localhost/testdb")
	t.Setenv("APP_DATABASE_URL", "")
	t.Setenv("HTTP_ADDR", ":8080")
	t.Setenv("ROOT_DOMAIN", "localhost")
	t.Setenv("CORS_ORIGINS", "http://localhost:5891")
	t.Setenv("SESSION_SECRET", "")
	t.Setenv("SESSION_COOKIE_SAMESITE", "")
	t.Setenv("ACCESS_TOKEN_TTL", "")
	t.Setenv("REFRESH_TOKEN_TTL", "")
	t.Setenv("STORAGE_DRIVER", "local")
	t.Setenv("STORAGE_LOCAL_ROOT", "./uploads")
	t.Setenv("STORAGE_LOCAL_PUBLIC_BASE", "/uploads")
	t.Setenv("STORAGE_S3_FORCE_PATH_STYLE", "")
	t.Setenv("MAIL_SMTP_HOST", "")
	t.Setenv("MAIL_SMTP_PORT", "")
	t.Setenv("MAIL_SMTP_USERNAME", "")
	t.Setenv("SENDGRID_API_KEY", "")
	t.Setenv("MAIL_SMTP_PASSWORD", "")
	t.Setenv("OTP_CODE_LENGTH", "")
	t.Setenv("OTP_TTL_SECONDS", "")
	t.Setenv("OTP_RESEND_COOLDOWN_SECONDS", "")
	t.Setenv("OTP_MAX_ATTEMPTS", "")
	t.Setenv("OTP_EMAIL_HOURLY_CAP", "")
	t.Setenv("OTP_IP_HOURLY_CAP", "")
	t.Setenv("PLATFORM_ADMIN_EMAILS", "")
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "")
	t.Setenv("GOOGLE_OAUTH_REDIRECT_URL", "")
	t.Setenv("POST_LOGIN_REDIRECT_URL", "")
	t.Setenv("LOG_LEVEL", "")
	t.Setenv("LOG_FORMAT", "")
}

// ---------------------------------------------------------------------------
// Load — defaults
// ---------------------------------------------------------------------------

func TestLoad_Defaults_Dev(t *testing.T) {
	baseEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Env != "dev" {
		t.Errorf("Env = %q, want dev", cfg.Env)
	}
	if cfg.HTTPAddr != ":8080" {
		t.Errorf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
	}
	if cfg.RootDomain != "localhost" {
		t.Errorf("RootDomain = %q, want localhost", cfg.RootDomain)
	}
	if len(cfg.CORSOrigins) == 0 {
		t.Error("CORSOrigins should default to at least one origin")
	}
	// Token TTL defaults.
	if cfg.AccessTokenTTL != 15*time.Minute {
		t.Errorf("AccessTokenTTL = %v, want 15m", cfg.AccessTokenTTL)
	}
	if cfg.RefreshTokenTTL != 30*24*time.Hour {
		t.Errorf("RefreshTokenTTL = %v, want 720h", cfg.RefreshTokenTTL)
	}
	// OTP defaults.
	if cfg.OTP.CodeLength != 6 {
		t.Errorf("OTP.CodeLength = %d, want 6", cfg.OTP.CodeLength)
	}
	if cfg.OTP.TTLSeconds != 600 {
		t.Errorf("OTP.TTLSeconds = %d, want 600", cfg.OTP.TTLSeconds)
	}
	if cfg.OTP.ResendCooldown != 60 {
		t.Errorf("OTP.ResendCooldown = %d, want 60", cfg.OTP.ResendCooldown)
	}
	if cfg.OTP.MaxAttempts != 5 {
		t.Errorf("OTP.MaxAttempts = %d, want 5", cfg.OTP.MaxAttempts)
	}
	if cfg.OTP.EmailHourlyCap != 8 {
		t.Errorf("OTP.EmailHourlyCap = %d, want 8", cfg.OTP.EmailHourlyCap)
	}
	if cfg.OTP.IPHourlyCap != 60 {
		t.Errorf("OTP.IPHourlyCap = %d, want 60", cfg.OTP.IPHourlyCap)
	}
	// Storage defaults.
	if cfg.Storage.Driver != "local" {
		t.Errorf("Storage.Driver = %q, want local", cfg.Storage.Driver)
	}
	if cfg.Storage.LocalRoot != "./uploads" {
		t.Errorf("Storage.LocalRoot = %q, want ./uploads", cfg.Storage.LocalRoot)
	}
	// Mail defaults.
	if cfg.Mail.Host != "smtp.sendgrid.net" {
		t.Errorf("Mail.Host = %q, want smtp.sendgrid.net", cfg.Mail.Host)
	}
	if cfg.Mail.Port != 587 {
		t.Errorf("Mail.Port = %d, want 587", cfg.Mail.Port)
	}
	if cfg.Mail.Username != "apikey" {
		t.Errorf("Mail.Username = %q, want apikey", cfg.Mail.Username)
	}
	// SameSite defaults to Lax.
	if cfg.SessionSameSite != http.SameSiteLaxMode {
		t.Errorf("SessionSameSite = %v, want Lax", cfg.SessionSameSite)
	}
}

func TestLoad_DatabaseURL_FromAppDatabaseURL(t *testing.T) {
	baseEnv(t)
	t.Setenv("DATABASE_URL", "")
	t.Setenv("APP_DATABASE_URL", "postgresql://app@localhost/cafe")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DatabaseURL != "postgresql://app@localhost/cafe" {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
}

func TestLoad_RequiresDatabaseURL(t *testing.T) {
	baseEnv(t)
	t.Setenv("DATABASE_URL", "")
	t.Setenv("APP_DATABASE_URL", "")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error when no DATABASE_URL")
	}
}

// ---------------------------------------------------------------------------
// Prod validation
// ---------------------------------------------------------------------------

func TestLoad_Prod_RequiresSessionSecret(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("DATABASE_URL", "postgresql://localhost/testdb")
	t.Setenv("SESSION_SECRET", "short")
	t.Setenv("CORS_ORIGINS", "https://example.com")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for SESSION_SECRET < 32 bytes in prod")
	}
}

func TestLoad_Prod_ShortSessionSecret_Fails(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("DATABASE_URL", "postgresql://localhost/testdb")
	t.Setenv("SESSION_SECRET", "tooshort")
	t.Setenv("CORS_ORIGINS", "https://example.com")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for short SESSION_SECRET in prod")
	}
}

func TestLoad_Prod_ValidSessionSecret_Passes(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("DATABASE_URL", "postgresql://localhost/testdb")
	// Exactly 32 bytes.
	t.Setenv("SESSION_SECRET", "12345678901234567890123456789012")
	t.Setenv("CORS_ORIGINS", "https://example.com")

	_, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
}

func TestLoad_Prod_WildcardCORSFails(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("DATABASE_URL", "postgresql://localhost/testdb")
	t.Setenv("SESSION_SECRET", "12345678901234567890123456789012")
	t.Setenv("CORS_ORIGINS", "*")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for wildcard CORS in prod")
	}
}

func TestLoad_Prod_WildcardAmongOtherOriginsFails(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("DATABASE_URL", "postgresql://localhost/testdb")
	t.Setenv("SESSION_SECRET", "12345678901234567890123456789012")
	t.Setenv("CORS_ORIGINS", "https://example.com,*,https://other.com")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error when wildcard is mixed with explicit origins in prod")
	}
}

func TestLoad_Dev_WeakSecretAllowed(t *testing.T) {
	baseEnv(t)
	t.Setenv("SESSION_SECRET", "weak")

	_, err := Load()
	if err != nil {
		t.Fatalf("Load in dev with weak secret: %v", err)
	}
}

func TestLoad_Dev_MissingSecretAllowed(t *testing.T) {
	baseEnv(t)
	t.Setenv("SESSION_SECRET", "")

	_, err := Load()
	if err != nil {
		t.Fatalf("Load in dev with empty secret: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Duration / int / bool parsing
// ---------------------------------------------------------------------------

func TestLoad_AccessTokenTTL_CustomParsed(t *testing.T) {
	baseEnv(t)
	t.Setenv("ACCESS_TOKEN_TTL", "5m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AccessTokenTTL != 5*time.Minute {
		t.Errorf("AccessTokenTTL = %v, want 5m", cfg.AccessTokenTTL)
	}
}

func TestLoad_AccessTokenTTL_InvalidFallsToDefault(t *testing.T) {
	baseEnv(t)
	t.Setenv("ACCESS_TOKEN_TTL", "notaduration")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AccessTokenTTL != 15*time.Minute {
		t.Errorf("AccessTokenTTL = %v, want default 15m", cfg.AccessTokenTTL)
	}
}

func TestLoad_RefreshTokenTTL_Custom(t *testing.T) {
	baseEnv(t)
	t.Setenv("REFRESH_TOKEN_TTL", "168h")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RefreshTokenTTL != 168*time.Hour {
		t.Errorf("RefreshTokenTTL = %v, want 168h", cfg.RefreshTokenTTL)
	}
}

func TestLoad_OTP_CodeLength_Clamped(t *testing.T) {
	baseEnv(t)

	t.Setenv("OTP_CODE_LENGTH", "2") // below min=4 → clamped to 4
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.OTP.CodeLength != 4 {
		t.Errorf("OTP.CodeLength = %d, want 4 (clamped)", cfg.OTP.CodeLength)
	}

	t.Setenv("OTP_CODE_LENGTH", "99") // above max=8 → clamped to 8
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.OTP.CodeLength != 8 {
		t.Errorf("OTP.CodeLength = %d, want 8 (clamped)", cfg.OTP.CodeLength)
	}

	t.Setenv("OTP_CODE_LENGTH", "6")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.OTP.CodeLength != 6 {
		t.Errorf("OTP.CodeLength = %d, want 6", cfg.OTP.CodeLength)
	}
}

func TestLoad_StorageS3ForcePathStyle_Parsed(t *testing.T) {
	baseEnv(t)
	t.Setenv("STORAGE_S3_FORCE_PATH_STYLE", "false")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Storage.S3ForcePathStyle {
		t.Error("S3ForcePathStyle should be false")
	}
}

func TestLoad_StorageS3ForcePathStyle_DefaultTrue(t *testing.T) {
	baseEnv(t)
	t.Setenv("STORAGE_S3_FORCE_PATH_STYLE", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Storage.S3ForcePathStyle {
		t.Error("S3ForcePathStyle default should be true")
	}
}

// ---------------------------------------------------------------------------
// CSV list parsing
// ---------------------------------------------------------------------------

func TestLoad_CORSOrigins_CSV(t *testing.T) {
	baseEnv(t)
	t.Setenv("CORS_ORIGINS", "https://a.com, https://b.com , https://c.com")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.CORSOrigins) != 3 {
		t.Fatalf("CORSOrigins len = %d, want 3; got %v", len(cfg.CORSOrigins), cfg.CORSOrigins)
	}
}

func TestLoad_PlatformAdminEmails_CSV(t *testing.T) {
	baseEnv(t)
	t.Setenv("PLATFORM_ADMIN_EMAILS", "admin@a.com,superuser@b.com")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.PlatformAdminEmails) != 2 {
		t.Fatalf("PlatformAdminEmails len = %d, want 2; got %v", len(cfg.PlatformAdminEmails), cfg.PlatformAdminEmails)
	}
}

func TestLoad_PlatformAdminEmails_Empty(t *testing.T) {
	baseEnv(t)
	t.Setenv("PLATFORM_ADMIN_EMAILS", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PlatformAdminEmails != nil {
		t.Errorf("PlatformAdminEmails = %v, want nil when unset", cfg.PlatformAdminEmails)
	}
}

// ---------------------------------------------------------------------------
// SameSite parsing
// ---------------------------------------------------------------------------

func TestLoad_SameSite_None_SetsSecureCookies(t *testing.T) {
	baseEnv(t)
	t.Setenv("SESSION_COOKIE_SAMESITE", "none")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SessionSameSite != http.SameSiteNoneMode {
		t.Errorf("SessionSameSite = %v, want None", cfg.SessionSameSite)
	}
	// None requires Secure, so SecureCookies should be promoted to true.
	if !cfg.SecureCookies {
		t.Error("SecureCookies should be true when SameSite=None")
	}
}

func TestLoad_SameSite_Strict(t *testing.T) {
	baseEnv(t)
	t.Setenv("SESSION_COOKIE_SAMESITE", "strict")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SessionSameSite != http.SameSiteStrictMode {
		t.Errorf("SessionSameSite = %v, want Strict", cfg.SessionSameSite)
	}
}

func TestLoad_SameSite_Empty_DefaultsLax(t *testing.T) {
	baseEnv(t)
	t.Setenv("SESSION_COOKIE_SAMESITE", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SessionSameSite != http.SameSiteLaxMode {
		t.Errorf("SessionSameSite = %v, want Lax", cfg.SessionSameSite)
	}
}

func TestLoad_SameSite_Unknown_DefaultsLax(t *testing.T) {
	baseEnv(t)
	t.Setenv("SESSION_COOKIE_SAMESITE", "garbage")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SessionSameSite != http.SameSiteLaxMode {
		t.Errorf("SessionSameSite = %v, want Lax for unknown value", cfg.SessionSameSite)
	}
}

// ---------------------------------------------------------------------------
// IsDev helper
// ---------------------------------------------------------------------------

func TestIsDev(t *testing.T) {
	cases := []struct {
		env  string
		want bool
	}{
		{"dev", true},
		{"test", true},
		{"prod", false},
		{"staging", false},
		{"", false},
	}
	for _, tc := range cases {
		c := Config{Env: tc.env}
		if got := c.IsDev(); got != tc.want {
			t.Errorf("IsDev(%q) = %v, want %v", tc.env, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// SecureCookies set correctly
// ---------------------------------------------------------------------------

func TestLoad_SecureCookies_TrueInProd(t *testing.T) {
	t.Setenv("APP_ENV", "prod")
	t.Setenv("DATABASE_URL", "postgresql://localhost/testdb")
	t.Setenv("SESSION_SECRET", "12345678901234567890123456789012")
	t.Setenv("CORS_ORIGINS", "https://example.com")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.SecureCookies {
		t.Error("SecureCookies should be true in prod")
	}
}

func TestLoad_SecureCookies_FalseInDev(t *testing.T) {
	baseEnv(t)
	t.Setenv("SESSION_COOKIE_SAMESITE", "lax") // not none

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SecureCookies {
		t.Error("SecureCookies should be false in dev (unless SameSite=None)")
	}
}

// ---------------------------------------------------------------------------
// Google config presence
// ---------------------------------------------------------------------------

func TestLoad_GoogleConfig_Populated(t *testing.T) {
	baseEnv(t)
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "id123")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "secret456")
	t.Setenv("GOOGLE_OAUTH_REDIRECT_URL", "https://example.com/callback")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Google.ClientID != "id123" {
		t.Errorf("Google.ClientID = %q", cfg.Google.ClientID)
	}
	if cfg.Google.ClientSecret != "secret456" {
		t.Errorf("Google.ClientSecret = %q", cfg.Google.ClientSecret)
	}
	if cfg.Google.RedirectURL != "https://example.com/callback" {
		t.Errorf("Google.RedirectURL = %q", cfg.Google.RedirectURL)
	}
}

func TestLoad_GoogleConfig_EmptyWhenNotSet(t *testing.T) {
	baseEnv(t)
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "")
	t.Setenv("GOOGLE_OAUTH_REDIRECT_URL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Google.ClientID != "" || cfg.Google.ClientSecret != "" {
		t.Error("Google config should be empty when env vars are not set")
	}
}

// ---------------------------------------------------------------------------
// Mail / SendGrid priority
// ---------------------------------------------------------------------------

func TestLoad_Mail_SendGridAPIKeyPriority(t *testing.T) {
	baseEnv(t)
	t.Setenv("SENDGRID_API_KEY", "sg-key-xxx")
	t.Setenv("MAIL_SMTP_PASSWORD", "fallback")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Mail.Password != "sg-key-xxx" {
		t.Errorf("Mail.Password = %q, want SENDGRID_API_KEY", cfg.Mail.Password)
	}
}

func TestLoad_Mail_FallbackToSMTPPassword(t *testing.T) {
	baseEnv(t)
	t.Setenv("SENDGRID_API_KEY", "")
	t.Setenv("MAIL_SMTP_PASSWORD", "smtp-pass")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Mail.Password != "smtp-pass" {
		t.Errorf("Mail.Password = %q, want MAIL_SMTP_PASSWORD fallback", cfg.Mail.Password)
	}
}

// ---------------------------------------------------------------------------
// internal helpers (parseBool, parseIntDefault, clampInt, splitCSV)
// ---------------------------------------------------------------------------

func TestParseBool(t *testing.T) {
	cases := []struct {
		in   string
		def  bool
		want bool
	}{
		{"1", false, true},
		{"true", false, true},
		{"yes", false, true},
		{"y", false, true},
		{"on", false, true},
		{"TRUE", false, true},
		{"0", true, false},
		{"false", true, false},
		{"no", true, false},
		{"n", true, false},
		{"off", true, false},
		{"", true, true},        // empty → default=true
		{"", false, false},      // empty → default=false
		{"garbage", true, true}, // unknown → default
	}
	for _, tc := range cases {
		got := parseBool(tc.in, tc.def)
		if got != tc.want {
			t.Errorf("parseBool(%q, %v) = %v, want %v", tc.in, tc.def, got, tc.want)
		}
	}
}

func TestParseIntDefault(t *testing.T) {
	cases := []struct {
		s    string
		def  int
		want int
	}{
		{"42", 0, 42},
		{"0", 99, 0},
		{"", 7, 7},
		{"nope", 7, 7},
		{"-1", 5, -1},
	}
	for _, tc := range cases {
		got := parseIntDefault(tc.s, tc.def)
		if got != tc.want {
			t.Errorf("parseIntDefault(%q, %d) = %d, want %d", tc.s, tc.def, got, tc.want)
		}
	}
}

func TestClampInt(t *testing.T) {
	cases := []struct {
		v, lo, hi int
		want      int
	}{
		{5, 1, 10, 5},
		{0, 1, 10, 1},
		{15, 1, 10, 10},
		{1, 1, 10, 1},
		{10, 1, 10, 10},
	}
	for _, tc := range cases {
		got := clampInt(tc.v, tc.lo, tc.hi)
		if got != tc.want {
			t.Errorf("clampInt(%d,%d,%d) = %d, want %d", tc.v, tc.lo, tc.hi, got, tc.want)
		}
	}
}

func TestSplitCSV(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"a", []string{"a"}},
		{"a,b,c", []string{"a", "b", "c"}},
		{" a , b , c ", []string{"a", "b", "c"}},
		{"a,,b", []string{"a", "b"}}, // empty parts dropped
		{",", nil},
	}
	for _, tc := range cases {
		got := splitCSV(tc.in)
		if len(got) != len(tc.want) {
			t.Errorf("splitCSV(%q) = %v (len %d), want %v (len %d)", tc.in, got, len(got), tc.want, len(tc.want))
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("splitCSV(%q)[%d] = %q, want %q", tc.in, i, got[i], tc.want[i])
			}
		}
	}
}

func TestParseSameSite(t *testing.T) {
	cases := []struct {
		in   string
		want http.SameSite
	}{
		{"none", http.SameSiteNoneMode},
		{"None", http.SameSiteNoneMode},
		{"NONE", http.SameSiteNoneMode},
		{"strict", http.SameSiteStrictMode},
		{"Strict", http.SameSiteStrictMode},
		{"lax", http.SameSiteLaxMode},
		{"Lax", http.SameSiteLaxMode},
		{"", http.SameSiteLaxMode},
		{"unknown", http.SameSiteLaxMode},
	}
	for _, tc := range cases {
		got := parseSameSite(tc.in)
		if got != tc.want {
			t.Errorf("parseSameSite(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestFirstNonEmpty(t *testing.T) {
	cases := []struct {
		vals []string
		want string
	}{
		{[]string{"a", "b"}, "a"},
		{[]string{"", "b"}, "b"},
		{[]string{"", ""}, ""},
		{[]string{}, ""},
		{[]string{"x"}, "x"},
	}
	for _, tc := range cases {
		got := firstNonEmpty(tc.vals...)
		if got != tc.want {
			t.Errorf("firstNonEmpty(%v) = %q, want %q", tc.vals, got, tc.want)
		}
	}
}

func TestParseDurationDefault(t *testing.T) {
	cases := []struct {
		s    string
		def  time.Duration
		want time.Duration
	}{
		{"5m", time.Minute, 5 * time.Minute},
		{"1h", time.Minute, time.Hour},
		{"", 15 * time.Minute, 15 * time.Minute},
		{"notaduration", time.Hour, time.Hour},
		{"0s", time.Minute, time.Minute},  // 0 or negative → default
		{"-1s", time.Minute, time.Minute}, // negative → default
	}
	for _, tc := range cases {
		got := parseDurationDefault(tc.s, tc.def)
		if got != tc.want {
			t.Errorf("parseDurationDefault(%q, %v) = %v, want %v", tc.s, tc.def, got, tc.want)
		}
	}
}
