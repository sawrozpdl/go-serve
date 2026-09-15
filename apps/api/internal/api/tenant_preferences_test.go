package api

import "testing"

// The preferences allowlist in UpdateTenant is a hand-maintained struct, and a
// key the client writes but the struct omits is not an error anywhere: the
// decoder drops it, the patch map never sees it, the PATCH returns 200, and the
// setting silently fails to persist. That is exactly what happened to
// reportPresets — the web app had been saving report layouts into a key the
// server threw away, so no preset ever survived a reload and nothing reported a
// problem.
//
// These are round-trip tests: PATCH the key, re-read the tenant, assert the
// value came back. They are the cheap guard against the next key that gets
// added to the TypeScript type and forgotten here.

func TestUpdateTenant_PersistsReportPresets(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	presets := []map[string]any{
		{"name": "Monthly P&L", "spec": map[string]any{"title": "Monthly P&L", "sections": []any{}}},
		{"name": "Daily close", "spec": map[string]any{"title": "Daily close", "sections": []any{}}},
	}
	got := tenantPrefsAfterUpdate(t, fx, map[string]any{"reportPresets": presets})

	saved, ok := got["reportPresets"].([]any)
	if !ok {
		t.Fatalf("reportPresets missing from persisted preferences: %#v", got)
	}
	if len(saved) != 2 {
		t.Fatalf("reportPresets round-tripped %d layouts, want 2", len(saved))
	}
	first, ok := saved[0].(map[string]any)
	if !ok || first["name"] != "Monthly P&L" {
		t.Fatalf("first preset did not survive the round trip: %#v", saved[0])
	}
}

func TestUpdateTenant_RejectsTooManyReportPresets(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	many := make([]map[string]any, maxReportPresets+1)
	for i := range many {
		many[i] = map[string]any{"name": "layout"}
	}
	callHandler(t, fx, UpdateTenant, "PATCH", "/v1/tenant",
		map[string]any{"preferences": map[string]any{"reportPresets": many}}).
		expectStatus(400)
}

func TestUpdateTenant_PersistsHiddenReportSections(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	got := tenantPrefsAfterUpdate(t, fx, map[string]any{
		"hiddenReportSections": []string{"audit.activity", "money.owner_ledger"},
	})
	hidden, ok := got["hiddenReportSections"].([]any)
	if !ok {
		t.Fatalf("hiddenReportSections missing from persisted preferences: %#v", got)
	}
	if len(hidden) != 2 || hidden[0] != "audit.activity" {
		t.Fatalf("hiddenReportSections round-tripped as %#v", hidden)
	}

	// Emptying it must clear the list, not be ignored as "not sent" — a
	// workspace turning every report back on is an ordinary thing to do.
	got = tenantPrefsAfterUpdate(t, fx, map[string]any{"hiddenReportSections": []string{}})
	if hidden, _ := got["hiddenReportSections"].([]any); len(hidden) != 0 {
		t.Fatalf("hiddenReportSections did not clear: %#v", got["hiddenReportSections"])
	}
}

func TestUpdateTenant_PersistsPosItemPicker(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	for _, mode := range []string{"search", "categories", "both"} {
		got := tenantPrefsAfterUpdate(t, fx, map[string]any{"posItemPicker": mode})
		if got["posItemPicker"] != mode {
			t.Fatalf("posItemPicker = %#v, want %q", got["posItemPicker"], mode)
		}
	}
}

func TestUpdateTenant_RejectsUnknownPosItemPicker(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	// A typo must be refused rather than stored: posPickerLayout falls back to
	// "both" for anything it does not recognise, so a bad value would persist
	// and look like it worked while doing nothing.
	callHandler(t, fx, UpdateTenant, "PATCH", "/v1/tenant",
		map[string]any{"preferences": map[string]any{"posItemPicker": "serch"}}).
		expectStatus(400)

	resp := callHandler(t, fx, GetTenant, "GET", "/v1/tenant", nil).expectStatus(200)
	out := struct {
		Preferences map[string]any `json:"preferences"`
	}{}
	resp.decode(&out)
	if _, present := out.Preferences["posItemPicker"]; present {
		t.Fatalf("a rejected posItemPicker was stored anyway: %#v", out.Preferences)
	}
}

func TestUpdateTenant_PreferenceKeysDoNotClobberEachOther(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	tenantPrefsAfterUpdate(t, fx, map[string]any{"posItemPicker": "search"})
	got := tenantPrefsAfterUpdate(t, fx, map[string]any{
		"hiddenReportSections": []string{"audit.activity"},
	})

	// The jsonb merge is `preferences || patch`, so an untouched key must
	// survive a patch that never mentions it.
	if got["posItemPicker"] != "search" {
		t.Fatalf("posItemPicker lost to an unrelated patch: %#v", got)
	}
}
