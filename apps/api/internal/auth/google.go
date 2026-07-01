package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// GoogleConfig holds the OAuth client config; populated from env in main.
type GoogleConfig struct {
	// Web client — drives the browser redirect flow (used by the web SPA).
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// Native mobile client IDs — the app posts a Google ID token minted with
	// one of these to /auth/google/native. No secret is used for that flow.
	ClientIDAndroid string
	ClientIDIOS     string
}

// IsConfigured returns true when the browser (web SPA) OIDC flow is configured.
func (g GoogleConfig) IsConfigured() bool {
	return g.ClientID != "" && g.ClientSecret != "" && g.RedirectURL != ""
}

// nativeAudiences returns every client ID that a native ID token may be issued
// for (web is included because @react-native-google-signin sets the ID token's
// audience to the configured webClientId "server client ID").
func (g GoogleConfig) nativeAudiences() []string {
	out := make([]string, 0, 3)
	for _, id := range []string{g.ClientID, g.ClientIDAndroid, g.ClientIDIOS} {
		if id != "" {
			out = append(out, id)
		}
	}
	return out
}

const (
	oauthStateCookie    = "cafe_oauth_state"
	oauthRedirectCookie = "cafe_oauth_redirect"
	oauthStateTTL       = 10 * time.Minute
	// App-scheme prefix the native app registers (see apps/mobile app.json
	// `scheme`). Only app-scheme return URLs are honored for the dynamic
	// `redirect` param, so it can never be abused as an open HTTP redirect.
	allowedMobileRedirectPrefix = "goserve://"
)

// isAllowedMobileRedirect gates the optional `redirect` param to the native app
// scheme only — never an arbitrary http(s) URL.
func isAllowedMobileRedirect(s string) bool {
	return s != "" && strings.HasPrefix(s, allowedMobileRedirectPrefix)
}

