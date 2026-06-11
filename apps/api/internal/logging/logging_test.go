package logging

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// New — basic construction
// ---------------------------------------------------------------------------

func TestNew_ReturnsNonNil(t *testing.T) {
	l := New("dev", "", "")
	if l == nil {
		t.Fatal("New returned nil")
	}
}

func TestNew_PrettyFormat_InDev(t *testing.T) {
	// Should not panic; returns a usable logger.
	l := New("dev", "info", "pretty")
	if l == nil {
		t.Fatal("New returned nil with pretty format")
	}
}

func TestNew_JSONFormat_Explicit(t *testing.T) {
	l := New("dev", "info", "json")
	if l == nil {
		t.Fatal("New returned nil with json format")
	}
}

func TestNew_JSONFormat_DefaultInProd(t *testing.T) {
	l := New("prod", "", "") // empty format → should pick json
	if l == nil {
		t.Fatal("New returned nil for prod env")
	}
}

func TestNew_PrettyFormat_DefaultInTest(t *testing.T) {
	l := New("test", "", "")
	if l == nil {
		t.Fatal("New returned nil for test env")
	}
}

func TestNew_UnknownFormat_FallsToPretty(t *testing.T) {
	l := New("dev", "info", "logfmt")
	if l == nil {
		t.Fatal("New returned nil for unknown format")
	}
}

// ---------------------------------------------------------------------------
// parseLevel
// ---------------------------------------------------------------------------

func TestParseLevel(t *testing.T) {
	cases := []struct {
		in   string
		want slog.Level
	}{
		{"debug", slog.LevelDebug},
		{"DEBUG", slog.LevelDebug},
		{"warn", slog.LevelWarn},
		{"warning", slog.LevelWarn},
		{"WARN", slog.LevelWarn},
		{"error", slog.LevelError},
		{"err", slog.LevelError},
		{"ERR", slog.LevelError},
		{"info", slog.LevelInfo},
		{"INFO", slog.LevelInfo},
		{"", slog.LevelInfo},
		{"  ", slog.LevelInfo},
		{"unknown", slog.LevelInfo},
		{"trace", slog.LevelInfo},
	}
	for _, tc := range cases {
		got := parseLevel(tc.in)
		if got != tc.want {
			t.Errorf("parseLevel(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Logger emits records at the correct level
// ---------------------------------------------------------------------------

func TestNew_LevelDebug_EmitsDebug(t *testing.T) {
	var buf bytes.Buffer
	// Override New to use our buf — build a handler directly to inspect output.
	h := newPrettyHandler(&buf, slog.LevelDebug, false)
	l := slog.New(h)

	l.Debug("debug-message")
	if !strings.Contains(buf.String(), "debug-message") {
		t.Errorf("debug record missing; output: %q", buf.String())
	}
}

func TestNew_LevelInfo_DropDebug(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelInfo, false)
	l := slog.New(h)

	l.Debug("should-be-dropped")
	if strings.Contains(buf.String(), "should-be-dropped") {
		t.Error("debug record should be dropped at info level")
	}
}

func TestNew_LevelWarn_DropInfo(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelWarn, false)
	l := slog.New(h)

	l.Info("should-be-dropped")
	l.Warn("should-appear")

	if strings.Contains(buf.String(), "should-be-dropped") {
		t.Error("info record should be dropped at warn level")
	}
	if !strings.Contains(buf.String(), "should-appear") {
		t.Error("warn record should appear at warn level")
	}
}

func TestNew_LevelError_DropWarn(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelError, false)
	l := slog.New(h)

	l.Warn("should-be-dropped")
	l.Error("should-appear")

	if strings.Contains(buf.String(), "should-be-dropped") {
		t.Error("warn record should be dropped at error level")
	}
	if !strings.Contains(buf.String(), "should-appear") {
		t.Error("error record should appear at error level")
	}
}

// ---------------------------------------------------------------------------
// prettyHandler output format
// ---------------------------------------------------------------------------

func TestPrettyHandler_ContainsMessage(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelInfo, false)
	l := slog.New(h)

	l.Info("hello world")
	if !strings.Contains(buf.String(), "hello world") {
		t.Errorf("message missing from output: %q", buf.String())
	}
}

func TestPrettyHandler_ContainsAttrs(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelInfo, false)
	l := slog.New(h)

	l.Info("msg", "key", "value")
	out := buf.String()
	if !strings.Contains(out, "key=") {
		t.Errorf("key attr missing from output: %q", out)
	}
	if !strings.Contains(out, "value") {
		t.Errorf("value missing from output: %q", out)
	}
}

