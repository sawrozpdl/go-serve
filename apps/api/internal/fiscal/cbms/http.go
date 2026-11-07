package cbms

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is IRD's CBMS API host (test and live share it).
const DefaultBaseURL = "https://cbapi.ird.gov.np"

// HTTPClient posts to the real CBMS API.
type HTTPClient struct {
	BaseURL string
	HTTP    *http.Client
}

// NewHTTPClient builds a client with a bounded timeout. CBMS is posted to from
// a background worker, never from the request path, so a slow IRD server only
// delays the outbox.
func NewHTTPClient(baseURL string) *HTTPClient {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &HTTPClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 20 * time.Second},
	}
}

// Name implements Client.
func (c *HTTPClient) Name() string { return "live" }

// Post implements Client.
func (c *HTTPClient) Post(ctx context.Context, e Envelope) (Result, error) {
	body, err := json.Marshal(e)
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/"+string(e.Endpoint), bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrTransport, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	return ParseResponse(resp.StatusCode, raw)
}

// ParseResponse reads a CBMS answer. The documented body is a bare code
// ("200"); some deployments wrap it in quotes, and the test server returns
// model errors as HTTP 400 with the code in the body. A body we cannot read
// as a code after a 5xx is a transport failure (retry); after anything else
// it is reported as 103 (unknown) so it gets looked at.
func ParseResponse(status int, raw []byte) (Result, error) {
	txt := strings.TrimSpace(string(raw))
	r := Result{Raw: truncate(txt, 300)}
	code, err := strconv.Atoi(strings.Trim(txt, `"`))
	if err != nil {
		var obj struct {
			Code  *int `json:"code"`
			Value *int `json:"value"`
		}
		if json.Unmarshal(raw, &obj) == nil && (obj.Code != nil || obj.Value != nil) {
			if obj.Code != nil {
				code = *obj.Code
			} else {
				code = *obj.Value
			}
			err = nil
		}
	}
	if err != nil {
		if status >= 500 {
			return r, fmt.Errorf("%w: HTTP %d: %s", ErrTransport, status, r.Raw)
		}
		r.Code = CodeUnknownError
		return r, nil
	}
	r.Code = code
	return r, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
