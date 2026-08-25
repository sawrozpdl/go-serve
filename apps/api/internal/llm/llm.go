// Package llm is the one place in this product that talks to a language model.
//
// It exists to write ONE THING: the weekly wrap's prose. Not the daily brief
// (that is templated and must stay reliable), not the findings themselves, and
// not any number anywhere. The reasoning is in internal/insight's package
// comment; the enforcement is here.
//
// FOUR RULES, AND THREE OF THEM ARE ENFORCED IN CODE
//
//  1. The model NEVER emits a number. Not "should not" — cannot: verify.go
//     rejects any response whose prose contains a digit, and every figure the
//     reader sees is rendered separately from the detector's own sentence. A
//     prompt asking nicely is a hope; a rejection is a guarantee.
//
//  2. The model NEVER selects. It may reorder and demote what it was given, and
//     nothing else. Promotion of a key that was not in the input is a rejection.
//     Selection lives in insight/select.go so that an accepted finding reliably
//     reappears and the email stays testable.
//
//  3. A failure is not an error path, it is the DEFAULT path. llm.New returns
//     nil when unconfigured, and a nil *Client is a valid no-op — the same
//     nil-receiver courtesy mail.Mailer gives. So "ship the deterministic text"
//     is what happens when the key is missing, the budget is spent, the request
//     times out, or the response is rejected. Every one of those is a normal
//     Tuesday.
//
//  4. Spend is capped, and the cap is a real ceiling rather than a dashboard.
//
// WHY net/http AND NOT AN SDK
//
// go.mod has eight direct dependencies. internal/mail talks SMTP with the
// standard library for the same reason: one JSON POST does not justify a
// vendored client tree, and the request shape here is three fields.
package llm

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ErrDisabled means no model is configured. Callers treat it as "use the
// deterministic text", never as a failure to report.
var ErrDisabled = errors.New("llm: not configured")

// ErrBudget means this month's spend cap is reached.
var ErrBudget = errors.New("llm: monthly budget exhausted")

// Config is what Load() fills from the environment.
type Config struct {
	// APIKey empty disables the whole package.
	APIKey string
	// Model is the provider's model id. Kept as a string rather than an enum so
	// a newer cheap model can be swapped in with an env change and no deploy.
	Model string
	// Endpoint allows pointing at a compatible relay or a test server. Empty
	// uses the Google endpoint.
	Endpoint string
	// MonthlyBudgetUSD is a hard ceiling, not a warning threshold. Zero means
	// the default.
	MonthlyBudgetUSD float64
}

const (
	// DefaultModel is a cheap, fast tier. The wrap is one call per café per
	// week over a few hundred words; nothing here needs a frontier model, and
	// paying for one would be spending the customer's money on our own vanity.
	DefaultModel = "gemini-2.0-flash-lite"
	// DefaultMonthlyBudgetUSD is set far above any plausible spend so it never
	// binds in normal operation and only ever catches a runaway. At weekly
	// cadence, a hundred cafés cost cents.
	DefaultMonthlyBudgetUSD = 10

	// requestTimeout per attempt. The wrap is not interactive — nobody is
	// waiting — but a hung request must not hold a café's transaction open.
	requestTimeout = 20 * time.Second
	// maxOutputTokens bounds the response. Also the reason the reply cannot
	// blow the 480 MiB container: a bounded response plus io.LimitReader means
	// peak memory is one small prompt and one small reply.
	maxOutputTokens = 400
	// maxResponseBytes is belt to maxOutputTokens' braces — a provider bug or a
	// wrong endpoint must not stream megabytes into a 480 MiB task.
	maxResponseBytes = 64 << 10
)

// Client talks to one provider. A nil *Client is valid and returns ErrDisabled
// from every method.
type Client struct {
	cfg  Config
	http *http.Client
}

// New returns nil when no key is configured, so callers never have to gate.
func New(cfg Config) *Client {
	if cfg.APIKey == "" {
		return nil
	}
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	if cfg.MonthlyBudgetUSD <= 0 {
		cfg.MonthlyBudgetUSD = DefaultMonthlyBudgetUSD
	}
	return &Client{cfg: cfg, http: &http.Client{Timeout: requestTimeout}}
}

// Enabled reports whether a model is configured. Useful for logging; callers
// should not branch on it, because the nil receiver already does the right
// thing.
func (c *Client) Enabled() bool { return c != nil }

// Model returns the configured model id, or "" when disabled.
func (c *Client) Model() string {
	if c == nil {
		return ""
	}
	return c.cfg.Model
}

// Usage is what one call cost.
type Usage struct {
	InputTokens  int
	OutputTokens int
	// CostMicros is USD × 1e6. Integer so the ledger cannot drift the way a
	// float sum of thousands of tiny charges would.
	CostMicros int64
}

