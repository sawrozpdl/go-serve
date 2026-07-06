package respond

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// resetState clears the package-level flag between subtests.
func resetState() { sanitizeServerErrors = false }

// errBody decodes the canonical {code, message} body.
func errBody(t *testing.T, b []byte) (code, message string) {
	t.Helper()
	var v struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("decode body %q: %v", string(b), err)
	}
	return v.Code, v.Message
}

func TestErr_StatusAndContentType(t *testing.T) {
	resetState()
	cases := []struct {
		status int
		kind   string
		msg    string
	}{
		{http.StatusBadRequest, "bad_request", "invalid input"},
		{http.StatusNotFound, "not_found", "resource missing"},
		{http.StatusUnauthorized, "unauthorized", "not logged in"},
		{http.StatusForbidden, "forbidden", "no permission"},
		{http.StatusInternalServerError, "internal", "db exploded"},
		{http.StatusServiceUnavailable, "unavailable", "down"},
	}
	for _, tc := range cases {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			w := httptest.NewRecorder()
			Err(w, tc.status, tc.kind, tc.msg)

			if w.Code != tc.status {
				t.Errorf("status = %d, want %d", w.Code, tc.status)
			}
			if ct := w.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", ct)
			}
			code, msg := errBody(t, w.Body.Bytes())
			if code != tc.kind {
				t.Errorf("code = %q, want %q", code, tc.kind)
			}
			if msg != tc.msg {
				t.Errorf("message = %q, want %q", msg, tc.msg)
			}
		})
	}
}

func TestErr_SanitizeOff_5xx_PassesThrough(t *testing.T) {
	resetState()
	SanitizeServerErrors(false)

	w := httptest.NewRecorder()
	Err(w, http.StatusInternalServerError, "internal", "pg: connection refused")

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", w.Code)
	}
	_, msg := errBody(t, w.Body.Bytes())
	if msg != "pg: connection refused" {
		t.Errorf("message = %q, want original detail", msg)
	}
}

func TestErr_SanitizeOn_5xx_ReplacesBody(t *testing.T) {
	resetState()
	SanitizeServerErrors(true)
	t.Cleanup(resetState)

	// Capture log output to verify the original detail is logged.
	var logBuf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(orig) })

	w := httptest.NewRecorder()
	Err(w, http.StatusInternalServerError, "internal", "pg: connection refused at 10.0.0.1")

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", w.Code)
	}
	_, msg := errBody(t, w.Body.Bytes())
	if msg != "an internal error occurred" {
		t.Errorf("message = %q, want generic sentinel", msg)
	}
	if !strings.Contains(logBuf.String(), "pg: connection refused at 10.0.0.1") {
		t.Errorf("original detail not found in log output: %s", logBuf.String())
	}
}

// fakeCapturer is a ResponseWriter that also implements ServerErrorCapturer,
// mimicking the request-scoped writer the HTTP middleware installs.
type fakeCapturer struct {
	*httptest.ResponseRecorder
	kind, detail string
	called       bool
}

func (f *fakeCapturer) CaptureServerError(kind, detail string) {
	f.kind, f.detail, f.called = kind, detail, true
}

// wrapNoCapture mimics a middleware that re-wraps the writer but only forwards
// Unwrap() (like chi's Compress writer and the tx statusRecorder).
type wrapNoCapture struct{ http.ResponseWriter }

func (w wrapNoCapture) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func TestFindCapturer_WalksUnwrapChain(t *testing.T) {
	fc := &fakeCapturer{ResponseRecorder: httptest.NewRecorder()}
	// Two opaque wrappers on top of the capturer, as on the real /v1 chain.
	wrapped := wrapNoCapture{wrapNoCapture{fc}}
	if got := FindCapturer(wrapped); got == nil {
		t.Fatal("FindCapturer returned nil; must walk Unwrap() to reach the capturer")
	}
}

func TestFindCapturer_NilWhenAbsent(t *testing.T) {
	// A plain recorder wrapped opaquely — no capturer anywhere in the chain.
	if got := FindCapturer(wrapNoCapture{httptest.NewRecorder()}); got != nil {
		t.Errorf("FindCapturer = %v, want nil when no capturer present", got)
	}
}

func TestErr_SanitizeOn_5xx_CapturesThroughWrappers(t *testing.T) {
	resetState()
	SanitizeServerErrors(true)
	t.Cleanup(resetState)

	fc := &fakeCapturer{ResponseRecorder: httptest.NewRecorder()}
	Err(wrapNoCapture{fc}, http.StatusInternalServerError, "internal_error", "pg: boom")
	if !fc.called {
		t.Fatal("capturer under a wrapper was not invoked — detail would be lost from the alert")
	}
	if fc.detail != "pg: boom" {
		t.Errorf("captured detail = %q, want pg: boom", fc.detail)
	}
}

