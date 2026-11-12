package fiscal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// ErrNoEncryptionKey means the server has no FISCAL_ENCRYPTION_KEY, so it
// refuses to store CBMS credentials rather than store them in the clear.
var ErrNoEncryptionKey = errors.New("fiscal: FISCAL_ENCRYPTION_KEY is not configured")

// ParseEncryptionKey decodes a base64 (std or URL) 32-byte AES-256 key.
func ParseEncryptionKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if k, err := enc.DecodeString(s); err == nil {
			if len(k) != 32 {
				return nil, fmt.Errorf("fiscal: encryption key must be 32 bytes, got %d", len(k))
			}
			return k, nil
		}
	}
	return nil, errors.New("fiscal: encryption key is not base64")
}

// sealSecret encrypts plaintext with AES-256-GCM. Output: nonce || ciphertext.
// The tenant id is bound as additional data, so a ciphertext copied onto
// another café's row does not decrypt.
func sealSecret(key []byte, plaintext, aad string) ([]byte, error) {
	if len(key) == 0 {
		return nil, ErrNoEncryptionKey
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(plaintext), []byte(aad)), nil
}

// openSecret reverses sealSecret.
func openSecret(key, sealed []byte, aad string) (string, error) {
	if len(key) == 0 {
		return "", ErrNoEncryptionKey
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(sealed) < gcm.NonceSize() {
		return "", errors.New("fiscal: sealed secret too short")
	}
	pt, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], []byte(aad))
	if err != nil {
		return "", errors.New("fiscal: cannot decrypt CBMS password (wrong key or tampered row)")
	}
	return string(pt), nil
}

// keyFor returns the configured key for id. Rotation: when the configured key
// id changes, rows sealed under an older id cannot be opened and the café is
// asked to re-enter its CBMS password (the UI shows why).
func keyFor(id string) ([]byte, error) {
	if len(settings.EncryptionKey) == 0 {
		return nil, ErrNoEncryptionKey
	}
	if id != "" && id != settings.KeyID {
		return nil, fmt.Errorf("fiscal: CBMS password was sealed with key %q, server has %q — re-enter it", id, settings.KeyID)
	}
	return settings.EncryptionKey, nil
}
