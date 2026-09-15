// Package billread reads ONE thing off a supplier bill: a SUGGESTION.
//
// It is the second place in this product that talks to a language model, and it
// exists because internal/llm cannot be that place. llm/verify.go rejects any
// response containing a digit, in any script — and a bill is nothing but
// digits. That rule is not a style choice; it is the entire reason the weekly
// wrap can be trusted. So this package gets its own verifier rather than
// weakening that one, and the two never share a code path.
//
// FIVE RULES, AND FOUR OF THEM ARE ENFORCED IN CODE.
//
//  1. IT NEVER WRITES. Extract returns a Suggestion. Nothing in this package
//     takes a transaction, imports internal/api, or knows what an expense is.
//     An expense exists because a human pressed Save on a form they could read
//     and edit — always. There is no "auto-record" mode to add later, and the
//     absence of a database handle is what keeps that true.
//
//  2. EVERY NUMBER IS RE-PARSED IN GO. The model returns STRINGS; verify.go
//     converts them — amount to integer paisa by integer arithmetic, never
//     float64 (see api/money.go's header for why), date to a tenant-local
//     calendar day — and range-checks every one. A value that does not survive
//     the round trip is DROPPED, never rounded, coerced or guessed at. A blank
//     field the operator must fill is a better outcome than a plausible wrong
//     one they will not look at twice.
//
//  3. LINE ITEMS ARE NEVER RECONCILED AGAINST THE TOTAL. Deciding how close is
//     close enough is the endless, unwinnable validation job llm/verify.go
//     declined to take on; the operator has the bill in front of them and will
//     notice. Line items are advisory text and are never summed into anything.
//
//  4. IT IS OFF BY DEFAULT. New returns nil without a key, and a nil *Client
//     returns ErrDisabled from every method — the same nil-receiver courtesy
//     llm.New and mail.Mailer give. The expense form behaves identically with
//     it off; the only difference is that nothing is pre-filled. Disabled, over
//     budget, timed out and rejected are all the same event to the caller, and
//     all four are a normal Tuesday.
//
//  5. NOTHING IT PRODUCES IS RECORDED AS REVIEWED. Suggestion.Fields names what
//     the model proposed; expenses.ai_suggested_fields records which of those a
//     human then left alone. The two are not the same list and must never be
//     conflated.
//
// Spend is priced through llm.CostMicros, so a token costs the same here as in
// the wrap's ledger — but the CEILING is separate. One shared cap would mean a
// busy month of bill-reading silently killing every café's weekly wrap, which
// is a worse failure than two numbers to configure.
//
// net/http and hand-written wire structs, for the reason internal/llm gives:
// one JSON POST does not justify a vendored client tree.
package billread

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/pewssh/cafe-mgmt/api/internal/llm"
)

var (
	// ErrDisabled means no model is configured. Callers treat it as "prefill
	// nothing", never as a failure to report.
	ErrDisabled = errors.New("billread: not configured")
	// ErrBudget means this month's spend cap is reached.
	ErrBudget = errors.New("billread: monthly budget exhausted")
	// ErrTooLarge means the bill exceeds what will be sent to a provider.
	ErrTooLarge = errors.New("billread: bill exceeds the size limit")
)

const (
	// DefaultModel must be VISION-capable, which llm.DefaultModel
	// (gemini-2.5-flash-lite) is not reliably for a creased receipt photo
	// taken in a dim kitchen.
	//
	// Pinned to an exact model, never a floating alias like
	// "gemini-flash-latest": ai_usage records the model beside the cost, and a
	// name that silently points somewhere new would make the ledger describe a
	// model that was not the one we called.
	//
	// This started as gemini-2.5-flash and lasted exactly as long as it took to
	// call it with a fresh key: "This model models/gemini-2.5-flash is no
	// longer available to new users. Please update your code to use
	// models/gemini-3.6-flash". It still appears in ListModels, so the listing
	// is not evidence — only a real generateContent call is. That is twice now
	// this product has been handed a retired default (gemini-2.0-flash-lite was
	// the first, see llm.go), which is why both packages say to verify by
	// CALLING before changing this line.
	//
	// gemini-3.6-flash is the provider's own stated replacement. It is
	// deliberately absent from llm/pricing.go: nobody has read its published
	// rate off the price list, and per that file's header a guessed number in a
	// money ledger is worse than no number. Until somebody fills it in it
	// prices at the fallback — the most expensive known tier — which overstates
	// spend and trips the cap early, the safe direction.
	DefaultModel = "gemini-3.6-flash"

	// DefaultMonthlyBudgetUSD is a hard ceiling, not a warning threshold, and
	// is deliberately separate from the insight budget.
	DefaultMonthlyBudgetUSD = 5

	// requestTimeout is short because somebody IS waiting: this runs while an
	// operator watches a spinner on the expense form. Shorter than llm's 20s
	// for that reason.
	requestTimeout = 12 * time.Second

	maxOutputTokens  = 800
	maxResponseBytes = 64 << 10

	// MaxBillBytes bounds what is sent to a provider. Matches the upload cap.
	MaxBillBytes = 10 << 20
)

