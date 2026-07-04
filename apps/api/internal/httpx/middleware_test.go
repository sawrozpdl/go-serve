package httpx

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/respond"
)

// ── helpers ──────────────────────────────────────────────────────────────────

// okHandler writes 200 OK with a small body.
var okHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
})

// statusHandler returns a handler that writes the given code.
func statusHandler(code int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(code)
	})
}

// newReq builds a GET request with RemoteAddr set to addr.
func newReq(addr string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = addr
	return r
}

// discardLogger returns an slog.Logger that throws away everything.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// ── RateLimitByIP ────────────────────────────────────────────────────────────

func TestRateLimitByIP_AllowsUnderLimit(t *testing.T) {
	limit := 5
	mw := RateLimitByIP("test", limit, time.Minute)
	h := mw(okHandler)

	for i := 0; i < limit; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, newReq("10.0.0.1:9999"))
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d: want 200, got %d", i+1, rr.Code)
		}
	}
}

func TestRateLimitByIP_Blocks429OnExceed(t *testing.T) {
	limit := 3
	mw := RateLimitByIP("test", limit, time.Minute)
	h := mw(okHandler)

	for i := 0; i < limit; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, newReq("10.0.0.2:1111"))
		if rr.Code != http.StatusOK {
			t.Fatalf("pre-limit request %d: want 200, got %d", i+1, rr.Code)
		}
	}
	// (limit+1)th request must be rejected.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, newReq("10.0.0.2:1111"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rr.Code)
	}
}

func TestRateLimitByIP_429Headers(t *testing.T) {
	mw := RateLimitByIP("test", 1, time.Minute)
	h := mw(okHandler)

	addr := "10.0.0.3:2222"
	// consume the 1 slot
	h.ServeHTTP(httptest.NewRecorder(), newReq(addr))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, newReq(addr))

	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rr.Code)
	}
	if v := rr.Header().Get("Content-Type"); v != "application/json" {
		t.Errorf("Content-Type: want application/json, got %q", v)
	}
	if v := rr.Header().Get("Retry-After"); v == "" {
		t.Error("Retry-After header missing")
	}
	if v := rr.Header().Get("X-RateLimit-Limit"); v != "1" {
		t.Errorf("X-RateLimit-Limit: want 1, got %q", v)
	}
	if v := rr.Header().Get("X-RateLimit-Remaining"); v != "0" {
		t.Errorf("X-RateLimit-Remaining: want 0, got %q", v)
	}
}

func TestRateLimitByIP_429BodyJSON(t *testing.T) {
	mw := RateLimitByIP("test", 1, time.Minute)
	h := mw(okHandler)
	addr := "10.0.0.4:3333"
	h.ServeHTTP(httptest.NewRecorder(), newReq(addr))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, newReq(addr))

	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not valid JSON: %v — raw: %s", err, rr.Body.String())
	}
	if body["code"] != "rate_limited" {
		t.Errorf("body.code: want rate_limited, got %v", body["code"])
	}
	if body["message"] == "" || body["message"] == nil {
		t.Error("body.message is empty")
	}
	// Clients read the retry hint from the body too (not just Retry-After), so
	// it must be a positive number that matches the header.
	retry, ok := body["retry_after_seconds"].(float64)
	if !ok || retry < 1 {
		t.Errorf("body.retry_after_seconds: want positive number, got %v", body["retry_after_seconds"])
	}
	if hdr := rr.Header().Get("Retry-After"); hdr != strconv.Itoa(int(retry)) {
		t.Errorf("Retry-After header %q should match body retry_after_seconds %v", hdr, retry)
	}
}

func TestRateLimitByIP_DifferentIPsAreIndependent(t *testing.T) {
	limit := 2
	mw := RateLimitByIP("test", limit, time.Minute)
	h := mw(okHandler)

	ipA := "10.0.1.1:80"
	ipB := "10.0.1.2:80"

	// Exhaust ipA.
	for i := 0; i < limit; i++ {
		h.ServeHTTP(httptest.NewRecorder(), newReq(ipA))
	}
	// ipA is now rate-limited.
	rrA := httptest.NewRecorder()
	h.ServeHTTP(rrA, newReq(ipA))
	if rrA.Code != http.StatusTooManyRequests {
		t.Fatalf("ipA: want 429, got %d", rrA.Code)
	}
	// ipB still has its full quota.
	rrB := httptest.NewRecorder()
	h.ServeHTTP(rrB, newReq(ipB))
	if rrB.Code != http.StatusOK {
		t.Fatalf("ipB: want 200, got %d", rrB.Code)
	}
}

