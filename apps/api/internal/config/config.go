package config

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/auth"
)

type Config struct {
	Env             string
	HTTPAddr        string
	DatabaseURL     string
	RootDomain      string
	CORSOrigins     []string
	SecureCookies   bool
	SessionSameSite http.SameSite
	Google          auth.GoogleConfig
	// SessionSecret signs the access-token JWTs (HS256). Required and must be
	// >=32 bytes in prod — validated in Load().
	SessionSecret string
	// AccessTokenTTL / RefreshTokenTTL tune the JWT auth lifetimes. Access
	// tokens are short (stateless, no DB hit on validation); refresh tokens
	// are long-lived, opaque, stored hashed in `sessions`, and rotated on use.
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
	// PostLoginRedirectURL is where Google's callback sends the browser after
	// a successful login. With JWT auth this is the SPA's /auth/callback route
	// (e.g. "https://goserve.vercel.app/auth/callback"), which exchanges the
	// one-time handoff code for tokens. Empty falls back to "/" on the API
	// origin (single-origin / local dev with a Vite proxy).
	PostLoginRedirectURL string
	// LogLevel: debug|info|warn|error. Default info. Set LOG_LEVEL=debug
	// in dev to surface per-handler entry/decision traces.
	LogLevel string
	// LogFormat: pretty|json. Empty defaults to pretty in dev/test, json
	// in prod. JSON is what log shippers expect; pretty is for humans.
	LogFormat string
	Storage   StorageConfig
	Mail      MailConfig
	OTP       OTPConfig
	RateLimit RateLimitConfig
	Alert     AlertConfig
	// PlatformAdminEmails bootstraps the site-wide super admins. Any user who
	// logs in with an email in this allowlist is upserted into platform_admins,
	// gaining access to the /super console. Comma-separated, case-insensitive.
	PlatformAdminEmails []string
}

// OTPConfig tunes the email-OTP login flow. All knobs are env-driven so
// production can adjust rate limits without a redeploy.
type OTPConfig struct {
	CodeLength     int // digits per code; clamped to [4, 8]
	TTLSeconds     int // how long a freshly issued code remains valid
	ResendCooldown int // min seconds between sends to the same email
	MaxAttempts    int // verifies allowed against one code before it's force-consumed
	// EmailHourlyCap is the primary abuse gate: max code requests for a single
	// EMAIL over the trailing hour. Keyed on the mailbox (not the IP) so
	// co-located staff behind one café NAT never block each other's login.
	EmailHourlyCap int
	// IPHourlyCap is a LOOSE per-IP backstop against a single abusive host over
	// the trailing hour. Kept generous on purpose — a whole café shares one
	// public IP, so a tight value here would rate-limit legitimate first logins.
	IPHourlyCap int
}

// RateLimitConfig tunes the per-IP rate limiters layered across the HTTP
// surface. Every endpoint is covered by the global envelope; the others
// tighten specific surfaces. All knobs are env-driven so production can adjust
// without a redeploy. Counts are "requests per IP per window".
type RateLimitConfig struct {
	GlobalPerMin         int // global envelope across ALL endpoints
	PublicPerMin         int // /public/* group (scrape-able anonymous surface)
	AuthPerMin           int // /auth/* group (login / refresh); OTP send/verify are exempt (they self-throttle per-email)
	RequestAccessPerMin  int // POST /public/request-access — burst cap
	RequestAccessPerHour int // POST /public/request-access — sustained cap
}

// MailConfig configures the SMTP relay used for shift-end summaries. The
// system runs fine without it — sends become no-ops when any required field
// is unset. SendGrid is the default target (host=smtp.sendgrid.net,
// username=apikey, password=<SENDGRID_API_KEY>), but any compatible relay
// works because we speak vanilla SMTP-over-STARTTLS.
type MailConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	FromName string
}

// StorageConfig selects the blob backend used for tenant uploads. Driver
// "local" writes under LocalRoot and serves via the API's /uploads handler.
// Driver "s3" talks to any S3-compatible endpoint (Supabase Storage, AWS S3,
// R2, B2, MinIO) — the differences are entirely env-config.
type StorageConfig struct {
	Driver string

	LocalRoot       string
	LocalPublicBase string

	S3Endpoint        string
	S3Region          string
	S3Bucket          string
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3PublicURLBase   string
	S3ForcePathStyle  bool
}

