package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

func decodeLine(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal log line: %v (%s)", err, b)
	}
	return m
}

func newEnrichedLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(WithContextEnrichment(slog.NewJSONHandler(buf, &slog.HandlerOptions{})))
}

func TestContextHandler_EnrichesTenantAndUser(t *testing.T) {
	buf := &bytes.Buffer{}
	log := newEnrichedLogger(buf)

	uid := uuid.New()
	tid := uuid.New()
	ctx := appctx.WithRequestInfo(context.Background())
	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: tid, Slug: "sahan-cafe"})
	ctx = appctx.WithUser(ctx, appctx.User{ID: uid, Email: "owner@sahan.test"})

	log.InfoContext(ctx, "house_tabs.list")

	m := decodeLine(t, buf.Bytes())
	if m["tenant"] != "sahan-cafe" {
		t.Errorf("tenant = %v, want sahan-cafe", m["tenant"])
	}
	if m["tenant_id"] != tid.String() {
		t.Errorf("tenant_id = %v, want %s", m["tenant_id"], tid)
	}
	if m["user"] != "owner@sahan.test" {
		t.Errorf("user = %v, want owner@sahan.test", m["user"])
	}
	if m["user_id"] != uid.String() {
		t.Errorf("user_id = %v, want %s", m["user_id"], uid)
	}
}

func TestContextHandler_NoHolderIsNoop(t *testing.T) {
	buf := &bytes.Buffer{}
	newEnrichedLogger(buf).InfoContext(context.Background(), "no ctx info")
	m := decodeLine(t, buf.Bytes())
	if _, ok := m["tenant"]; ok {
		t.Error("must not add tenant when no RequestInfo holder is present")
	}
}

func TestContextHandler_DoesNotDuplicateExplicitKeys(t *testing.T) {
	buf := &bytes.Buffer{}
	log := newEnrichedLogger(buf)

	ctx := appctx.WithRequestInfo(context.Background())
	ctx = appctx.WithTenant(ctx, appctx.Tenant{Slug: "holder-slug"})

	// Handler already logs tenant explicitly — the holder value must not clobber
	// or double it.
	log.InfoContext(ctx, "explicit", "tenant", "explicit-slug")

	// A duplicated key would make Unmarshal keep the last; assert we kept the
	// explicit one and did not emit a second tenant field.
	line := buf.String()
	if got := countKey(line, `"tenant":`); got != 1 {
		t.Errorf("tenant key appears %d times, want 1: %s", got, line)
	}
	if m := decodeLine(t, buf.Bytes()); m["tenant"] != "explicit-slug" {
		t.Errorf("tenant = %v, want explicit-slug (explicit call site wins)", m["tenant"])
	}
}

func countKey(s, key string) int {
	n := 0
	for i := 0; i+len(key) <= len(s); i++ {
		if s[i:i+len(key)] == key {
			n++
		}
	}
	return n
}