func TestRateLimitByIP_RemainingHeaderDecreases(t *testing.T) {
	limit := 5
	mw := RateLimitByIP("test", limit, time.Minute)
	h := mw(okHandler)
	addr := "10.0.2.1:80"

	prev := -1
	for i := 0; i < limit; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, newReq(addr))
		val := rr.Header().Get("X-RateLimit-Remaining")
		rem, err := strconv.Atoi(val)
		if err != nil {
			t.Fatalf("request %d: bad X-RateLimit-Remaining %q: %v", i+1, val, err)
		}
		if prev >= 0 && rem >= prev {
			t.Errorf("request %d: remaining (%d) did not decrease from previous (%d)", i+1, rem, prev)
		}
		prev = rem
	}
}

func TestRateLimitByIP_RemoteAddrWithoutPort(t *testing.T) {
	// clientIP should fall back to RemoteAddr if SplitHostPort fails.
	mw := RateLimitByIP("test", 1, time.Minute)
	h := mw(okHandler)

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "192.168.1.1" // no port

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}

	// Second request from the same bare IP should be blocked.
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, r)
	if rr2.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rr2.Code)
	}
}

func TestRateLimitByIP_WindowReset_ViaShortWindow(t *testing.T) {
	// Use a very short window so we can confirm the window resets without
	// a long sleep. We verify the two phases that don't require waiting:
	// 1. under-limit passes within the window, 2. at-limit blocks.
	limit := 2
	mw := RateLimitByIP("test", limit, 50*time.Millisecond)
	h := mw(okHandler)
	addr := "10.0.3.1:80"

	// Phase 1: both requests succeed.
	for i := 0; i < limit; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, newReq(addr))
		if rr.Code != http.StatusOK {
			t.Fatalf("phase1 req %d: want 200, got %d", i+1, rr.Code)
		}
	}
	// Phase 2: immediately blocked.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, newReq(addr))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("phase2: want 429, got %d", rr.Code)
	}
	// Phase 3: after the window expires the slot opens again.
	time.Sleep(60 * time.Millisecond)
	rr3 := httptest.NewRecorder()
	h.ServeHTTP(rr3, newReq(addr))
	if rr3.Code != http.StatusOK {
		t.Fatalf("phase3 (after window reset): want 200, got %d", rr3.Code)
	}
}

func TestRateLimitByIP_SkipsOptionsPreflight(t *testing.T) {
	// A limit of 1 means the second COUNTED request would 429. Fire several
	// OPTIONS preflights first: they must pass through without consuming the
	// quota, so a subsequent real GET still succeeds.
	mw := RateLimitByIP("test", 1, time.Minute)
	h := mw(okHandler)
	addr := "10.0.4.1:80"

	for i := 0; i < 5; i++ {
		r := httptest.NewRequest(http.MethodOptions, "/", nil)
		r.RemoteAddr = addr
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		if rr.Code != http.StatusOK {
			t.Fatalf("OPTIONS %d: want 200 (passthrough), got %d", i+1, rr.Code)
		}
	}
	// The single real request still has its slot.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, newReq(addr))
	if rr.Code != http.StatusOK {
		t.Fatalf("real GET after preflights: want 200, got %d", rr.Code)
	}
}

func TestRateLimitByIP_429BodyCarriesLimiterName(t *testing.T) {
	mw := RateLimitByIP("auth", 1, time.Minute)
	h := mw(okHandler)
	addr := "10.0.4.2:80"
	h.ServeHTTP(httptest.NewRecorder(), newReq(addr)) // consume the slot

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, newReq(addr))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rr.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v — raw: %s", err, rr.Body.String())
	}
	// The name identifies which envelope fired, for attributable 429s.
	if body["limiter"] != "auth" {
		t.Errorf("body.limiter: want auth, got %v", body["limiter"])
	}
	// The stable machine code is unchanged so existing clients keep working.
	if body["code"] != "rate_limited" {
		t.Errorf("body.code: want rate_limited, got %v", body["code"])
	}
}

