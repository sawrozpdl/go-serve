package billread

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Talking to Vertex AI instead of the Gemini Developer API.
//
// WHY TWO PROVIDERS AT ALL
//
// They are the same models behind two different products, and which one a café
// can actually use is a billing question, not a technical one. The Developer API
// (generativelanguage.googleapis.com) authenticates with an API key and bills
// against AI Studio prepaid credits. Vertex (aiplatform.googleapis.com)
// authenticates with an OAuth token and bills against the project's ordinary
// GCP billing account. A project can easily have one working and the other not —
// which is exactly the situation this was written for.
//
// The request and response bodies are near-identical, so the split here is
// deliberately narrow: an endpoint, an auth header, and one extra field. If the
// shapes ever diverge further, that is the signal to stop sharing Extract.
//
// WHY A HAND-MINTED TOKEN
//
// ECS is not on Google Cloud, so there is no metadata server and no workload
// identity to borrow — the service account's own key has to sign for itself.
// golang.org/x/oauth2/google would do this, but it drags in a metadata-server
// probe and a credentials-discovery tree to solve a problem this package does
// not have: one known key, one known audience, one scope. golang-jwt is already
// a direct dependency (the app's own sessions are signed with it), so the whole
// exchange is a signed assertion and one POST.

// serviceAccount is the subset of a Google service-account JSON key this needs.
type serviceAccount struct {
	Type        string `json:"type"`
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

const (
	defaultTokenURI = "https://oauth2.googleapis.com/token"
	vertexScope     = "https://www.googleapis.com/auth/cloud-platform"
	// DefaultVertexLocation. "global" rather than a region because that is what
	// serves the newest models first; a café's bill is not latency-sensitive.
	DefaultVertexLocation = "global"
)

// tokenSource mints and caches an access token for one service account.
//
// Cached because a busy evening is a dozen bill reads and each token is good for
// an hour: minting per call would add a round trip to every read for nothing.
type tokenSource struct {
	sa   serviceAccount
	http *http.Client

	mu      sync.Mutex
	cached  string
	expires time.Time
}

func newTokenSource(rawJSON string, httpc *http.Client) (*tokenSource, error) {
	var sa serviceAccount
	if err := json.Unmarshal([]byte(rawJSON), &sa); err != nil {
		return nil, fmt.Errorf("billread: service account JSON is not parseable: %w", err)
	}
	if sa.ClientEmail == "" || sa.PrivateKey == "" {
		return nil, fmt.Errorf("billread: service account JSON is missing client_email or private_key")
	}
	if sa.TokenURI == "" {
		sa.TokenURI = defaultTokenURI
	}
	return &tokenSource{sa: sa, http: httpc}, nil
}

// token returns a valid access token, minting a new one when the cached one is
// within a minute of expiry. The minute of slack is so a token cannot expire
// in flight between this check and the API call it is used for.
func (ts *tokenSource) token(ctx context.Context) (string, error) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	if ts.cached != "" && time.Until(ts.expires) > time.Minute {
		return ts.cached, nil
	}

	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(ts.sa.PrivateKey))
	if err != nil {
		return "", fmt.Errorf("billread: service account private key is unusable: %w", err)
	}
	now := time.Now()
	assertion, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss":   ts.sa.ClientEmail,
		"scope": vertexScope,
		"aud":   ts.sa.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}).SignedString(key)
	if err != nil {
		return "", err
	}

	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ts.sa.TokenURI,
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := ts.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("billread: token exchange returned %d: %s",
			resp.StatusCode, truncate(string(raw), 200))
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return "", fmt.Errorf("billread: token exchange returned no access_token")
	}

	ts.cached = out.AccessToken
	ts.expires = now.Add(time.Duration(out.ExpiresIn) * time.Second)
	return ts.cached, nil
}