// AlertConfig configures out-of-band operational alerts (see internal/alert).
// Alerts are supplementary to structured logs, which always ship to the log
// aggregator; a missing webhook simply means no push notifications (the
// CloudWatch ERROR-log alarms still apply in prod).
type AlertConfig struct {
	// WebhookURL is a Slack/Mattermost-compatible incoming webhook. Empty
	// disables push alerts.
	WebhookURL string
	// Throttle is the minimum interval between alerts sharing an event key,
	// collapsing storms during an outage. Default 5m.
	Throttle time.Duration
}

func Load() (Config, error) {
	// In dev, fill in any missing env from a `.env` walked up from cwd. In
	// prod (APP_ENV=prod) this is a no-op — env must come from the platform.
	loadDotEnv()

	// APP_DATABASE_URL connects as the non-superuser app role (RLS applies).
	// DATABASE_URL is the admin URL used by migrations/seed and is the
	// fallback if APP_DATABASE_URL is unset.
	app := os.Getenv("APP_DATABASE_URL")
	if app == "" {
		app = os.Getenv("DATABASE_URL")
	}

	c := Config{
		Env:                  envOr("APP_ENV", "dev"),
		HTTPAddr:             envOr("HTTP_ADDR", ":8080"),
		DatabaseURL:          app,
		RootDomain:           envOr("ROOT_DOMAIN", "localhost"),
		CORSOrigins:          splitCSV(envOr("CORS_ORIGINS", "http://localhost:5891")),
		SessionSecret:        os.Getenv("SESSION_SECRET"),
		PostLoginRedirectURL: os.Getenv("POST_LOGIN_REDIRECT_URL"),
		Google: auth.GoogleConfig{
			ClientID:     os.Getenv("GOOGLE_OAUTH_CLIENT_ID"),
			ClientSecret: os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("GOOGLE_OAUTH_REDIRECT_URL"),
			// Native mobile sign-in client IDs (no secret): the app obtains a
			// Google ID token directly and posts it to /auth/google/native, where
			// its audience is validated against any of these. The Android client
			// is matched by package name + SHA-1 in Google Cloud (no ID needed
			// server-side, but accept it as an audience if the token carries it).
			ClientIDAndroid: os.Getenv("GOOGLE_OAUTH_CLIENT_ID_ANDROID"),
			ClientIDIOS:     os.Getenv("GOOGLE_OAUTH_CLIENT_ID_IOS"),
		},
		LogLevel:  os.Getenv("LOG_LEVEL"),
		LogFormat: os.Getenv("LOG_FORMAT"),
		Storage: StorageConfig{
			Driver:            envOr("STORAGE_DRIVER", "local"),
			LocalRoot:         envOr("STORAGE_LOCAL_ROOT", "./uploads"),
			LocalPublicBase:   envOr("STORAGE_LOCAL_PUBLIC_BASE", "/uploads"),
			S3Endpoint:        os.Getenv("STORAGE_S3_ENDPOINT"),
			S3Region:          os.Getenv("STORAGE_S3_REGION"),
			S3Bucket:          os.Getenv("STORAGE_S3_BUCKET"),
			S3AccessKeyID:     os.Getenv("STORAGE_S3_ACCESS_KEY_ID"),
			S3SecretAccessKey: os.Getenv("STORAGE_S3_SECRET_ACCESS_KEY"),
			S3PublicURLBase:   os.Getenv("STORAGE_S3_PUBLIC_URL_BASE"),
			S3ForcePathStyle:  parseBool(os.Getenv("STORAGE_S3_FORCE_PATH_STYLE"), true),
		},
		Mail: MailConfig{
			Host:     envOr("MAIL_SMTP_HOST", "smtp.sendgrid.net"),
			Port:     parseIntDefault(os.Getenv("MAIL_SMTP_PORT"), 587),
			Username: envOr("MAIL_SMTP_USERNAME", "apikey"),
			// Prefer SENDGRID_API_KEY when set (matches the SendGrid docs); fall
			// back to MAIL_SMTP_PASSWORD for other relays.
			Password: firstNonEmpty(os.Getenv("SENDGRID_API_KEY"), os.Getenv("MAIL_SMTP_PASSWORD")),
			From:     os.Getenv("MAIL_FROM"),
			FromName: os.Getenv("MAIL_FROM_NAME"),
		},
		OTP: OTPConfig{
			CodeLength:     clampInt(parseIntDefault(os.Getenv("OTP_CODE_LENGTH"), 6), 4, 8),
			TTLSeconds:     parseIntDefault(os.Getenv("OTP_TTL_SECONDS"), 600),
			ResendCooldown: parseIntDefault(os.Getenv("OTP_RESEND_COOLDOWN_SECONDS"), 60),
			MaxAttempts:    parseIntDefault(os.Getenv("OTP_MAX_ATTEMPTS"), 5),
			EmailHourlyCap: parseIntDefault(os.Getenv("OTP_EMAIL_HOURLY_CAP"), 8),
			IPHourlyCap:    parseIntDefault(os.Getenv("OTP_IP_HOURLY_CAP"), 60),
		},
		RateLimit: RateLimitConfig{
			GlobalPerMin:         parseIntDefault(os.Getenv("RATE_LIMIT_GLOBAL_PER_MIN"), 600),
			PublicPerMin:         parseIntDefault(os.Getenv("RATE_LIMIT_PUBLIC_PER_MIN"), 120),
			AuthPerMin:           parseIntDefault(os.Getenv("RATE_LIMIT_AUTH_PER_MIN"), 120),
			RequestAccessPerMin:  parseIntDefault(os.Getenv("RATE_LIMIT_REQUEST_ACCESS_PER_MIN"), 2),
			RequestAccessPerHour: parseIntDefault(os.Getenv("RATE_LIMIT_REQUEST_ACCESS_PER_HOUR"), 10),
		},
		PlatformAdminEmails: splitCSV(os.Getenv("PLATFORM_ADMIN_EMAILS")),
		Alert: AlertConfig{
			WebhookURL: os.Getenv("ALERT_WEBHOOK_URL"),
			Throttle:   parseDurationDefault(os.Getenv("ALERT_THROTTLE"), 5*time.Minute),
		},
	}
	c.SecureCookies = c.Env == "prod"
	c.SessionSameSite = parseSameSite(os.Getenv("SESSION_COOKIE_SAMESITE"))
	// SameSite=None requires Secure; quietly upgrade so misconfig in dev
	// doesn't silently produce cookies the browser drops.
	if c.SessionSameSite == http.SameSiteNoneMode {
		c.SecureCookies = true
	}
	c.AccessTokenTTL = parseDurationDefault(os.Getenv("ACCESS_TOKEN_TTL"), 15*time.Minute)
	c.RefreshTokenTTL = parseDurationDefault(os.Getenv("REFRESH_TOKEN_TTL"), 30*24*time.Hour)
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL required")
	}
	// SESSION_SECRET signs the access-token JWTs. In dev we tolerate a missing
	// secret (handlers fall back to a fixed dev key) so the app boots without
	// ceremony; in prod a weak/absent secret is a hard error.
	if !c.IsDev() && len(c.SessionSecret) < 32 {
		return c, fmt.Errorf("SESSION_SECRET must be set and at least 32 bytes in prod")
	}
	// The CORS handler runs with AllowCredentials=true, and a wildcard origin
	// alongside credentials lets any site drive the authed API. Refuse to boot
	// rather than serve that combination in prod.
	if !c.IsDev() {
		for _, o := range c.CORSOrigins {
			if strings.TrimSpace(o) == "*" {
				return c, fmt.Errorf("CORS_ORIGINS must list explicit origins in prod (wildcard is incompatible with credentialed requests)")
			}
		}
	}
	return c, nil
}

func parseDurationDefault(s string, def time.Duration) time.Duration {
	if s == "" {
		return def
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return def
	}
	return d
}

// parseSameSite maps a string to http.SameSite. Defaults to Lax. "None" is
// only useful when the FE and API live on different registrable domains —
// see docs/DEPLOY.md.
func parseSameSite(s string) http.SameSite {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "none":
		return http.SameSiteNoneMode
	case "strict":
		return http.SameSiteStrictMode
	case "", "lax":
		return http.SameSiteLaxMode
	default:
		return http.SameSiteLaxMode
	}
}

func (c Config) IsDev() bool { return c.Env == "dev" || c.Env == "test" }

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseBool(s string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "y", "on":
		return true
	case "0", "false", "no", "n", "off":
		return false
	default:
		return def
	}
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func parseIntDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