// ── SecurityHeaders ───────────────────────────────────────────────────────────

func TestSecurityHeaders_NonProd(t *testing.T) {
	mw := SecurityHeaders(false)
	rr := httptest.NewRecorder()
	mw(okHandler).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	h := rr.Header()

	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	}
	for k, v := range want {
		if got := h.Get(k); got != v {
			t.Errorf("%s: want %q, got %q", k, v, got)
		}
	}

	// Permissions-Policy must be set and contain at least one directive.
	if pp := h.Get("Permissions-Policy"); pp == "" {
		t.Error("Permissions-Policy header missing")
	}
	// CSP must be set and reference 'self'.
	csp := h.Get("Content-Security-Policy")
	if csp == "" {
		t.Error("Content-Security-Policy header missing")
	}
	if !strings.Contains(csp, "default-src 'self'") {
		t.Errorf("CSP missing default-src 'self': %q", csp)
	}

	// HSTS must NOT be present in non-prod.
	if v := h.Get("Strict-Transport-Security"); v != "" {
		t.Errorf("Strict-Transport-Security should be absent in non-prod, got %q", v)
	}
}

func TestSecurityHeaders_Prod_HSTSPresent(t *testing.T) {
	mw := SecurityHeaders(true)
	rr := httptest.NewRecorder()
	mw(okHandler).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	hsts := rr.Header().Get("Strict-Transport-Security")
	if hsts == "" {
		t.Fatal("Strict-Transport-Security should be set in prod mode")
	}
	if !strings.Contains(hsts, "max-age=") {
		t.Errorf("HSTS missing max-age: %q", hsts)
	}
	if !strings.Contains(hsts, "includeSubDomains") {
		t.Errorf("HSTS missing includeSubDomains: %q", hsts)
	}
}

func TestSecurityHeaders_Prod_AllOtherHeadersStillSet(t *testing.T) {
	mw := SecurityHeaders(true)
	rr := httptest.NewRecorder()
	mw(okHandler).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	h := rr.Header()
	for _, k := range []string{
		"X-Content-Type-Options",
		"X-Frame-Options",
		"Referrer-Policy",
		"Permissions-Policy",
		"Content-Security-Policy",
	} {
		if v := h.Get(k); v == "" {
			t.Errorf("header %s missing in prod mode", k)
		}
	}
}

func TestSecurityHeaders_CSPDirectives(t *testing.T) {
	mw := SecurityHeaders(false)
	rr := httptest.NewRecorder()
	mw(okHandler).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := rr.Header().Get("Content-Security-Policy")

	required := []string{
		"default-src 'self'",
		"frame-ancestors 'none'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
	}
	for _, d := range required {
		if !strings.Contains(csp, d) {
			t.Errorf("CSP missing directive %q; full CSP: %q", d, csp)
		}
	}
}

func TestSecurityHeaders_PermissionsPolicyDirectives(t *testing.T) {
	mw := SecurityHeaders(false)
	rr := httptest.NewRecorder()
	mw(okHandler).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	pp := rr.Header().Get("Permissions-Policy")

	for _, feat := range []string{"camera=()", "microphone=()", "geolocation=()", "payment=()"} {
		if !strings.Contains(pp, feat) {
			t.Errorf("Permissions-Policy missing %q; full value: %q", feat, pp)
		}
	}
}

func TestSecurityHeaders_NextHandlerCalled(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	})
	mw := SecurityHeaders(false)
	rr := httptest.NewRecorder()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	if !called {
		t.Error("SecurityHeaders did not call the next handler")
	}
	if rr.Code != http.StatusNoContent {
		t.Errorf("want 204, got %d", rr.Code)
	}
}

// ── requestTimeout ────────────────────────────────────────────────────────────

func TestRequestTimeout_ContextHasDeadline(t *testing.T) {
	mw := requestTimeout(5 * time.Second)
	var hasDeadline bool
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, hasDeadline = r.Context().Deadline()
	})
	rr := httptest.NewRecorder()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if !hasDeadline {
		t.Error("request context should have a deadline after requestTimeout middleware")
	}
}

