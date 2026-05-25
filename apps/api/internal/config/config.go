package config

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"

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
	SessionSecret   string
	// PostLoginRedirectURL is where Google's callback sends the browser
	// after a successful login. Empty falls back to "/" on the API origin —
	// fine for single-origin deploys. Set to the SPA origin (e.g.
	// "http://localhost:5891/") when the FE and API live on different ports.
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
}

// OTPConfig tunes the email-OTP login flow. All knobs are env-driven so
// production can adjust rate limits without a redeploy.
type OTPConfig struct {
	CodeLength       int // digits per code; clamped to [4, 8]
	TTLSeconds       int // how long a freshly issued code remains valid
	ResendCooldown   int // min seconds between sends to the same email
	MaxAttempts      int // verifies allowed against one code before it's force-consumed
	IPHourlyCap      int // max un-consumed sends per IP over the last hour
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
		Env:           envOr("APP_ENV", "dev"),
		HTTPAddr:      envOr("HTTP_ADDR", ":8080"),
		DatabaseURL:   app,
		RootDomain:    envOr("ROOT_DOMAIN", "localhost"),
		CORSOrigins:   splitCSV(envOr("CORS_ORIGINS", "http://localhost:5891")),
		SessionSecret:        os.Getenv("SESSION_SECRET"),
		PostLoginRedirectURL: os.Getenv("POST_LOGIN_REDIRECT_URL"),
		Google: auth.GoogleConfig{
			ClientID:     os.Getenv("GOOGLE_OAUTH_CLIENT_ID"),
			ClientSecret: os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("GOOGLE_OAUTH_REDIRECT_URL"),
		},
		LogLevel:  os.Getenv("LOG_LEVEL"),
		LogFormat: os.Getenv("LOG_FORMAT"),
		Storage: StorageConfig{
			Driver:            envOr("STORAGE_DRIVER", "local"),
			LocalRoot:         envOr("STORAGE_LOCAL_ROOT", "./uploads"),
			LocalPublicBase:   envOr("STORAGE_LOCAL_PUBLIC_BASE", "/uploads"),
			S3Endpoint:        os.Getenv("STORAGE_S3_ENDPOINT"),
			S3Region:          os.Getenv("STORAGE_S3_REGION"),
			S3Bucket:           os.Getenv("STORAGE_S3_BUCKET"),
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
			IPHourlyCap:    parseIntDefault(os.Getenv("OTP_IP_HOURLY_CAP"), 10),
		},
	}
	c.SecureCookies = c.Env == "prod"
	c.SessionSameSite = parseSameSite(os.Getenv("SESSION_COOKIE_SAMESITE"))
	// SameSite=None requires Secure; quietly upgrade so misconfig in dev
	// doesn't silently produce cookies the browser drops.
	if c.SessionSameSite == http.SameSiteNoneMode {
		c.SecureCookies = true
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL required")
	}
	return c, nil
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
