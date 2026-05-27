package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func init() {
	// Deterministic key for tests.
	SetTokenConfig("test-signing-key-at-least-32-bytes-long!!", 15*time.Minute, 30*24*time.Hour)
}

func TestMintParseRoundTrip(t *testing.T) {
	uid := uuid.New()
	sid := uuid.New()
	tok, exp, err := MintAccessToken(uid, "a@b.com", "Alice", sid, 3)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if !exp.After(time.Now()) {
		t.Fatalf("exp not in future: %v", exp)
	}
	claims, err := ParseAccessToken(tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if claims.Subject != uid.String() || claims.SID != sid.String() || claims.TV != 3 || claims.Email != "a@b.com" {
		t.Fatalf("claims mismatch: %+v", claims)
	}
}

func TestParseRejectsAlgNone(t *testing.T) {
	// Hand-craft an unsigned (alg:none) token with valid-looking claims.
	claims := AccessClaims{
		TV:  0,
		SID: uuid.New().String(),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uuid.New().String(),
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	raw, err := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign none: %v", err)
	}
	if _, err := ParseAccessToken(raw); err == nil {
		t.Fatal("expected alg:none token to be rejected")
	}
}

func TestParseRejectsWrongIssuerAudience(t *testing.T) {
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uuid.New().String(),
			Issuer:    "evil-issuer",
			Audience:  jwt.ClaimStrings{"evil-aud"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	})
	raw, err := tok.SignedString(tokenSigningKey)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := ParseAccessToken(raw); err == nil {
		t.Fatal("expected wrong iss/aud token to be rejected")
	}
}

func TestParseRejectsExpired(t *testing.T) {
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uuid.New().String(),
			Issuer:    jwtIssuer,
			Audience:  jwt.ClaimStrings{jwtAudience},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)),
		},
	})
	raw, _ := tok.SignedString(tokenSigningKey)
	if _, err := ParseAccessToken(raw); err == nil {
		t.Fatal("expected expired token to be rejected")
	}
}