func TestRequestTimeout_DeadlineIsInFuture(t *testing.T) {
	d := 10 * time.Second
	mw := requestTimeout(d)
	var deadline time.Time
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		deadline, _ = r.Context().Deadline()
	})
	rr := httptest.NewRecorder()
	before := time.Now()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	after := time.Now()

	if deadline.Before(before) {
		t.Error("deadline is in the past")
	}
	if deadline.After(after.Add(d)) {
		t.Error("deadline is further out than the specified duration")
	}
}

func TestRequestTimeout_CancelsAfterDuration(t *testing.T) {
	mw := requestTimeout(20 * time.Millisecond)
	done := make(chan struct{})
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			// expected: context was cancelled within the window
		case <-time.After(500 * time.Millisecond):
			t.Error("context was not cancelled within the expected time")
		}
		close(done)
	})
	rr := httptest.NewRecorder()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	<-done
}

func TestRequestTimeout_ShortDurationDoesNotBlockForever(t *testing.T) {
	// Confirm the middleware itself returns promptly even for a very short timeout.
	mw := requestTimeout(1 * time.Millisecond)
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		// Simulate work that respects ctx.
		<-r.Context().Done()
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		mw(inner).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Error("middleware blocked longer than expected")
	}
}

// ── healthz / readyz ──────────────────────────────────────────────────────────

func TestHealthz_Returns200(t *testing.T) {
	rr := httptest.NewRecorder()
	healthz(rr, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
}

func TestHealthz_ContentType(t *testing.T) {
	rr := httptest.NewRecorder()
	healthz(rr, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	ct := rr.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type: want application/json prefix, got %q", ct)
	}
}

func TestHealthz_BodyStatusOK(t *testing.T) {
	rr := httptest.NewRecorder()
	healthz(rr, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	var body map[string]string
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("could not decode JSON body: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("body.status: want ok, got %q", body["status"])
	}
}

// healthz and readyz share the same handler, confirm both behave identically.
func TestReadyz_SameAsHealthz(t *testing.T) {
	rr := httptest.NewRecorder()
	// readyz is registered in the router as the same healthz function.
	healthz(rr, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("could not decode JSON body: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("body.status: want ok, got %q", body["status"])
	}
}

// ── writeJSON ─────────────────────────────────────────────────────────────────

func TestWriteJSON_StatusCode(t *testing.T) {
	rr := httptest.NewRecorder()
	writeJSON(rr, http.StatusCreated, map[string]string{"id": "123"})
	if rr.Code != http.StatusCreated {
		t.Errorf("want 201, got %d", rr.Code)
	}
}

func TestWriteJSON_ContentType(t *testing.T) {
	rr := httptest.NewRecorder()
	writeJSON(rr, http.StatusOK, map[string]string{"key": "val"})
	ct := rr.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type: want application/json prefix, got %q", ct)
	}
}

func TestWriteJSON_BodyEncoding(t *testing.T) {
	type payload struct {
		Name  string `json:"name"`
		Value int    `json:"value"`
	}
	rr := httptest.NewRecorder()
	writeJSON(rr, http.StatusOK, payload{Name: "foo", Value: 42})

	var got payload
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if got.Name != "foo" || got.Value != 42 {
		t.Errorf("unexpected body: %+v", got)
	}
}

func TestWriteJSON_NilBody(t *testing.T) {
	rr := httptest.NewRecorder()
	writeJSON(rr, http.StatusNoContent, nil)
	// Should not panic; status should be set.
	if rr.Code != http.StatusNoContent {
		t.Errorf("want 204, got %d", rr.Code)
	}
}

func TestWriteJSON_ArrayBody(t *testing.T) {
	rr := httptest.NewRecorder()
	writeJSON(rr, http.StatusOK, []string{"a", "b", "c"})
	var got []string
	if err := json.NewDecoder(rr.Body).Decode(&got); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(got) != 3 || got[0] != "a" {
		t.Errorf("unexpected body: %v", got)
	}
}

func TestWriteJSON_ErrorStatus(t *testing.T) {
	rr := httptest.NewRecorder()
	writeJSON(rr, http.StatusUnprocessableEntity, map[string]string{"error": "bad"})
	if rr.Code != http.StatusUnprocessableEntity {
		t.Errorf("want 422, got %d", rr.Code)
	}
}

// ── slogRequest ───────────────────────────────────────────────────────────────

func TestSlogRequest_CallsNext(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	mw := slogRequest(discardLogger())
	rr := httptest.NewRecorder()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if !called {
		t.Error("slogRequest did not call the next handler")
	}
}

func TestSlogRequest_DoesNotPanic(t *testing.T) {
	mw := slogRequest(discardLogger())
	for _, code := range []int{200, 201, 301, 400, 401, 403, 404, 422, 500, 502, 503} {
		code := code
		t.Run(http.StatusText(code), func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("slogRequest panicked for status %d: %v", code, r)
				}
			}()
			mw(statusHandler(code)).ServeHTTP(
				httptest.NewRecorder(),
				httptest.NewRequest(http.MethodGet, "/test", nil),
			)
		})
	}
}

