package auth

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Access-token JWTs are signed HS256 with SESSION_SECRET. The API is the sole
// signer and verifier, so a symmetric key is the right tool (no need for
// asymmetric RS256). iss/aud are pinned so a token minted for this API can't
// be replayed against a different service that happens to share the secret.
const (
	jwtIssuer   = "goserve-api"
	jwtAudience = "goserve-spa"
	jwtLeeway   = 30 * time.Second
)

var (
	// tokenSigningKey + TTLs are configured once at startup via SetTokenConfig.
	tokenSigningKey []byte
	accessTokenTTL  = 15 * time.Minute
	refreshTokenTTL = 30 * 24 * time.Hour
)

// SetTokenConfig wires the JWT signing key and lifetimes. Call once at startup
// before serving. In dev an empty secret falls back to a fixed insecure key so
// the app boots without ceremony; prod rejects a weak secret in config.Load.
func SetTokenConfig(secret string, accessTTL, refreshTTL time.Duration) {
	if secret != "" {
		tokenSigningKey = []byte(secret)
	} else if tokenSigningKey == nil {
		tokenSigningKey = []byte("dev-insecure-signing-key-do-not-use-in-prod")
	}
	if accessTTL > 0 {
		accessTokenTTL = accessTTL
	}
	if refreshTTL > 0 {
		refreshTokenTTL = refreshTTL
	}
}

// RefreshTTL exposes the configured refresh-token lifetime for session inserts.
func RefreshTTL() time.Duration { return refreshTokenTTL }

// AccessClaims is the access-token payload. sub (user id), sid (refresh-family
// / session id), and tv (token_version) are the load-bearing custom claims.
type AccessClaims struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	TV    int    `json:"tv"`
	SID   string `json:"sid"`
	jwt.RegisteredClaims
}

// MintAccessToken signs a short-lived access token. exp is returned so callers
// can report access_expires_in to the client.
func MintAccessToken(userID uuid.UUID, email, name string, sid uuid.UUID, tv int) (token string, exp time.Time, err error) {
	now := time.Now()
	exp = now.Add(accessTokenTTL)
	claims := AccessClaims{
		Email: email,
		Name:  name,
		TV:    tv,
		SID:   sid.String(),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	token, err = t.SignedString(tokenSigningKey)
	return token, exp, err
}

// ParseAccessToken verifies the signature and standard claims. The signing
// method is pinned to HS256 (jwt.WithValidMethods) to defeat alg:none and
// RS↔HS key-confusion attacks.
func ParseAccessToken(raw string) (*AccessClaims, error) {
	claims := &AccessClaims{}
	_, err := jwt.ParseWithClaims(raw, claims,
		func(*jwt.Token) (any, error) { return tokenSigningKey, nil },
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithIssuer(jwtIssuer),
		jwt.WithAudience(jwtAudience),
		jwt.WithLeeway(jwtLeeway),
	)
	if err != nil {
		return nil, err
	}
	return claims, nil
}
