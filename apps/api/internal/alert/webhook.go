package alert

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// WebhookNotifier posts alerts to an incoming-webhook URL. It speaks both the
// Slack/Mattermost shape ({"text": …}) and the Discord shape ({"content": …}),
// auto-detected from the URL. It is safe for concurrent use.
//
// Delivery is out-of-band: Notify hands off to a short-lived goroutine with its
// own timeout context, so it never blocks the caller and never inherits the
// caller's (possibly cancelled) request context. Per-event throttling collapses
// storms — when the same event fires repeatedly during an outage, at most one
// message is sent per throttle window and the next one reports how many were
// suppressed. If the POST itself fails it is logged once and never re-alerted
// (that would recurse into another storm).
type WebhookNotifier struct {
	url      string
	service  string
	throttle time.Duration
	discord  bool
	client   *http.Client
	nowFn    func() time.Time

	mu   sync.Mutex
	last map[string]*throttleState
}

type throttleState struct {
	lastSent   time.Time
	suppressed int
}

// NewWebhook builds a WebhookNotifier. service labels the source and prefixes
// every message (e.g. "cafe-mgmt/prod"). A throttle <= 0 disables throttling.
func NewWebhook(url, service string, throttle time.Duration) *WebhookNotifier {
	return &WebhookNotifier{
		url:      url,
		service:  service,
		throttle: throttle,
		discord:  isDiscord(url),
		client:   &http.Client{Timeout: 10 * time.Second},
		nowFn:    time.Now,
		last:     make(map[string]*throttleState),
	}
}

// isDiscord reports whether the URL is a Discord webhook, which expects a
// {"content": …} body instead of Slack/Mattermost's {"text": …}.
func isDiscord(url string) bool {
	return strings.Contains(url, "discord.com/api/webhooks") ||
		strings.Contains(url, "discordapp.com/api/webhooks")
}

// Notify implements Notifier.
func (n *WebhookNotifier) Notify(_ context.Context, ev Event) {
	send, suppressed := n.admit(ev.Name)
	if !send {
		return
	}
	text := n.format(ev, suppressed)
	go n.post(text)
}

// admit applies per-event throttling. It returns whether to send now and, when
// sending, how many events of the same key were suppressed since the last send.
func (n *WebhookNotifier) admit(key string) (send bool, suppressed int) {
	if n.throttle <= 0 {
		return true, 0
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	t := n.nowFn()
	st := n.last[key]
	if st == nil {
		n.last[key] = &throttleState{lastSent: t}
		return true, 0
	}
	if t.Sub(st.lastSent) >= n.throttle {
		s := st.suppressed
		st.lastSent = t
		st.suppressed = 0
		return true, s
	}
	st.suppressed++
	return false, 0
}

func (n *WebhookNotifier) format(ev Event, suppressed int) string {
	// Discord bold is **x**; Slack/Mattermost bold is *x*. Backticks and _italic_
	// render the same in both.
	bold := "*"
	if n.discord {
		bold = "**"
	}
	var b strings.Builder
	icon := "⚠️"
	if ev.Level >= slog.LevelError {
		icon = "🚨"
	}
	fmt.Fprintf(&b, "%s %s%s%s `%s`", icon, bold, n.service, bold, ev.Name)
	if ev.Err != nil {
		fmt.Fprintf(&b, "\n> %s", truncate(ev.Err.Error(), 500))
	}
	for i := 0; i+1 < len(ev.Attrs); i += 2 {
		fmt.Fprintf(&b, "\n• %v: %s", ev.Attrs[i], truncate(fmt.Sprintf("%v", ev.Attrs[i+1]), 500))
	}
	if suppressed > 0 {
		fmt.Fprintf(&b, "\n_(+%d more suppressed in the last %s)_", suppressed, n.throttle)
	}
	out := b.String()
	if n.discord {
		// Discord hard-caps message content at 2000 chars; keep a margin.
		out = truncate(out, 1900)
	}
	return out
}

func (n *WebhookNotifier) post(text string) {
	field := "text"
	if n.discord {
		field = "content"
	}
	body, err := json.Marshal(map[string]string{field: text})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), n.client.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.url, bytes.NewReader(body))
	if err != nil {
		slog.Default().Warn("alert.webhook_build_failed", "err", err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := n.client.Do(req)
	if err != nil {
		// Log once; do NOT re-alert — that would recurse and storm.
		slog.Default().Warn("alert.webhook_post_failed", "err", err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		slog.Default().Warn("alert.webhook_bad_status", "status", resp.StatusCode)
	}
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
