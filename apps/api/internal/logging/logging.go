// Package logging builds the application's slog logger.
//
// Two output formats are supported:
//
//   - "pretty"  — human-readable, colorized, single-line records. The default
//     in dev/test. Looks like:
//       14:32:01.123 INF http  method=GET path=/v1/me status=200 dur=12ms
//
//   - "json"    — one structured JSON object per record. The default in prod
//     and the right choice for any log shipper / aggregator.
//
// Level and format come from env (LOG_LEVEL, LOG_FORMAT). Both are optional.
package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// New builds the application logger. env is used only to pick sensible
// defaults when level/format are empty.
func New(env, level, format string) *slog.Logger {
	lvl := parseLevel(level)
	f := strings.ToLower(strings.TrimSpace(format))
	if f == "" {
		if env == "prod" {
			f = "json"
		} else {
			f = "pretty"
		}
	}

	var h slog.Handler
	switch f {
	case "json":
		h = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})
	default:
		h = newPrettyHandler(os.Stdout, lvl, isTerminal(os.Stdout))
	}
	return slog.New(h)
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error", "err":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// =============================================================================
// pretty handler
// =============================================================================

// prettyHandler renders slog records as a single human-readable line.
//
// Layout:
//   <time> <level> <message>  key=value key=value ...
//
// Colors are applied only when stdout is a TTY and NO_COLOR is unset.
type prettyHandler struct {
	w      io.Writer
	mu     *sync.Mutex
	level  slog.Leveler
	color  bool
	attrs  []slog.Attr
	groups []string
}

func newPrettyHandler(w io.Writer, level slog.Leveler, tty bool) *prettyHandler {
	return &prettyHandler{
		w:     w,
		mu:    &sync.Mutex{},
		level: level,
		color: tty && os.Getenv("NO_COLOR") == "",
	}
}

func (h *prettyHandler) Enabled(_ context.Context, l slog.Level) bool {
	return l >= h.level.Level()
}

func (h *prettyHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	out := *h
	out.attrs = append(append([]slog.Attr{}, h.attrs...), attrs...)
	return &out
}

func (h *prettyHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	out := *h
	out.groups = append(append([]string{}, h.groups...), name)
	return &out
}

func (h *prettyHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	b.Grow(128)

	// time — dim
	if !r.Time.IsZero() {
		h.colorize(&b, colorDim, r.Time.Format("15:04:05.000"))
		b.WriteByte(' ')
	}
	// level — colored, fixed-width
	h.writeLevel(&b, r.Level)
	b.WriteByte(' ')
	// message — bold
	h.colorize(&b, colorBold, r.Message)

	// attrs — preceded by two spaces
	prefix := strings.Join(h.groups, ".")
	for _, a := range h.attrs {
		h.writeAttr(&b, prefix, a)
	}
	r.Attrs(func(a slog.Attr) bool {
		h.writeAttr(&b, prefix, a)
		return true
	})

	b.WriteByte('\n')

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := io.WriteString(h.w, b.String())
	return err
}

func (h *prettyHandler) writeLevel(b *strings.Builder, l slog.Level) {
	var label, c string
	switch {
	case l >= slog.LevelError:
		label, c = "ERR", colorRed
	case l >= slog.LevelWarn:
		label, c = "WRN", colorYellow
	case l >= slog.LevelInfo:
		label, c = "INF", colorGreen
	default:
		label, c = "DBG", colorCyan
	}
	h.colorize(b, c, label)
}

// writeAttr appends ` key=value` to b. Keys with spaces or special chars get
// no quoting (slog convention) — values do, when they contain whitespace.
func (h *prettyHandler) writeAttr(b *strings.Builder, prefix string, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Equal(slog.Attr{}) {
		return
	}

	// nested groups: flatten with dotted prefix.
	if a.Value.Kind() == slog.KindGroup {
		next := a.Key
		if prefix != "" && next != "" {
			next = prefix + "." + next
		} else if next == "" {
			next = prefix
		}
		for _, ga := range a.Value.Group() {
			h.writeAttr(b, next, ga)
		}
		return
	}

	key := a.Key
	if prefix != "" {
		key = prefix + "." + key
	}

	b.WriteByte(' ')
	h.colorize(b, colorDim, key+"=")
	b.WriteString(formatValue(a.Value))
}

func formatValue(v slog.Value) string {
	switch v.Kind() {
	case slog.KindString:
		s := v.String()
		if s == "" {
			return `""`
		}
		if strings.ContainsAny(s, " \t\"") {
			return strconv.Quote(s)
		}
		return s
	case slog.KindInt64:
		return strconv.FormatInt(v.Int64(), 10)
	case slog.KindUint64:
		return strconv.FormatUint(v.Uint64(), 10)
	case slog.KindFloat64:
		return strconv.FormatFloat(v.Float64(), 'f', -1, 64)
	case slog.KindBool:
		return strconv.FormatBool(v.Bool())
	case slog.KindDuration:
		return v.Duration().String()
	case slog.KindTime:
		return v.Time().Format(time.RFC3339Nano)
	default:
		s := fmt.Sprint(v.Any())
		if strings.ContainsAny(s, " \t\"") {
			return strconv.Quote(s)
		}
		return s
	}
}

// =============================================================================
// color
// =============================================================================

const (
	colorReset  = "\x1b[0m"
	colorDim    = "\x1b[2m"
	colorBold   = "\x1b[1m"
	colorRed    = "\x1b[31m"
	colorGreen  = "\x1b[32m"
	colorYellow = "\x1b[33m"
	colorCyan   = "\x1b[36m"
)

func (h *prettyHandler) colorize(b *strings.Builder, c, s string) {
	if h.color && c != "" {
		b.WriteString(c)
		b.WriteString(s)
		b.WriteString(colorReset)
		return
	}
	b.WriteString(s)
}

// isTerminal reports whether f is connected to an interactive terminal.
// Implemented without extra deps via the file mode bit set on character
// devices (TTYs) but not on pipes/files.
func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	if err != nil {
		return false
	}
	return st.Mode()&os.ModeCharDevice != 0
}
