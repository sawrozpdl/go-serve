package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Write() is covered against a fake provider rather than a mock: Endpoint is
// configurable precisely so the transport, the usage accounting and the
// rejection path can all be exercised for real without a key.

func fakeProvider(t *testing.T, status int, body any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The key must travel as a header, never in the URL — a key in a query
		// string lands in every proxy and access log, which is the same
		// objection migration 0020 raised about bearer tokens.
		if r.Header.Get("x-goog-api-key") == "" {
			t.Error("api key must be sent as a header")
		}
		if strings.Contains(r.URL.RawQuery, "key=") {
			t.Error("api key must not appear in the URL")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
}

// providerSaying builds a provider response whose single part is `text`.
func providerSaying(text string, inTok, outTok int) map[string]any {
	return map[string]any{
		"candidates": []any{map[string]any{
			"content": map[string]any{"parts": []any{map[string]any{"text": text}}},
		}},
		"usageMetadata": map[string]any{
			"promptTokenCount": inTok, "candidatesTokenCount": outTok,
		},
	}
}

func TestWrite_HappyPathAccountsForSpend(t *testing.T) {
	good := `{"order":["void_rate"],"headline":"A quiet week","body":"Nothing much moved."}`
	srv := fakeProvider(t, http.StatusOK, providerSaying(good, 2000, 400))
	defer srv.Close()

	c := New(Config{APIKey: "k", Model: "gemini-2.0-flash-lite", Endpoint: srv.URL})
	got, err := c.Write(context.Background(), Request{
		System: "sys", User: "usr", AllowedKeys: []string{"void_rate"},
	})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if got.Headline != "A quiet week" {
		t.Errorf("headline = %q", got.Headline)
	}
	if got.Usage.InputTokens != 2000 || got.Usage.OutputTokens != 400 {
		t.Errorf("usage = %+v", got.Usage)
	}
	if got.Usage.CostMicros <= 0 {
		t.Error("a real call must record a real cost, or the ledger understates spend")
	}
	// The hash identifies the prompt without storing a café's business data.
	if len(got.PromptSHA256) != 64 {
		t.Errorf("prompt hash = %q", got.PromptSHA256)
	}
}

// A rejection must carry the raw text out, because that is the one case worth
// keeping a model's output for.
func TestWrite_RejectionCarriesTheRawTextAndTheHash(t *testing.T) {
	bad := `{"order":["void_rate"],"headline":"Sales fell 14%","body":"That is a lot."}`
	srv := fakeProvider(t, http.StatusOK, providerSaying(bad, 100, 20))
	defer srv.Close()

	c := New(Config{APIKey: "k", Endpoint: srv.URL})
	got, err := c.Write(context.Background(), Request{AllowedKeys: []string{"void_rate"}})
	if err == nil {
		t.Fatal("a digit in the prose must not survive the transport path either")
	}
	if !IsRejected(err) {
		t.Errorf("err = %v, want a RejectedError", err)
	}
	var re *RejectedError
	if ok := asRejected(err, &re); !ok || !strings.Contains(re.Raw, "14%") {
		t.Errorf("the raw response must travel with the rejection, got %+v", re)
	}
	// Usage is still accounted for: a rejected call was still paid for.
	if got.Usage.CostMicros <= 0 {
		t.Error("a rejected call still cost money and must still be metered")
	}
	if got.PromptSHA256 == "" {
		t.Error("the prompt hash must survive a rejection")
	}
}

func TestWrite_ProviderErrorIsNotARejection(t *testing.T) {
	// An outage and a guard trip are different events and are recorded
	// differently; conflating them would hide a broken key behind "the model
	// wrote something odd".
	srv := fakeProvider(t, http.StatusTooManyRequests, map[string]any{
		"error": map[string]any{"message": "rate limited"},
	})
	defer srv.Close()

	c := New(Config{APIKey: "k", Endpoint: srv.URL})
	_, err := c.Write(context.Background(), Request{})
	if err == nil {
		t.Fatal("a 429 must be an error")
	}
	if IsRejected(err) {
		t.Error("a provider error must not be reported as a verification failure")
	}
}

func TestWrite_EmptyCandidatesIsAnError(t *testing.T) {
	srv := fakeProvider(t, http.StatusOK, map[string]any{"candidates": []any{}})
	defer srv.Close()
	c := New(Config{APIKey: "k", Endpoint: srv.URL})
	if _, err := c.Write(context.Background(), Request{}); err == nil {
		t.Fatal("an empty response must be an error, not empty prose")
	}
}

// asRejected is errors.As without importing errors into the test's namespace
// twice; kept local so the assertion reads plainly.
func asRejected(err error, target **RejectedError) bool {
	if re, ok := err.(*RejectedError); ok {
		*target = re
		return true
	}
	return false
}