// Config is what Load() fills from the environment.
//
// Two mutually exclusive ways to reach the same models, because which one works
// is a BILLING question. Vertex wins when both are set: it is the explicit,
// more-configured choice, so preferring it means setting it is never a no-op.
type Config struct {
	// APIKey selects the Gemini Developer API (AI Studio billing).
	APIKey string
	// VertexProject + ServiceAccountJSON select Vertex AI (GCP billing).
	VertexProject      string
	VertexLocation     string
	ServiceAccountJSON string
	// Model is the provider's model id.
	Model string
	// Endpoint allows pointing at a compatible relay or a test server. It
	// overrides the URL for whichever mode is active.
	Endpoint string
	// MonthlyBudgetUSD is a hard ceiling. Zero means the default.
	MonthlyBudgetUSD float64
}

// Client talks to one provider. A nil *Client is valid and returns ErrDisabled
// from every method.
type Client struct {
	cfg  Config
	http *http.Client
	// tokens is non-nil in Vertex mode only, and its presence IS the mode.
	tokens *tokenSource
}

// New returns nil when nothing is configured, so callers never have to gate.
//
// A malformed service-account JSON returns nil too, not an error: the caller
// builds this at boot and a nil client is the ordinary "feature is off" state.
// Failing the boot of a café's POS over a bill-reading credential would be the
// tail wagging the dog — main.go logs whether it came back enabled.
func New(cfg Config) *Client {
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	if cfg.MonthlyBudgetUSD <= 0 {
		cfg.MonthlyBudgetUSD = DefaultMonthlyBudgetUSD
	}
	if cfg.VertexLocation == "" {
		cfg.VertexLocation = DefaultVertexLocation
	}
	httpc := &http.Client{Timeout: requestTimeout}

	// Vertex first: it is the more explicitly configured of the two.
	if cfg.VertexProject != "" && cfg.ServiceAccountJSON != "" {
		ts, err := newTokenSource(cfg.ServiceAccountJSON, httpc)
		if err != nil {
			return nil
		}
		return &Client{cfg: cfg, http: httpc, tokens: ts}
	}
	if cfg.APIKey != "" {
		return &Client{cfg: cfg, http: httpc}
	}
	return nil
}

// vertex reports whether this client talks to Vertex rather than the Developer
// API. Used for the endpoint and the auth header.
func (c *Client) vertex() bool { return c != nil && c.tokens != nil }

// Provider names the mode, for logs. "" when disabled.
func (c *Client) Provider() string {
	switch {
	case c == nil:
		return ""
	case c.vertex():
		return "vertex"
	default:
		return "gemini-developer-api"
	}
}

// Enabled reports whether a model is configured. For logging; callers should
// not branch on it, because the nil receiver already does the right thing.
func (c *Client) Enabled() bool { return c != nil }

// Model returns the configured model id, or "" when disabled.
func (c *Client) Model() string {
	if c == nil {
		return ""
	}
	return c.cfg.Model
}

// BudgetMicros is the monthly ceiling in USD × 1e6, or 0 when disabled.
func (c *Client) BudgetMicros() int64 {
	if c == nil {
		return 0
	}
	return int64(c.cfg.MonthlyBudgetUSD * 1e6)
}

// Bill is one document to read.
type Bill struct {
	Data     []byte
	MimeType string
	// TZ is the TENANT's timezone. A bill says "12/03" and nothing more; which
	// calendar day that becomes is a tenant-local question, resolved here so
	// that no caller has to remember to.
	TZ string
	// Today is the tenant-local date, used to anchor the future check. Supplied
	// rather than computed so this package never calls time.Now() and every
	// rule is testable at a fixed instant.
	Today time.Time
}

// LineItem is one row read off the bill. Advisory text: never summed, never
// priced, never reconciled against the total. Rule 3.
type LineItem struct {
	Description string `json:"description"`
	// QtyText stays TEXT. "2.5 kg" and "3 pkt" are not numbers, and turning
	// them into one is a decision this package is not entitled to make.
	QtyText     string `json:"qty_text"`
	AmountCents *int64 `json:"amount_cents"`
}

// Suggestion is a VERIFIED guess. Every pointer is nil when the corresponding
// value did not survive verification — nil means "ask the human", never zero.
type Suggestion struct {
	Vendor      string      `json:"vendor"`
	AmountCents *int64      `json:"amount_cents"`
	PaidAt      *time.Time  `json:"paid_at"`
	Reference   string      `json:"reference"`
	LineItems   []LineItem  `json:"line_items"`
	// Fields names each top-level key that produced a value. The handler
	// returns it to the form, which marks exactly those inputs as guesses.
	Fields       []string  `json:"fields"`
	Model        string    `json:"model"`
	Usage        llm.Usage `json:"-"`
	PromptSHA256 string    `json:"-"`
}

// RejectedError means the model answered but the answer was not usable.
type RejectedError struct {
	Reason string
	Raw    string
}

func (e *RejectedError) Error() string { return "billread: rejected — " + e.Reason }

// IsRejected reports whether err was a verification failure rather than a
// transport or provider problem. Callers record these separately: a timeout is
// an outage, a rejection is the guard doing its job.
func IsRejected(err error) bool {
	var re *RejectedError
	return errors.As(err, &re)
}

