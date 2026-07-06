package api

import "testing"

// tenantPrefsAfterUpdate PATCHes /v1/tenant and returns the persisted preferences
// map from the GetTenant response the handler tail-calls.
func tenantPrefsAfterUpdate(t *testing.T, fx *fixture, prefs map[string]any) map[string]any {
	t.Helper()
	resp := callHandler(t, fx, UpdateTenant, "PATCH", "/v1/tenant",
		map[string]any{"preferences": prefs}).expectStatus(200)
	out := struct {
		Preferences map[string]any `json:"preferences"`
	}{}
	resp.decode(&out)
	return out.Preferences
}

func TestUpdateTenant_PersistsNetworkPrinters(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	kitchen := []map[string]any{
		{"id": "k1", "label": "Hot Kitchen", "type": "network", "ip": "192.168.1.50", "port": 9100, "width": "80"},
		{"id": "k2", "label": "Bar", "type": "network", "ip": "192.168.1.51", "port": 9100, "width": "58"},
	}
	prefs := tenantPrefsAfterUpdate(t, fx, map[string]any{
		"printingEnabled":    true,
		"printKitchenTicket": true,
		"printerType":        "network",
		"kitchenPrinters":    kitchen,
	})

	if prefs["printerType"] != "network" {
		t.Fatalf("printerType = %v, want network", prefs["printerType"])
	}
	got, ok := prefs["kitchenPrinters"].([]any)
	if !ok || len(got) != 2 {
		t.Fatalf("kitchenPrinters = %v, want 2 entries", prefs["kitchenPrinters"])
	}
	first := got[0].(map[string]any)
	if first["ip"] != "192.168.1.50" || first["label"] != "Hot Kitchen" {
		t.Fatalf("first kitchen printer = %v", first)
	}

	// A follow-up patch that omits printers must NOT clobber them (jsonb merge).
	prefs = tenantPrefsAfterUpdate(t, fx, map[string]any{"printCustomerReceipt": true})
	if got, ok := prefs["kitchenPrinters"].([]any); !ok || len(got) != 2 {
		t.Fatalf("kitchenPrinters clobbered by unrelated patch: %v", prefs["kitchenPrinters"])
	}
}

func TestUpdateTenant_RejectsBadPrinters(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)

	cases := []struct {
		name    string
		printer map[string]any
	}{
		{"bad type", map[string]any{"id": "x", "type": "usb", "ip": "10.0.0.2", "port": 9100, "width": "80"}},
		{"empty ip", map[string]any{"id": "x", "type": "network", "ip": "", "port": 9100, "width": "80"}},
		{"bad port", map[string]any{"id": "x", "type": "network", "ip": "10.0.0.2", "port": 0, "width": "80"}},
		{"bad width", map[string]any{"id": "x", "type": "network", "ip": "10.0.0.2", "port": 9100, "width": "72"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			callHandler(t, fx, UpdateTenant, "PATCH", "/v1/tenant", map[string]any{
				"preferences": map[string]any{"kitchenPrinters": []map[string]any{tc.printer}},
			}).expectErr(400, "bad_request")
		})
	}

	// printerType must be 'network'.
	callHandler(t, fx, UpdateTenant, "PATCH", "/v1/tenant", map[string]any{
		"preferences": map[string]any{"printerType": "bluetooth"},
	}).expectErr(400, "bad_request")
}