func TestPrettyHandler_ContainsLevelLabel(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelDebug, false)
	l := slog.New(h)

	l.Debug("d")
	l.Info("i")
	l.Warn("w")
	l.Error("e")

	out := buf.String()
	for _, label := range []string{"DBG", "INF", "WRN", "ERR"} {
		if !strings.Contains(out, label) {
			t.Errorf("level label %q missing from output:\n%s", label, out)
		}
	}
}

func TestPrettyHandler_WithAttrs(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelInfo, false)
	l := slog.New(h.WithAttrs([]slog.Attr{slog.String("req_id", "abc")}))

	l.Info("msg")
	if !strings.Contains(buf.String(), "req_id=abc") {
		t.Errorf("WithAttrs value not in output: %q", buf.String())
	}
}

func TestPrettyHandler_WithAttrs_Empty_ReturnsSelf(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelInfo, false)
	got := h.WithAttrs(nil)
	if got != h {
		t.Error("WithAttrs(nil) should return the same handler")
	}
}

func TestPrettyHandler_WithGroup(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelInfo, false)
	l := slog.New(h.WithGroup("req"))
	l.Info("msg", "id", "123")

	out := buf.String()
	if !strings.Contains(out, "req.id=") {
		t.Errorf("group prefix missing from output: %q", out)
	}
}

func TestPrettyHandler_WithGroup_Empty_ReturnsSelf(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelInfo, false)
	got := h.WithGroup("")
	if got != h {
		t.Error("WithGroup(\"\") should return the same handler")
	}
}

func TestPrettyHandler_Enabled(t *testing.T) {
	h := newPrettyHandler(bytes.NewBuffer(nil), slog.LevelWarn, false)
	if h.Enabled(context.Background(), slog.LevelInfo) {
		t.Error("Info should not be enabled at Warn level")
	}
	if !h.Enabled(context.Background(), slog.LevelWarn) {
		t.Error("Warn should be enabled at Warn level")
	}
	if !h.Enabled(context.Background(), slog.LevelError) {
		t.Error("Error should be enabled at Warn level")
	}
}

func TestPrettyHandler_NoColor_NoEscapes(t *testing.T) {
	var buf bytes.Buffer
	h := newPrettyHandler(&buf, slog.LevelInfo, false) // tty=false
	l := slog.New(h)
	l.Info("test color")

	out := buf.String()
	if strings.Contains(out, "\x1b[") {
		t.Errorf("ANSI escapes should not appear when color is disabled: %q", out)
	}
}

// ---------------------------------------------------------------------------
// formatValue
// ---------------------------------------------------------------------------

func TestFormatValue_String(t *testing.T) {
	cases := []struct {
		in   slog.Value
		want string
	}{
		{slog.StringValue("plain"), "plain"},
		{slog.StringValue(""), `""`},
		{slog.StringValue("has space"), `"has space"`},
		{slog.StringValue(`has"quote`), `"has\"quote"`},
	}
	for _, tc := range cases {
		got := formatValue(tc.in)
		if got != tc.want {
			t.Errorf("formatValue(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestFormatValue_Int(t *testing.T) {
	got := formatValue(slog.Int64Value(42))
	if got != "42" {
		t.Errorf("got %q, want 42", got)
	}
}

func TestFormatValue_Bool(t *testing.T) {
	if got := formatValue(slog.BoolValue(true)); got != "true" {
		t.Errorf("got %q", got)
	}
	if got := formatValue(slog.BoolValue(false)); got != "false" {
		t.Errorf("got %q", got)
	}
}

func TestFormatValue_Duration(t *testing.T) {
	got := formatValue(slog.DurationValue(5 * 1e9)) // 5s
	if got != "5s" {
		t.Errorf("got %q", got)
	}
}

func TestFormatValue_Float64(t *testing.T) {
	got := formatValue(slog.Float64Value(3.14))
	if got != "3.14" {
		t.Errorf("got %q", got)
	}
}

// ---------------------------------------------------------------------------
// New with json format writes valid JSON lines
// ---------------------------------------------------------------------------

func TestNew_JSONFormat_ValidJSON(t *testing.T) {
	var buf bytes.Buffer
	// Build a JSON logger pointing at our buffer.
	h := slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	l := slog.New(h)

	l.Info("structured log", "user", "alice", "count", 3)

	line := strings.TrimSpace(buf.String())
	if !strings.HasPrefix(line, "{") {
		t.Errorf("expected JSON object, got: %q", line)
	}
	if !strings.Contains(line, `"msg"`) {
		t.Errorf("msg field missing in JSON: %q", line)
	}
}