const instruction = `You are reading a supplier bill or receipt for a cafe.
Return ONLY a JSON object with these keys:
  "vendor"       - the supplier's name as printed, or "" if unclear
  "amount"       - the GRAND TOTAL payable, digits only with an optional
                   decimal point, e.g. "1250.50". No currency symbol. "" if unclear.
  "paid_at"      - the bill date as YYYY-MM-DD, or "" if unclear
  "reference"    - the invoice or bill number as printed, or "" if unclear
  "line_items"   - array of {"description","qty_text","amount"} for each line,
                   at most 50. Use "" for anything not printed.
Do not guess. An empty string is always better than an invented value.
Do not explain. Return the JSON object and nothing else.`

// Extract reads a bill and returns a verified suggestion.
func (c *Client) Extract(ctx context.Context, b Bill) (Suggestion, error) {
	if c == nil {
		return Suggestion{}, ErrDisabled
	}
	if len(b.Data) == 0 {
		return Suggestion{}, ErrTooLarge
	}
	if len(b.Data) > MaxBillBytes {
		return Suggestion{}, ErrTooLarge
	}

	sum := sha256.Sum256([]byte(instruction))
	promptHash := hex.EncodeToString(sum[:])

	reqBody := geminiRequest{
		Contents: []geminiContent{{
			// Vertex REQUIRES an explicit role and 400s without it ("Please use
			// a valid role: user, model"); the Developer API infers it. Always
			// sending it costs nothing and keeps one request shape for both.
			Role: "user",
			Parts: []geminiPart{
				{InlineData: &geminiBlob{
					MimeType: b.MimeType,
					Data:     base64.StdEncoding.EncodeToString(b.Data),
				}},
				{Text: instruction},
			},
		}},
	}
	reqBody.GenerationConfig.Temperature = 0
	reqBody.GenerationConfig.MaxOutputTokens = maxOutputTokens
	reqBody.GenerationConfig.ResponseMimeType = "application/json"

	payload, err := json.Marshal(reqBody)
	if err != nil {
		return Suggestion{}, err
	}

	endpoint := c.cfg.Endpoint
	if endpoint == "" {
		if c.vertex() {
			endpoint = fmt.Sprintf(
				"https://aiplatform.googleapis.com/v1/projects/%s/locations/%s/publishers/google/models/%s:generateContent",
				c.cfg.VertexProject, c.cfg.VertexLocation, c.cfg.Model)
		} else {
			endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
				c.cfg.Model + ":generateContent"
		}
	}

	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return Suggestion{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.vertex() {
		tok, err := c.tokens.token(ctx)
		if err != nil {
			return Suggestion{}, err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	} else {
		req.Header.Set("x-goog-api-key", c.cfg.APIKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return Suggestion{}, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Suggestion{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Suggestion{}, fmt.Errorf("billread: provider returned %d: %s",
			resp.StatusCode, truncate(string(raw), 300))
	}

	var wire geminiResponse
	if err := json.Unmarshal(raw, &wire); err != nil {
		return Suggestion{}, &RejectedError{Reason: "unparseable provider envelope", Raw: truncate(string(raw), 500)}
	}
	if len(wire.Candidates) == 0 || len(wire.Candidates[0].Content.Parts) == 0 {
		return Suggestion{}, &RejectedError{Reason: "empty response", Raw: truncate(string(raw), 500)}
	}

	s, err := Verify(wire.Candidates[0].Content.Parts[0].Text, b)
	if err != nil {
		return Suggestion{}, err
	}
	s.Model = c.cfg.Model
	s.PromptSHA256 = promptHash
	// Thinking tokens are BILLED as output but are not in CandidatesTokenCount —
	// on a real call they were 85 against 1 candidate token, so leaving them out
	// would have the ledger understate spend by two orders of magnitude on the
	// output side and let the monthly cap run long past its number.
	outTokens := wire.UsageMetadata.CandidatesTokenCount + wire.UsageMetadata.ThoughtsTokenCount
	s.Usage = llm.Usage{
		InputTokens:  wire.UsageMetadata.PromptTokenCount,
		OutputTokens: outTokens,
		CostMicros:   llm.CostMicros(c.cfg.Model, wire.UsageMetadata.PromptTokenCount, outTokens),
	}
	return s, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// geminiRequest / geminiResponse are the minimum of the provider's wire format.
type geminiRequest struct {
	Contents         []geminiContent `json:"contents"`
	GenerationConfig struct {
		Temperature      float64 `json:"temperature"`
		MaxOutputTokens  int     `json:"maxOutputTokens"`
		ResponseMimeType string  `json:"responseMimeType,omitempty"`
	} `json:"generationConfig"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text       string      `json:"text,omitempty"`
	InlineData *geminiBlob `json:"inlineData,omitempty"`
}

type geminiBlob struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
	UsageMetadata struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
		// Billed as output, reported separately. See the note in Extract.
		ThoughtsTokenCount int `json:"thoughtsTokenCount"`
	} `json:"usageMetadata"`
}