// GoogleProvider exposes the start + callback + native handlers.
type GoogleProvider struct {
	pool                 *pgxpool.Pool
	rootDomain           string
	secureCookies        bool
	postLoginRedirectURL string
	verifier             *oidc.IDTokenVerifier
	cfg                  *oauth2.Config
	// Native sign-in: verifies signature/issuer/expiry but not audience (we
	// accept any of the configured client IDs — checked manually).
	nativeVerifier  *oidc.IDTokenVerifier
	nativeAudiences []string
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
		// Audience is validated manually against nativeAudiences so a token
		// minted for the web, Android, or iOS client is all accepted.
		nativeVerifier:  provider.Verifier(&oidc.Config{SkipClientIDCheck: true}),
		nativeAudiences: gc.nativeAudiences(),
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
	// Optional native-app return: the mobile app opens this flow with
	// ?redirect=goserve://oauth-callback so the callback can hand the code back
	// to the app instead of the web SPA. Allowlisted to the app scheme only.
	if rd := r.URL.Query().Get("redirect"); isAllowedMobileRedirect(rd) {
		http.SetCookie(w, &http.Cookie{
			Name:     oauthRedirectCookie,
			Value:    rd,
			Path:     "/",
			MaxAge:   int(oauthStateTTL.Seconds()),
			HttpOnly: true,
			Secure:   g.secureCookies,
			SameSite: http.SameSiteLaxMode,
		})
	}
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
		appctx.Logger(r.Context()).ErrorContext(r.Context(), "auth.google.exchange_failed", "err", err.Error())
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
		appctx.Logger(r.Context()).ErrorContext(r.Context(), "auth.google.id_token_invalid", "err", err.Error())
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
		appctx.Logger(r.Context()).ErrorContext(r.Context(), "auth.google.user_upsert_failed", "err", err.Error(), "email", claims.Email)
		LogAuthEvent(r.Context(), AuthLoginFailure, "google", claims.Email, nil, r.RemoteAddr, r.UserAgent(), "user_upsert_failed")
		http.Error(w, "user upsert", http.StatusInternalServerError)
		return
	}
	// Auto-accept any pending tenant_invites for this verified email.
	// Best-effort: a failure here mustn't block the login flow.
	_, _ = AcceptPendingInvites(r.Context(), g.pool, userID, claims.Email)
	// Bootstrap super-admin access from the env allowlist on login.
	SyncPlatformAdmin(r.Context(), g.pool, userID, claims.Email)

	// Google authenticated identity only — we sign our own tokens. The
	// callback is a redirect (can't return JSON), and the session cookie is
	// blocked cross-site on iOS, so hand the SPA a single-use code it
	// exchanges for the access+refresh pair via POST /auth/exchange. Keeps
	// tokens out of URL history.
	handoffCode, err := CreateHandoffCode(r.Context(), g.pool, userID, r.RemoteAddr)
	if err != nil {
		appctx.Logger(r.Context()).ErrorContext(r.Context(), "auth.google.handoff_create_failed", "err", err.Error(), "user_id", userID.String(), "email", claims.Email)
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
	// A native app that started the flow with ?redirect=goserve://… gets the
	// code handed back to the app scheme instead of the web SPA.
	if rc, err := r.Cookie(oauthRedirectCookie); err == nil && isAllowedMobileRedirect(rc.Value) {
		dest = rc.Value
		http.SetCookie(w, &http.Cookie{Name: oauthRedirectCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	}
	sep := "?"
	if strings.Contains(dest, "?") {
		sep = "&"
	}
	http.Redirect(w, r, dest+sep+"code="+url.QueryEscape(handoffCode), http.StatusFound)
}

// NativeSignIn accepts a Google ID token obtained by the native mobile app
// (@react-native-google-signin) and issues our own access+refresh tokens.
// Unlike the browser flow it returns JSON directly — the app made a normal API
// call, not a redirect — so there's no handoff code.
func (g *GoogleProvider) NativeSignIn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}
	var body struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.IDToken) == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "id_token required")
		return
	}
	ctx := r.Context()
	log := appctx.Logger(ctx)

	idTok, err := g.nativeVerifier.Verify(ctx, body.IDToken)
	if err != nil {
		log.InfoContext(ctx, "auth.google_native.id_token_invalid", "err", err.Error())
		LogAuthEvent(ctx, AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "native_id_token_invalid")
		writeErr(w, http.StatusUnauthorized, "id_token_invalid", "Google sign-in token was not valid.")
		return
	}
	if !audienceAllowed(idTok.Audience, g.nativeAudiences) {
		log.InfoContext(ctx, "auth.google_native.audience_mismatch", "aud", strings.Join(idTok.Audience, ","))
		LogAuthEvent(ctx, AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "native_audience_mismatch")
		writeErr(w, http.StatusUnauthorized, "audience_mismatch", "Google token was issued for a different app.")
		return
	}
	var claims struct {
		Sub     string `json:"sub"`
		Email   string `json:"email"`
		Name    string `json:"name"`
		Picture string `json:"picture"`
	}
	if err := idTok.Claims(&claims); err != nil || claims.Email == "" {
		LogAuthEvent(ctx, AuthLoginFailure, "google", "", nil, r.RemoteAddr, r.UserAgent(), "native_missing_claims")
		writeErr(w, http.StatusBadRequest, "missing_claims", "Google token was missing an email.")
		return
	}

	userID, err := LookupOrCreateUser(ctx, g.pool, claims.Sub, claims.Email, claims.Name, claims.Picture)
	if err != nil {
		log.ErrorContext(ctx, "auth.google_native.user_upsert_failed", "err", err.Error(), "email", claims.Email)
		writeErr(w, http.StatusInternalServerError, "internal_error", "user upsert failed")
		return
	}
	_, _ = AcceptPendingInvites(ctx, g.pool, userID, claims.Email)
	SyncPlatformAdmin(ctx, g.pool, userID, claims.Email)
	LogAuthEvent(ctx, AuthLoginSuccess, "google", claims.Email, &userID, r.RemoteAddr, r.UserAgent(), "native")

	if err := IssueTokensForUser(ctx, g.pool, w, userID, r.RemoteAddr, r.UserAgent()); err != nil {
		log.ErrorContext(ctx, "auth.google_native.token_mint_failed", "err", err.Error(), "user_id", userID.String())
		writeErr(w, http.StatusInternalServerError, "internal_error", "token mint failed")
		return
	}
}

// audienceAllowed reports whether any token audience matches an allowed client ID.
func audienceAllowed(aud, allowed []string) bool {
	for _, a := range aud {
		for _, ok := range allowed {
			if a == ok {
				return true
			}
		}
	}
	return false
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
