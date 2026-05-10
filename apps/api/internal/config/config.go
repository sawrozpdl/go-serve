package config

import (
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/pewssh/cafe-mgmt/api/internal/auth"
)

type Config struct {
	Env              string
	HTTPAddr         string
	DatabaseURL      string
	RootDomain       string
	CORSOrigins      []string
	SecureCookies    bool
	SessionSameSite  http.SameSite
	Google           auth.GoogleConfig
	SessionSecret    string
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
		SessionSecret: os.Getenv("SESSION_SECRET"),
		Google: auth.GoogleConfig{
			ClientID:     os.Getenv("GOOGLE_OAUTH_CLIENT_ID"),
			ClientSecret: os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("GOOGLE_OAUTH_REDIRECT_URL"),
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
