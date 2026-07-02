// Package alert surfaces operationally-important failures to operators the
// moment they happen, instead of leaving them buried in logs nobody watches.
//
// It mirrors log/slog's ergonomics: a single process-wide default Notifier is
// installed once at startup (SetDefault), and Fire is a one-liner that both
// emits a structured slog record AND pushes an out-of-band alert. Wiring a new
// "swallowed error" site into alerting is therefore a single call:
//
//	alert.Fire(ctx, slog.LevelError, "otp.send_failed", err, "to", to)
//
// Design principles:
//   - Structured logs remain the source of truth — they always ship to the log
//     aggregator (CloudWatch). Alerts are an additional, throttled, human-facing
//     signal reserved for the events that matter.
//   - Dispatch never blocks the caller and never depends on the (often already
//     cancelled) request context — see WebhookNotifier.
//   - A site that ALREADY writes its own log line should call Default().Notify
//     directly rather than Fire, to avoid emitting a duplicate log record.
package alert

import (
	"context"
	"log/slog"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// Event is a single alert-worthy occurrence.
type Event struct {
	Level slog.Level // severity (LevelWarn / LevelError …)
	Name  string     // stable event key, e.g. "otp.send_failed"; also the throttle key
	Err   error      // optional underlying error
	Attrs []any      // slog-style key/value context pairs
}

// Notifier delivers an Event to an out-of-band sink (Slack, SNS, …).
// Implementations must be safe for concurrent use and must not block the
// caller.
type Notifier interface {
	Notify(ctx context.Context, ev Event)
}

// NoopNotifier drops every event. It is the default until SetDefault installs a
// real sink; the structured log still reaches the aggregator either way.
type NoopNotifier struct{}

// Notify implements Notifier.
func (NoopNotifier) Notify(context.Context, Event) {}

var defaultNotifier Notifier = NoopNotifier{}

// SetDefault installs the process-wide notifier. Call once at startup, before
// serving traffic (mirrors slog.SetDefault). A nil value resets to no-op.
func SetDefault(n Notifier) {
	if n == nil {
		n = NoopNotifier{}
	}
	defaultNotifier = n
}

// Default returns the process-wide notifier (never nil).
func Default() Notifier { return defaultNotifier }

// Fire records a swallowed / best-effort failure so it is BOTH logged and
// surfaced: it emits a structured slog record via the request logger (falling
// back to slog.Default when the context carries none) and dispatches the event
// to the default notifier.
//
// Use Fire at sites that do not otherwise log. For sites that already emit their
// own log line (e.g. the HTTP request-summary middleware), call Default().Notify
// directly to avoid a duplicate record.
func Fire(ctx context.Context, level slog.Level, name string, err error, args ...any) {
	attrs := args
	if err != nil {
		attrs = append(attrs[:len(attrs):len(attrs)], "err", err.Error())
	}
	appctx.Logger(ctx).Log(ctx, level, name, attrs...)
	defaultNotifier.Notify(ctx, Event{Level: level, Name: name, Err: err, Attrs: args})
}
