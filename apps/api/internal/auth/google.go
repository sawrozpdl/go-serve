package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

// GoogleConfig holds the OAuth client config; populated from env in main.
type GoogleConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
}

// IsConfigured returns true when Google OIDC env vars are present.
func (g GoogleConfig) IsConfigured() bool {
	return g.ClientID != "" && g.ClientSecret != "" && g.RedirectURL != ""
}

const (
	oauthStateCookie = "cafe_oauth_state"
	oauthStateTTL    = 10 * time.Minute
)

// GoogleProvider exposes the start + callback handlers.
type GoogleProvider struct {
	pool                 *pgxpool.Pool
	rootDomain           string
	secureCookies        bool
	postLoginRedirectURL string
	verifier             *oidc.IDTokenVerifier
	cfg                  *oauth2.Config
}

// NewGoogle creates a provider; returns nil if Google isn't configured.
// postLoginRedirectURL controls where the callback sends the browser on
// success; empty means "/" on the API origin (single-origin deploys).
func NewGoogle(ctx context.Context, gc GoogleConfig, pool *pgxpool.Pool, rootDomain string, secureCookies bool, postLoginRedirectURL string) (*GoogleProvider, error) {
	if !gc.IsConfigured() {
		return nil, nil
	}
	provider, err := oidc.NewProvider(ctx, "https://accounts.google.com")
	if err != nil {
		return nil, fmt.Errorf("oidc provider: %w", err)
	}
	return &GoogleProvider{
		pool:                 pool,
		rootDomain:           rootDomain,
		secureCookies:        secureCookies,
		postLoginRedirectURL: postLoginRedirectURL,
		verifier:             provider.Verifier(&oidc.Config{ClientID: gc.ClientID}),
		cfg: &oauth2.Config{
			ClientID:     gc.ClientID,
			ClientSecret: gc.ClientSecret,
			RedirectURL:  gc.RedirectURL,
			Endpoint:     provider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
		},
	}, nil
}

// Start redirects to Google's consent screen.
func (g *GoogleProvider) Start(w http.ResponseWriter, r *http.Request) {
	state, err := randomHex(16)
	if err != nil {
		http.Error(w, "internal", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookie,
		Value:    state,
		Path:     "/",
		MaxAge:   int(oauthStateTTL.Seconds()),
		HttpOnly: true,
		Secure:   g.secureCookies,
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, g.cfg.AuthCodeURL(state), http.StatusFound)
}

// Callback handles the redirect back from Google.
func (g *GoogleProvider) Callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	if state == "" {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "missing_state")
		http.Error(w, "missing state", http.StatusBadRequest)
		return
	}
	c, err := r.Cookie(oauthStateCookie)
	if err != nil || c.Value != state {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "state_mismatch")
		http.Error(w, "state mismatch", http.StatusBadRequest)
		return
	}
	// Clear state cookie.
	http.SetCookie(w, &http.Cookie{Name: oauthStateCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})

	code := r.URL.Query().Get("code")
	if code == "" {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "missing_code")
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}
	tok, err := g.cfg.Exchange(r.Context(), code)
	if err != nil {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "exchange_failed")
		http.Error(w, "exchange failed", http.StatusBadRequest)
		return
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok || rawID == "" {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "no_id_token")
		http.Error(w, "no id_token", http.StatusBadRequest)
		return
	}
	idTok, err := g.verifier.Verify(r.Context(), rawID)
	if err != nil {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "id_token_invalid")
		http.Error(w, "id_token invalid", http.StatusBadRequest)
		return
	}
	var claims struct {
		Sub     string `json:"sub"`
		Email   string `json:"email"`
		Name    string `json:"name"`
		Picture string `json:"picture"`
	}
	if err := idTok.Claims(&claims); err != nil || claims.Email == "" {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "missing_claims")
		http.Error(w, "missing claims", http.StatusBadRequest)
		return
	}

	userID, err := LookupOrCreateUser(r.Context(), g.pool, claims.Sub, claims.Email, claims.Name, claims.Picture)
	if err != nil {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", claims.Email, nil, r.RemoteAddr, r.UserAgent(), "user_upsert_failed")
		http.Error(w, "user upsert", http.StatusInternalServerError)
		return
	}
	// Auto-accept any pending tenant_invites for this verified email.
	// Best-effort: a failure here mustn't block the login flow.
	_, _ = AcceptPendingInvites(r.Context(), g.pool, userID, claims.Email)

	// Google authenticated identity only — we sign our own tokens. The
	// callback is a redirect (can't return JSON), and the session cookie is
	// blocked cross-site on iOS, so hand the SPA a single-use code it
	// exchanges for the access+refresh pair via POST /auth/exchange. Keeps
	// tokens out of URL history.
	handoffCode, err := CreateHandoffCode(r.Context(), g.pool, userID, r.RemoteAddr)
	if err != nil {
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", claims.Email, &userID, r.RemoteAddr, r.UserAgent(), "handoff_create_failed")
		http.Error(w, "login handoff", http.StatusInternalServerError)
		return
	}
	LogAuthEvent(r.Context(), AuthLoginSuccess, "google", claims.Email, &userID, r.RemoteAddr, r.UserAgent(), "")

	// Redirect to the SPA's /auth/callback?code=..., or "/" on the API host
	// when FE+API share an origin (local dev via the Vite proxy).
	dest := g.postLoginRedirectURL
	if dest == "" {
		dest = "/"
	}
	sep := "?"
	if strings.Contains(dest, "?") {
		sep = "&"
	}
	http.Redirect(w, r, dest+sep+"code="+url.QueryEscape(handoffCode), http.StatusFound)
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
