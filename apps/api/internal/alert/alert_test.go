package alert

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitForBody(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case b := <-ch:
		return b
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for webhook POST")
		return ""
	}
}

func TestWebhookNotifier_PostsSlackCompatiblePayload(t *testing.T) {
	received := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		b, _ := io.ReadAll(r.Body)
		received <- string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	n := NewWebhook(srv.URL, "cafe-mgmt/test", 0) // throttle disabled
	n.Notify(context.Background(), Event{
		Level: slog.LevelError,
		Name:  "otp.send_failed",
		Err:   errors.New("smtp: 554 not verified"),
		Attrs: []any{"to", "x@y.com"},
	})

	body := waitForBody(t, received)
	var payload map[string]string
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("payload is not JSON: %v (%s)", err, body)
	}
	text := payload["text"]
	for _, want := range []string{"cafe-mgmt/test", "otp.send_failed", "554 not verified", "x@y.com"} {
		if !strings.Contains(text, want) {
			t.Errorf("alert text missing %q; got: %s", want, text)
		}
	}
}

func TestWebhookNotifier_ThrottlesAndReportsSuppressed(t *testing.T) {
	var mu sync.Mutex
	var posts int
	bodies := make(chan string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		posts++
		mu.Unlock()
		bodies <- string(b)
	}))
	defer srv.Close()

	n := NewWebhook(srv.URL, "svc", time.Minute)
	base := time.Unix(1_700_000_000, 0)
	cur := base
	n.nowFn = func() time.Time { return cur }

	// First fire sends; the next two within the window are suppressed.
	ev := Event{Name: "http.5xx", Level: slog.LevelError}
	n.Notify(context.Background(), ev)
	n.Notify(context.Background(), ev)
	n.Notify(context.Background(), ev)
	waitForBody(t, bodies) // the first POST

	// Advance past the window; the next send reports the 2 suppressed.
	cur = base.Add(time.Minute + time.Second)
	n.Notify(context.Background(), ev)
	body := waitForBody(t, bodies)
	if !strings.Contains(body, "+2 more suppressed") {
		t.Errorf("expected suppressed-count note, got: %s", body)
	}

	mu.Lock()
	got := posts
	mu.Unlock()
	if got != 2 {
		t.Errorf("expected exactly 2 POSTs (1 initial + 1 after window), got %d", got)
	}
}

func TestWebhookNotifier_PostFailureDoesNotPanic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // connection now refused

	n := NewWebhook(url, "svc", 0)
	n.Notify(context.Background(), Event{Name: "x", Level: slog.LevelError, Err: errors.New("boom")})
	// The failing POST runs on its own goroutine; it must log-and-return, not
	// panic. Give it a moment to complete.
	time.Sleep(100 * time.Millisecond)
}

func TestFire_LogsAndDispatches(t *testing.T) {
	var buf bytes.Buffer
	prevLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prevLog)

	fake := &captureNotifier{}
	prevN := Default()
	SetDefault(fake)
	defer SetDefault(prevN)

	wantErr := errors.New("boom")
	Fire(context.Background(), slog.LevelError, "test.event", wantErr, "k", "v")

	logged := buf.String()
	for _, want := range []string{"test.event", "boom", `"k":"v"`} {
		if !strings.Contains(logged, want) {
			t.Errorf("log missing %q; got: %s", want, logged)
		}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.events) != 1 {
		t.Fatalf("expected 1 dispatched event, got %d", len(fake.events))
	}
	if fake.events[0].Name != "test.event" || fake.events[0].Err != wantErr {
		t.Errorf("dispatched event mismatch: %+v", fake.events[0])
	}
}

func TestSetDefault_NilResetsToNoop(t *testing.T) {
	prev := Default()
	defer SetDefault(prev)

	SetDefault(nil)
	if _, ok := Default().(NoopNotifier); !ok {
		t.Fatalf("expected NoopNotifier after SetDefault(nil), got %T", Default())
	}
	// Must not panic.
	Default().Notify(context.Background(), Event{Name: "x"})
}

func TestIsDiscord(t *testing.T) {
	cases := map[string]bool{
		"https://discord.com/api/webhooks/123/abc":    true,
		"https://discordapp.com/api/webhooks/123/abc": true,
		"https://hooks.slack.com/services/X/Y/Z":      false,
		"https://mattermost.example.com/hooks/abc":    false,
	}
	for url, want := range cases {
		if got := isDiscord(url); got != want {
			t.Errorf("isDiscord(%q) = %v, want %v", url, got, want)
		}
	}
}

func TestWebhookNotifier_DiscordUsesContentField(t *testing.T) {
	received := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		received <- string(b)
		w.WriteHeader(http.StatusNoContent) // Discord returns 204
	}))
	defer srv.Close()

	n := NewWebhook(srv.URL, "svc", 0)
	n.discord = true // srv.URL isn't a discord host; force the discord payload shape

	n.Notify(context.Background(), Event{Name: "http.5xx", Level: slog.LevelError})
	body := waitForBody(t, received)

	var payload map[string]string
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("payload is not JSON: %v (%s)", err, body)
	}
	if _, ok := payload["content"]; !ok {
		t.Errorf("discord payload should use the content field; got: %s", body)
	}
	if _, ok := payload["text"]; ok {
		t.Errorf("discord payload should not carry a text field; got: %s", body)
	}
}

type captureNotifier struct {
	mu     sync.Mutex
	events []Event
}

func (c *captureNotifier) Notify(_ context.Context, ev Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, ev)
}