// Request is a prose-writing job: a set of pre-computed, pre-ranked items and
// the instruction to order and phrase them.
type Request struct {
	// System is the standing instruction.
	System string
	// User is the payload — the café's name and the findings' sentences.
	User string
	// AllowedKeys bounds what Response.Order may contain. Anything else is a
	// rejection, which is how "the model never selects" is enforced.
	AllowedKeys []string
}

// Response is what a successful, VERIFIED call produced.
type Response struct {
	Order    []string
	Headline string
	Body     string
	Usage    Usage
	// PromptSHA256 identifies the prompt without storing it. The prompt is a
	// café's business data; a hash is enough to tell whether two runs used the
	// same instruction, and the payload is reconstructible from the brief's
	// recorded items.
	PromptSHA256 string
}

// geminiRequest / geminiResponse are the minimum of the provider's wire format.
type geminiRequest struct {
	SystemInstruction *geminiContent  `json:"systemInstruction,omitempty"`
	Contents          []geminiContent `json:"contents"`
	GenerationConfig  struct {
		Temperature      float64 `json:"temperature"`
		MaxOutputTokens  int     `json:"maxOutputTokens"`
		ResponseMIMEType string  `json:"responseMimeType"`
	} `json:"generationConfig"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text string `json:"text"`
}

type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []geminiPart `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
	} `json:"usageMetadata"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Write asks the model to order and phrase what it was given, then VERIFIES the
// answer before returning it.
//
// A rejection is returned as an error, so the caller falls back to deterministic
// text exactly as it would on a timeout. That is deliberate: from the reader's
// point of view "the model wrote something I cannot trust" and "the model did
// not answer" are the same event.
func (c *Client) Write(ctx context.Context, req Request) (Response, error) {
	if c == nil {
		return Response{}, ErrDisabled
	}

	body := geminiRequest{
		SystemInstruction: &geminiContent{Parts: []geminiPart{{Text: req.System}}},
		Contents:          []geminiContent{{Role: "user", Parts: []geminiPart{{Text: req.User}}}},
	}
	// Temperature 0.2 rather than 0: some variation in phrasing week to week
	// reads as written rather than generated, and the verifier makes the risk of
	// variation cheap.
	body.GenerationConfig.Temperature = 0.2
	body.GenerationConfig.MaxOutputTokens = maxOutputTokens
	body.GenerationConfig.ResponseMIMEType = "application/json"

	raw, err := json.Marshal(body)
	if err != nil {
		return Response{}, err
	}
	sum := sha256.Sum256([]byte(req.System + "\x00" + req.User))
	promptHash := hex.EncodeToString(sum[:])

	text, usage, err := c.post(ctx, raw)
	if err != nil {
		return Response{PromptSHA256: promptHash}, err
	}

	out, err := Verify(text, req.AllowedKeys)
	out.Usage = usage
	out.PromptSHA256 = promptHash
	if err != nil {
		// The raw text travels with the error so the caller can store it for
		// exactly the one case worth keeping: a rejection.
		return out, &RejectedError{Reason: err.Error(), Raw: text}
	}
	return out, nil
}

func (c *Client) post(ctx context.Context, payload []byte) (string, Usage, error) {
	endpoint := c.cfg.Endpoint
	if endpoint == "" {
		endpoint = fmt.Sprintf(
			"https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent",
			c.cfg.Model)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", Usage{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// Header rather than a query parameter: a key in a URL ends up in proxy and
	// access logs, which is the same objection 0020 raised about bearer tokens.
	httpReq.Header.Set("x-goog-api-key", c.cfg.APIKey)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return "", Usage{}, err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return "", Usage{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return "", Usage{}, fmt.Errorf("llm: provider returned %d: %s",
			resp.StatusCode, trim(string(bodyBytes), 200))
	}

	var parsed geminiResponse
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		return "", Usage{}, fmt.Errorf("llm: unparseable response: %w", err)
	}
	if parsed.Error != nil {
		return "", Usage{}, fmt.Errorf("llm: %s", parsed.Error.Message)
	}
	if len(parsed.Candidates) == 0 || len(parsed.Candidates[0].Content.Parts) == 0 {
		return "", Usage{}, errors.New("llm: empty response")
	}

	usage := Usage{
		InputTokens:  parsed.UsageMetadata.PromptTokenCount,
		OutputTokens: parsed.UsageMetadata.CandidatesTokenCount,
	}
	usage.CostMicros = CostMicros(c.cfg.Model, usage.InputTokens, usage.OutputTokens)
	return parsed.Candidates[0].Content.Parts[0].Text, usage, nil
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