func TestErr_SanitizeOn_5xx_HandsDetailToCapturer(t *testing.T) {
	resetState()
	SanitizeServerErrors(true)
	t.Cleanup(resetState)

	// If the writer captures, Err must NOT emit its own slog line (the
	// middleware logs it with req_id instead).
	var logBuf bytes.Buffer
	orig := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(orig) })

	fc := &fakeCapturer{ResponseRecorder: httptest.NewRecorder()}
	Err(fc, http.StatusInternalServerError, "internal_error", "pg: connection refused at 10.0.0.1")

	if !fc.called {
		t.Fatal("capturer was not invoked for a 5xx")
	}
	if fc.kind != "internal_error" || fc.detail != "pg: connection refused at 10.0.0.1" {
		t.Errorf("captured (%q, %q), want (internal_error, pg: connection refused …)", fc.kind, fc.detail)
	}
	_, msg := errBody(t, fc.Body.Bytes())
	if msg != "an internal error occurred" {
		t.Errorf("message = %q, want generic sentinel", msg)
	}
	// The detached, req_id-less slog line must NOT be emitted on the capture path.
	if strings.Contains(logBuf.String(), "http.internal_error") {
		t.Errorf("did not expect the fallback slog line when a capturer handled it: %s", logBuf.String())
	}
}

func TestErr_SanitizeOn_4xx_NeverMasked(t *testing.T) {
	resetState()
	SanitizeServerErrors(true)
	t.Cleanup(resetState)

	detail := "email already registered"
	w := httptest.NewRecorder()
	Err(w, http.StatusConflict, "conflict", detail)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w.Code)
	}
	_, msg := errBody(t, w.Body.Bytes())
	if msg != detail {
		t.Errorf("message = %q, want original %q (4xx must never be masked)", msg, detail)
	}
}

func TestErr_SanitizeOn_5xx_EmptyMsg_NoGenericSubstitution(t *testing.T) {
	// Empty msg means no detail to leak; sentinel should not replace empty string.
	resetState()
	SanitizeServerErrors(true)
	t.Cleanup(resetState)

	w := httptest.NewRecorder()
	Err(w, http.StatusInternalServerError, "internal", "")

	_, msg := errBody(t, w.Body.Bytes())
	// The condition is `msg != ""` so empty passes through unchanged.
	if msg != "" {
		t.Errorf("message = %q, want empty (guard: msg != '')", msg)
	}
}

func TestErr_SanitizeOn_BoundaryStatus_499_NotMasked(t *testing.T) {
	resetState()
	SanitizeServerErrors(true)
	t.Cleanup(resetState)

	w := httptest.NewRecorder()
	Err(w, 499, "client_closed", "closed before response")

	_, msg := errBody(t, w.Body.Bytes())
	if msg != "closed before response" {
		t.Errorf("message = %q, want original (499 < 500)", msg)
	}
}

func TestErr_SanitizeOn_ExactBoundary_500_IsMasked(t *testing.T) {
	resetState()
	SanitizeServerErrors(true)
	t.Cleanup(resetState)

	w := httptest.NewRecorder()
	Err(w, 500, "internal", "leak me")

	_, msg := errBody(t, w.Body.Bytes())
	if msg != "an internal error occurred" {
		t.Errorf("status 500 should be masked, got %q", msg)
	}
}

func TestErr_SanitizeOn_503_IsMasked(t *testing.T) {
	resetState()
	SanitizeServerErrors(true)
	t.Cleanup(resetState)

	w := httptest.NewRecorder()
	Err(w, http.StatusServiceUnavailable, "unavailable", "redis down: connection refused")

	_, msg := errBody(t, w.Body.Bytes())
	if msg != "an internal error occurred" {
		t.Errorf("503 should be masked, got %q", msg)
	}
}

func TestErr_BodyIsValidJSON(t *testing.T) {
	resetState()
	w := httptest.NewRecorder()
	Err(w, http.StatusBadRequest, "bad_request", `has "quotes" and \n escapes`)

	var v map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Errorf("body is not valid JSON: %v; body: %s", err, w.Body.String())
	}
}

func TestSanitizeServerErrors_Toggle(t *testing.T) {
	resetState()
	if sanitizeServerErrors {
		t.Fatal("default must be false")
	}
	SanitizeServerErrors(true)
	if !sanitizeServerErrors {
		t.Fatal("should be true after enabling")
	}
	SanitizeServerErrors(false)
	if sanitizeServerErrors {
		t.Fatal("should be false after disabling")
	}
}