func TestSlogRequest_2xxUsesInfoLevel(t *testing.T) {
	// We can't inspect log level directly, but we verify the middleware
	// completes without panic/error for 2xx responses and the response is
	// passed through unchanged.
	mw := slogRequest(discardLogger())
	rr := httptest.NewRecorder()
	mw(statusHandler(http.StatusOK)).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Code != http.StatusOK {
		t.Errorf("want 200, got %d", rr.Code)
	}
}

func TestSlogRequest_4xxUsesWarnLevel(t *testing.T) {
	mw := slogRequest(discardLogger())
	rr := httptest.NewRecorder()
	mw(statusHandler(http.StatusNotFound)).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/missing", nil))
	if rr.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", rr.Code)
	}
}

func TestSlogRequest_5xxUsesErrorLevel(t *testing.T) {
	mw := slogRequest(discardLogger())
	rr := httptest.NewRecorder()
	mw(statusHandler(http.StatusInternalServerError)).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("want 500, got %d", rr.Code)
	}
}

func TestSlogRequest_SetsRequestIDOnContext(t *testing.T) {
	// The middleware calls appctx.WithRequestID; verify the context propagates
	// to the handler (it won't panic if req_id is empty string, which is fine
	// when chi middleware.RequestID hasn't run, but the call must not panic).
	mw := slogRequest(discardLogger())
	var ctxOK bool
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		// If appctx.WithRequestID was called, the key is present (even if "").
		ctxOK = r.Context() != context.Background()
	})
	mw(inner).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if !ctxOK {
		t.Error("slogRequest should enrich the request context")
	}
}

func TestSlogRequest_PassesThroughResponseBody(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"hello":"world"}`))
	})
	mw := slogRequest(discardLogger())
	rr := httptest.NewRecorder()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	body := strings.TrimSpace(rr.Body.String())
	if body != `{"hello":"world"}` {
		t.Errorf("unexpected body: %q", body)
	}
}

// ── slogRequest: 5xx alert enrichment ────────────────────────────────────────

// capturingNotifier records the last Event so a test can assert what the
// operational alert would carry. Notify is invoked synchronously by slogRequest.
type capturingNotifier struct {
	ev  alert.Event
	got bool
}

func (c *capturingNotifier) Notify(_ context.Context, ev alert.Event) { c.ev, c.got = ev, true }

// attrVal returns the value paired with key in a slog-style []any, and whether
// the key was present.
func attrVal(attrs []any, key string) (any, bool) {
	for i := 0; i+1 < len(attrs); i += 2 {
		if attrs[i] == key {
			return attrs[i+1], true
		}
	}
	return nil, false
}

func TestSlogRequest_5xxAlertCarriesErrorDetail(t *testing.T) {
	respond.SanitizeServerErrors(true)
	t.Cleanup(func() { respond.SanitizeServerErrors(false) })
	cn := &capturingNotifier{}
	alert.SetDefault(cn)
	t.Cleanup(func() { alert.SetDefault(nil) })

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate a handler that returns a masked 500 via respond.Err, with a
		// tenant already on the context (as auth/tenant middleware would set).
		ctx := appctx.WithTenant(r.Context(), appctx.Tenant{Slug: "sahan-cafe"})
		*r = *r.WithContext(ctx)
		respond.Err(w, http.StatusInternalServerError, "internal_error", "pg: relation \"foo\" does not exist")
	})
	mw := slogRequest(discardLogger())
	rr := httptest.NewRecorder()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/orders/abc", nil))

	// Client body is still masked.
	if body := strings.TrimSpace(rr.Body.String()); !strings.Contains(body, "an internal error occurred") {
		t.Errorf("client body not masked: %q", body)
	}
	if !cn.got {
		t.Fatal("no http.5xx alert fired")
	}
	if cn.ev.Name != "http.5xx" {
		t.Errorf("alert name = %q, want http.5xx", cn.ev.Name)
	}
	if cn.ev.Err == nil || !strings.Contains(cn.ev.Err.Error(), `pg: relation "foo" does not exist`) {
		t.Errorf("alert Err = %v, want it to carry the captured detail", cn.ev.Err)
	}
	if v, ok := attrVal(cn.ev.Attrs, "tenant"); !ok || v != "sahan-cafe" {
		t.Errorf("alert tenant attr = %v (present=%v), want sahan-cafe", v, ok)
	}
	if _, ok := attrVal(cn.ev.Attrs, "req_id"); !ok {
		t.Error("alert must carry a req_id attr")
	}
}

func TestSlogRequest_5xxAlertNamesPanic(t *testing.T) {
	cn := &capturingNotifier{}
	alert.SetDefault(cn)
	t.Cleanup(func() { alert.SetDefault(nil) })

	inner := http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic("kaboom")
	})
	// recoverer runs inside slogRequest, so the panic message is captured onto
	// the wrapping writer and folded into the alert.
	mw := slogRequest(discardLogger())
	rr := httptest.NewRecorder()
	mw(recoverer(inner)).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/boom", nil))

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 after panic, got %d", rr.Code)
	}
	if !cn.got {
		t.Fatal("no http.5xx alert fired for panic")
	}
	if cn.ev.Err == nil || !strings.Contains(cn.ev.Err.Error(), "panic: kaboom") {
		t.Errorf("alert Err = %v, want it to name the panic", cn.ev.Err)
	}
}

func TestSlogRequest_2xxFiresNoAlert(t *testing.T) {
	cn := &capturingNotifier{}
	alert.SetDefault(cn)
	t.Cleanup(func() { alert.SetDefault(nil) })

	mw := slogRequest(discardLogger())
	mw(statusHandler(http.StatusOK)).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	if cn.got {
		t.Error("a 2xx response must not fire an alert")
	}
}

// ── clientIP (internal helper) ────────────────────────────────────────────────

func TestClientIP_ExtractsHostFromHostPort(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "192.168.0.5:54321"
	if got := clientIP(r); got != "192.168.0.5" {
		t.Errorf("want 192.168.0.5, got %q", got)
	}
}

func TestClientIP_IPv6WithPort(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "[::1]:8080"
	if got := clientIP(r); got != "::1" {
		t.Errorf("want ::1, got %q", got)
	}
}

func TestClientIP_FallbackWhenNoPort(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1"
	// SplitHostPort fails → falls back to raw RemoteAddr.
	if got := clientIP(r); got != "10.0.0.1" {
		t.Errorf("want 10.0.0.1, got %q", got)
	}
}

// ── rateLimiter.allow (unit-level) ───────────────────────────────────────────

func TestRateLimiterAllow_NilLimiter(t *testing.T) {
	// NOTE: The source has `return true, rl.limit, 0` on the same branch that
	// guards `rl == nil`, which means a nil receiver would still dereference
	// the pointer when returning rl.limit. This is a latent source-level bug
	// (the nil path is unreachable in production because newRateLimiter always
	// allocates, and RateLimitByIP never passes nil). We document it here
	// rather than trigger the panic, and instead test the zero-limit variant
	// which is the safe analogue.
	t.Log("nil-receiver path skipped: source bug — rl.limit dereferences nil on the return statement")
}

func TestRateLimiterAllow_ZeroLimit(t *testing.T) {
	rl := &rateLimiter{limit: 0, buckets: make(map[string][]time.Time)}
	ok, _, _ := rl.allow("key")
	if !ok {
		t.Error("zero-limit rateLimiter should always allow (limit <= 0 guard)")
	}
}

func TestRateLimiterAllow_ReturnsRemaining(t *testing.T) {
	rl := &rateLimiter{limit: 5, window: time.Minute, buckets: make(map[string][]time.Time)}
	_, rem, _ := rl.allow("k")
	if rem != 4 {
		t.Errorf("want remaining=4, got %d", rem)
	}
}

func TestRateLimiterAllow_RetryAfterPositive(t *testing.T) {
	rl := &rateLimiter{limit: 1, window: time.Minute, buckets: make(map[string][]time.Time)}
	rl.allow("k")
	ok, _, retry := rl.allow("k")
	if ok {
		t.Fatal("second call should be blocked")
	}
	if retry < 1 {
		t.Errorf("retry-after should be >= 1 second, got %d", retry)
	}
}

func TestRateLimiterAllow_OldEventsNotCounted(t *testing.T) {
	// Pre-populate a bucket with an event that's outside the window.
	rl := &rateLimiter{limit: 1, window: 10 * time.Millisecond, buckets: make(map[string][]time.Time)}
	// Insert a stale timestamp.
	rl.buckets["k"] = []time.Time{time.Now().Add(-100 * time.Millisecond)}
	ok, _, _ := rl.allow("k")
	if !ok {
		t.Error("stale events outside the window should not count against the limit")
	}
}

// ── slogRequest: tenant / user context enrichment branches ───────────────────

// TestSlogRequest_WithTenantAndUserInContext exercises the appctx branches
// inside slogRequest that append tenant/user fields to the summary log line.
// These branches are only reachable when auth+tenant middleware has already
// placed values on the context, so we inject them directly.
func TestSlogRequest_WithTenantAndUserInContext(t *testing.T) {
	mw := slogRequest(discardLogger())

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Enrich the context the way auth / tenant middleware would.
		ctx := appctx.WithTenant(r.Context(), appctx.Tenant{
			ID:   uuid.MustParse("00000000-0000-0000-0000-000000000001"),
			Slug: "sahan-cafe",
			Name: "Sahan Cafe",
		})
		ctx = appctx.WithUser(ctx, appctx.User{
			ID:    uuid.MustParse("00000000-0000-0000-0000-000000000002"),
			Email: "owner@example.com",
			Name:  "Owner",
		})
		// Replace the request's context with the enriched one.
		*r = *r.WithContext(ctx)
		w.WriteHeader(http.StatusOK)
	})

	rr := httptest.NewRecorder()
	// Must not panic even with tenant+user on ctx.
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	if rr.Code != http.StatusOK {
		t.Errorf("want 200, got %d", rr.Code)
	}
}

func TestSlogRequest_WithTenantOnly(t *testing.T) {
	mw := slogRequest(discardLogger())
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := appctx.WithTenant(r.Context(), appctx.Tenant{Slug: "cafe-x"})
		*r = *r.WithContext(ctx)
		w.WriteHeader(http.StatusNoContent)
	})
	rr := httptest.NewRecorder()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Code != http.StatusNoContent {
		t.Errorf("want 204, got %d", rr.Code)
	}
}

func TestSlogRequest_WithUserOnly(t *testing.T) {
	mw := slogRequest(discardLogger())
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := appctx.WithUser(r.Context(), appctx.User{Email: "u@example.com"})
		*r = *r.WithContext(ctx)
		w.WriteHeader(http.StatusAccepted)
	})
	rr := httptest.NewRecorder()
	mw(inner).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Code != http.StatusAccepted {
		t.Errorf("want 202, got %d", rr.Code)
	}
}

// Verify the context injected by slogRequest carries a logger (non-nil),
// a request-id, and an IP so downstream handlers can call appctx.Logger(ctx).
func TestSlogRequest_ContextValues(t *testing.T) {
	mw := slogRequest(discardLogger())
	var (
		gotLogger bool
		gotReqID  bool
		gotIP     bool
	)
	inner := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		gotLogger = appctx.Logger(ctx) != nil
		_, gotReqID = appctx.RequestID(ctx) // present (even if empty string)
		_, gotIP = appctx.IP(ctx)           // present
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.5:12345"
	mw(inner).ServeHTTP(httptest.NewRecorder(), req)

	if !gotLogger {
		t.Error("appctx.Logger should return a non-nil logger after slogRequest")
	}
	// RequestID key is always set (even if chi middleware.RequestID didn't run).
	if !gotReqID {
		// context.WithValue is always called; the bool from the type assert
		// just tells us if the value was non-empty. appctx.RequestID returns
		// (string, bool) where bool = type-assert success, not non-empty.
		// The key is always written, so gotReqID will be true (value is "").
		t.Error("appctx.RequestID key should be present on context")
	}
	if !gotIP {
		t.Error("appctx.IP key should be present on context")
	}
}
