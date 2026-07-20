package api

// Integration tests for:
//   - audit.go  — ListAuditEvents, ListAuditActors
//   - tenant.go — GetTenant, UpdateTenant, UploadLogo (multipart coverage note below)
//   - kitchen.go — ListKitchenTickets, UpdateKitchenTicket
//
// Multipart upload note: callHandler sets Content-Type: application/json on
// every request and does not support multipart/form-data bodies. UploadLogo
// and UploadMenuImage require r.ParseMultipartForm, so they are NOT exercisable
// through callHandler. The file-missing and bad-content-type paths inside those
// handlers are covered in TestUploadLogo_FileMissing and
// TestUploadLogo_WrongContentType below using httptest directly (outside
// callHandler, so no RLS tx is wired — the handlers bail on multipart errors
// before they touch the DB, which is the interesting code path).
// TestUploadLogo_PNGSuccess wires a manual tx to exercise the happy path.

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// =========================================================================
// audit seed helpers — prefix "aud" to avoid any future collision
// =========================================================================

// audSeedEvent inserts one row into audit_log via the admin pool (RLS
// bypassed) and returns the new row id. Timestamps are explicit so tests
// can exercise date-range and ordering assertions.
func (fx *fixture) audSeedEvent(actorID *uuid.UUID, actorName, actorEmail, action, entity string, entityID *uuid.UUID, summary string, createdAt time.Time) uuid.UUID {
	fx.t.Helper()
	var id uuid.UUID
	fx.adminScan([]any{&id},
		`INSERT INTO audit_log
		   (tenant_id, actor_id, actor_name, actor_email, role_snap,
		    action, entity, entity_id, summary, request_id, created_at)
		 VALUES ($1, $2, $3, $4, '{"owner"}', $5, $6, $7, $8, 'test-req', $9)
		 RETURNING id`,
		fx.Tenant, actorID, actorName, actorEmail,
		action, entity, entityID, summary, createdAt)
	return id
}

// audCountEvents returns the number of audit_log rows for the fixture tenant
// via the admin pool.
func (fx *fixture) audCountEvents() int {
	fx.t.Helper()
	return fx.countRows("audit_log")
}

// =========================================================================
// kitchen seed helpers — prefix "kn" to avoid any future collision
// =========================================================================

// knSeedItemWithStatus inserts an order_item with an explicit kitchen_status.
// It reuses the existing seedOrderItem helper (which inserts with the default
// 'pending') and then updates the status directly.
func (fx *fixture) knSeedItemWithStatus(orderID, menuItemID uuid.UUID, qty int, unitPriceCents int64, kitchenStatus string) uuid.UUID {
	fx.t.Helper()
	itemID := fx.seedOrderItem(orderID, menuItemID, qty, unitPriceCents)
	if kitchenStatus != "pending" {
		fx.adminExec(
			`UPDATE order_items SET kitchen_status = $2::kitchen_status WHERE id = $1`,
			itemID, kitchenStatus)
	}
	return itemID
}

// knItemStatus reads the kitchen_status of an order_item.
func (fx *fixture) knItemStatus(itemID uuid.UUID) string {
	fx.t.Helper()
	var s string
	fx.adminScan([]any{&s},
		`SELECT kitchen_status::text FROM order_items WHERE id = $1`, itemID)
	return s
}

// knSeedReadyOrder is a shortcut: category → item → open order → item in_progress.
func knSeedReadyOrder(fx *fixture) (orderID, itemID uuid.UUID) {
	cat := fx.seedCategory("KN-Cat")
	item := fx.seedMenuItem(cat, "KN-Item", 500)
	orderID = fx.seedOpenOrder(nil)
	itemID = fx.knSeedItemWithStatus(orderID, item, 1, 500, "in_progress")
	return
}

// =========================================================================
// ListAuditEvents
// =========================================================================

func TestListAuditEvents_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 0 {
		t.Fatalf("items = %d, want 0", len(items))
	}
	if r["next_cursor"] != nil {
		t.Fatalf("next_cursor should be nil on empty result, got %v", r["next_cursor"])
	}
}

func TestListAuditEvents_ReturnsRowsNewestFirst(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	e1 := fx.audSeedEvent(nil, "Alice", "alice@test.local", "create", "order", nil, "older", now.Add(-2*time.Minute))
	e2 := fx.audSeedEvent(nil, "Bob", "bob@test.local", "update", "order", nil, "newer", now.Add(-1*time.Minute))

	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2", len(items))
	}

	// newest first
	first := items[0].(map[string]any)
	second := items[1].(map[string]any)
	if first["id"].(string) != e2.String() {
		t.Fatalf("first item id = %s, want %s (newest)", first["id"], e2)
	}
	if second["id"].(string) != e1.String() {
		t.Fatalf("second item id = %s, want %s (older)", second["id"], e1)
	}
}

func TestListAuditEvents_FilterByActor(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	actorA := fx.addUser("ActorA")
	actorB := fx.addUser("ActorB")

	ptrA := &actorA
	ptrB := &actorB
	fx.audSeedEvent(ptrA, "ActorA", "a@test.local", "create", "order", nil, "by A", now.Add(-2*time.Minute))
	fx.audSeedEvent(ptrA, "ActorA", "a@test.local", "delete", "order", nil, "by A 2", now.Add(-1*time.Minute))
	fx.audSeedEvent(ptrB, "ActorB", "b@test.local", "create", "expense", nil, "by B", now)

	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("actor="+actorA.String())).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("actor filter: items = %d, want 2", len(items))
	}
	for _, it := range items {
		m := it.(map[string]any)
		if m["actor_id"] != actorA.String() {
			t.Fatalf("got actor_id %v, want %s", m["actor_id"], actorA)
		}
	}
}

func TestListAuditEvents_FilterByEntity(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "an order", now.Add(-1*time.Minute))
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "expense", nil, "an expense", now)

	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("entity=expense")).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("entity filter: items = %d, want 1", len(items))
	}
	m := items[0].(map[string]any)
	if m["entity"].(string) != "expense" {
		t.Fatalf("entity = %q, want expense", m["entity"])
	}
}

func TestListAuditEvents_FilterByAction(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "c1", now.Add(-2*time.Minute))
	fx.audSeedEvent(nil, "sys", "sys@test.local", "delete", "order", nil, "d1", now.Add(-1*time.Minute))
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "expense", nil, "c2", now)

	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("action=delete")).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("action filter: items = %d, want 1", len(items))
	}
	m := items[0].(map[string]any)
	if m["action"].(string) != "delete" {
		t.Fatalf("action = %q, want delete", m["action"])
	}
}

func TestListAuditEvents_FilterByDateRange(t *testing.T) {
	fx := newTenant(t)
	base := time.Now().UTC().Truncate(time.Second)
	old := base.Add(-10 * time.Minute)
	mid := base.Add(-5 * time.Minute)
	recent := base.Add(-1 * time.Minute)

	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "old", old)
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "mid", mid)
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "recent", recent)

	fromStr := mid.Format(time.RFC3339)
	toStr := mid.Add(time.Second).Format(time.RFC3339)

	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("from="+fromStr+"&to="+toStr)).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("date range filter: items = %d, want 1", len(items))
	}
	m := items[0].(map[string]any)
	if m["summary"].(string) != "mid" {
		t.Fatalf("summary = %q, want mid", m["summary"])
	}
}

func TestListAuditEvents_FilterByQ(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "opened table 5", now.Add(-1*time.Minute))
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "closed shift", now)

	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("q=table")).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("q filter: items = %d, want 1", len(items))
	}
	m := items[0].(map[string]any)
	if m["summary"].(string) != "opened table 5" {
		t.Fatalf("summary = %q, want 'opened table 5'", m["summary"])
	}
}

func TestListAuditEvents_Pagination_LimitAndCursor(t *testing.T) {
	fx := newTenant(t)
	base := time.Now().UTC()
	// Seed 3 events with distinct timestamps (older first).
	for i := 0; i < 3; i++ {
		fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil,
			"event", base.Add(time.Duration(-3+i)*time.Minute))
	}

	// Fetch first page of 2.
	r1 := callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("limit=2")).
		expectStatus(200).json()
	items1, _ := r1["items"].([]any)
	if len(items1) != 2 {
		t.Fatalf("page 1: items = %d, want 2", len(items1))
	}
	cursor, _ := r1["next_cursor"].(string)
	if cursor == "" {
		t.Fatal("expected next_cursor on page 1, got empty")
	}

	// Fetch second page using cursor.
	r2 := callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("limit=2&cursor="+cursor)).
		expectStatus(200).json()
	items2, _ := r2["items"].([]any)
	if len(items2) != 1 {
		t.Fatalf("page 2: items = %d, want 1", len(items2))
	}
	if r2["next_cursor"] != nil {
		t.Fatalf("page 2 should have no next_cursor, got %v", r2["next_cursor"])
	}

	// Verify no overlap between pages.
	id1 := items1[0].(map[string]any)["id"].(string)
	id2 := items1[1].(map[string]any)["id"].(string)
	id3 := items2[0].(map[string]any)["id"].(string)
	ids := map[string]bool{id1: true, id2: true, id3: true}
	if len(ids) != 3 {
		t.Fatalf("duplicate ids across pages: %v, %v, %v", id1, id2, id3)
	}
}

func TestListAuditEvents_LimitCappedAt200(t *testing.T) {
	fx := newTenant(t)
	// Verify limit=999 is accepted without error (cap at 200 enforced internally).
	callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("limit=999")).
		expectStatus(200)
}

func TestListAuditEvents_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	now := time.Now().UTC()

	// Seed one event per tenant.
	fx1.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "tenant1 event", now)
	fx2.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "tenant2 event", now)

	// Querying as fx1 should only see its own event.
	r := callHandler(t, fx1, ListAuditEvents, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("isolation: fx1 sees %d events, want 1", len(items))
	}
	m := items[0].(map[string]any)
	if m["summary"].(string) != "tenant1 event" {
		t.Fatalf("isolation: got summary %q, want 'tenant1 event'", m["summary"])
	}
}

func TestListAuditEvents_MultipleEntityFilters(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "o1", now.Add(-3*time.Minute))
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "expense", nil, "e1", now.Add(-2*time.Minute))
	fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "shift", nil, "s1", now.Add(-1*time.Minute))

	// entity=order&entity=expense — should return 2 rows.
	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil,
		withQuery("entity=order&entity=expense")).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("multi-entity filter: items = %d, want 2", len(items))
	}
}

func TestListAuditEvents_EntityIDPopulated(t *testing.T) {
	fx := newTenant(t)
	entityID := uuid.New()
	now := time.Now().UTC()
	evID := fx.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", &entityID, "with entity_id", now)

	r := callHandler(t, fx, ListAuditEvents, "GET", "/", nil).
		expectStatus(200).json()
	items, _ := r["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	m := items[0].(map[string]any)
	if m["id"].(string) != evID.String() {
		t.Fatalf("id mismatch: got %v want %s", m["id"], evID)
	}
	if m["entity_id"].(string) != entityID.String() {
		t.Fatalf("entity_id = %v, want %s", m["entity_id"], entityID)
	}
}

// =========================================================================
// ListAuditActors
// =========================================================================

func TestListAuditActors_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListAuditActors, "GET", "/", nil).
		expectStatus(200).json()
	actors, _ := r["actors"].([]any)
	if len(actors) != 0 {
		t.Fatalf("actors = %d, want 0", len(actors))
	}
}

func TestListAuditActors_DeduplicatesByEmail(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	actorID := fx.addUser("Dup")
	ptr := &actorID
	// Same actor, two events.
	fx.audSeedEvent(ptr, "Dup", "dup@test.local", "create", "order", nil, "e1", now.Add(-1*time.Minute))
	fx.audSeedEvent(ptr, "Dup", "dup@test.local", "delete", "order", nil, "e2", now)

	r := callHandler(t, fx, ListAuditActors, "GET", "/", nil).
		expectStatus(200).json()
	actors, _ := r["actors"].([]any)
	if len(actors) != 1 {
		t.Fatalf("dedup: actors = %d, want 1", len(actors))
	}
}

func TestListAuditActors_ReturnsMultipleDistinct(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	a := fx.addUser("Alice")
	b := fx.addUser("Bob")
	pA := &a
	pB := &b
	fx.audSeedEvent(pA, "Alice", "alice@test.local", "create", "order", nil, "a1", now.Add(-2*time.Minute))
	fx.audSeedEvent(pB, "Bob", "bob@test.local", "create", "expense", nil, "b1", now.Add(-1*time.Minute))
	// Alice again — should still deduplicate to just Alice + Bob.
	fx.audSeedEvent(pA, "Alice", "alice@test.local", "update", "order", nil, "a2", now)

	r := callHandler(t, fx, ListAuditActors, "GET", "/", nil).
		expectStatus(200).json()
	actors, _ := r["actors"].([]any)
	if len(actors) != 2 {
		t.Fatalf("distinct actors = %d, want 2", len(actors))
	}
}

func TestListAuditActors_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	now := time.Now().UTC()

	a := fx1.addUser("OnlyInTenant1")
	ptr := &a
	fx1.audSeedEvent(ptr, "OnlyInTenant1", "only1@test.local", "create", "order", nil, "x", now)
	fx2.audSeedEvent(nil, "sys", "sys@test.local", "create", "order", nil, "y", now)

	r := callHandler(t, fx1, ListAuditActors, "GET", "/", nil).
		expectStatus(200).json()
	actors, _ := r["actors"].([]any)
	if len(actors) != 1 {
		t.Fatalf("isolation: fx1 actors = %d, want 1", len(actors))
	}
	m := actors[0].(map[string]any)
	if m["actor_email"].(string) != "only1@test.local" {
		t.Fatalf("actor_email = %q, want only1@test.local", m["actor_email"])
	}
}

func TestListAuditActors_FieldsPresent(t *testing.T) {
	fx := newTenant(t)
	now := time.Now().UTC()
	a := fx.addUser("FieldCheck")
	ptr := &a
	fx.audSeedEvent(ptr, "FieldCheck", "fc@test.local", "create", "order", nil, "check", now)

	r := callHandler(t, fx, ListAuditActors, "GET", "/", nil).
		expectStatus(200).json()
	actors, _ := r["actors"].([]any)
	if len(actors) != 1 {
		t.Fatalf("actors = %d, want 1", len(actors))
	}
	m := actors[0].(map[string]any)
	if m["actor_id"] == nil {
		t.Fatal("actor_id should be present")
	}
	if m["actor_name"] == nil {
		t.Fatal("actor_name should be present")
	}
	if m["actor_email"] == nil {
		t.Fatal("actor_email should be present")
	}
}

// =========================================================================
// GetTenant
// =========================================================================

func TestGetTenant_ReturnsOwnTenant(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200)
	var ten Tenant
	r.decode(&ten)
	if ten.ID != fx.Tenant {
		t.Fatalf("id = %s, want %s", ten.ID, fx.Tenant)
	}
	if ten.Slug != fx.Slug {
		t.Fatalf("slug = %q, want %q", ten.Slug, fx.Slug)
	}
	if ten.Name != fx.Name {
		t.Fatalf("name = %q, want %q", ten.Name, fx.Name)
	}
}

func TestGetTenant_AllFieldsPresent(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).json()

	for _, field := range []string{"id", "slug", "name", "plan", "status", "timezone",
		"vat_pct", "service_charge_pct", "created_at"} {
		if r[field] == nil {
			t.Errorf("field %q is nil in response", field)
		}
	}
	// branding and preferences should always be present (empty objects or nil is ok).
	if _, ok := r["branding"]; !ok {
		t.Error("field 'branding' missing from response")
	}
	if _, ok := r["preferences"]; !ok {
		t.Error("field 'preferences' missing from response")
	}
}

func TestGetTenant_DefaultRates(t *testing.T) {
	fx := newTenant(t)
	var ten Tenant
	callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).decode(&ten)
	// Defaults set by the DB: vat 13, service 0.
	if ten.VatPct != "13.00" {
		t.Fatalf("vat_pct = %q, want 13.00", ten.VatPct)
	}
	if ten.ServiceChargePct != "0.00" {
		t.Fatalf("service_charge_pct = %q, want 0.00", ten.ServiceChargePct)
	}
}

func TestGetTenant_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)

	// fx1 should not see fx2's name.
	var ten Tenant
	callHandler(t, fx1, GetTenant, "GET", "/", nil).
		expectStatus(200).decode(&ten)
	if ten.ID == fx2.Tenant {
		t.Fatal("GetTenant returned the wrong tenant")
	}
	if ten.Name == fx2.Name {
		t.Fatalf("GetTenant returned fx2's name %q from fx1's context", ten.Name)
	}
}

// =========================================================================
// UpdateTenant
// =========================================================================

func TestUpdateTenant_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateTenant, "PATCH", "/", "{not json").
		expectErr(400, "bad_request")
}

func TestUpdateTenant_UpdateName(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, UpdateTenant, "PATCH", "/",
		map[string]any{"name": "New Cafe Name"}).
		expectStatus(200)
	var ten Tenant
	r.decode(&ten)
	if ten.Name != "New Cafe Name" {
		t.Fatalf("name = %q, want 'New Cafe Name'", ten.Name)
	}
	// Verify persisted.
	var persisted Tenant
	callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).decode(&persisted)
	if persisted.Name != "New Cafe Name" {
		t.Fatalf("persisted name = %q, want 'New Cafe Name'", persisted.Name)
	}
}

func TestUpdateTenant_UpdateTimezone(t *testing.T) {
	fx := newTenant(t)
	var ten Tenant
	callHandler(t, fx, UpdateTenant, "PATCH", "/",
		map[string]any{"timezone": "UTC"}).
		expectStatus(200).decode(&ten)
	if ten.Timezone != "UTC" {
		t.Fatalf("timezone = %q, want UTC", ten.Timezone)
	}
}

func TestUpdateTenant_UpdateVatPct(t *testing.T) {
	fx := newTenant(t)
	var ten Tenant
	callHandler(t, fx, UpdateTenant, "PATCH", "/",
		map[string]any{"vat_pct": "5"}).
		expectStatus(200).decode(&ten)
	if ten.VatPct != "5.00" {
		t.Fatalf("vat_pct = %q, want 5.00", ten.VatPct)
	}
}

func TestUpdateTenant_UpdateServiceChargePct(t *testing.T) {
	fx := newTenant(t)
	var ten Tenant
	callHandler(t, fx, UpdateTenant, "PATCH", "/",
		map[string]any{"service_charge_pct": "10"}).
		expectStatus(200).decode(&ten)
	if ten.ServiceChargePct != "10.00" {
		t.Fatalf("service_charge_pct = %q, want 10.00", ten.ServiceChargePct)
	}
}

func TestUpdateTenant_UpdateBranding(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"branding": map[string]any{
			"brandPrimary": "#FF0000",
			"cafeName":     "My Cafe",
		},
	}).expectStatus(200)

	// GetTenant should show the merged branding.
	m := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).json()
	br, _ := m["branding"].(map[string]any)
	if br == nil {
		t.Fatal("branding field is nil")
	}
	if br["brandPrimary"].(string) != "#FF0000" {
		t.Fatalf("brandPrimary = %q, want #FF0000", br["brandPrimary"])
	}
	if br["cafeName"].(string) != "My Cafe" {
		t.Fatalf("cafeName = %q, want 'My Cafe'", br["cafeName"])
	}
}

func TestUpdateTenant_BrandingMergeDoesNotClobberExistingKeys(t *testing.T) {
	fx := newTenant(t)
	// Set initial branding with two keys.
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"branding": map[string]any{
			"brandPrimary": "#000000",
			"tagline":      "Great Coffee",
		},
	}).expectStatus(200)

	// Update only brandPrimary — tagline should survive.
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"branding": map[string]any{"brandPrimary": "#FFFFFF"},
	}).expectStatus(200)

	m := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).json()
	br, _ := m["branding"].(map[string]any)
	if br["brandPrimary"].(string) != "#FFFFFF" {
		t.Fatalf("brandPrimary = %q, want #FFFFFF", br["brandPrimary"])
	}
	if br["tagline"].(string) != "Great Coffee" {
		t.Fatalf("tagline = %q, want 'Great Coffee' (should not be clobbered)", br["tagline"])
	}
}

func TestUpdateTenant_UpdatePreferences(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{
			"autoServeOnReady": true,
			"autoCleanTables":  false,
		},
	}).expectStatus(200)

	m := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).json()
	prefs, _ := m["preferences"].(map[string]any)
	if prefs == nil {
		t.Fatal("preferences field is nil")
	}
	if prefs["autoServeOnReady"].(bool) != true {
		t.Fatalf("autoServeOnReady = %v, want true", prefs["autoServeOnReady"])
	}
	if prefs["autoCleanTables"].(bool) != false {
		t.Fatalf("autoCleanTables = %v, want false", prefs["autoCleanTables"])
	}
}

func TestUpdateTenant_ReceiptImageLabelRoundTrip(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{
			"receiptImageUrl":   "https://cdn.example/qr.png",
			"receiptImageLabel": "Use this QR to pay",
		},
	}).expectStatus(200)

	m := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).json()
	prefs, _ := m["preferences"].(map[string]any)
	if prefs["receiptImageLabel"] != "Use this QR to pay" {
		t.Fatalf("receiptImageLabel = %v, want 'Use this QR to pay'", prefs["receiptImageLabel"])
	}
	if prefs["receiptImageUrl"] != "https://cdn.example/qr.png" {
		t.Fatalf("receiptImageUrl = %v", prefs["receiptImageUrl"])
	}
}

func TestUpdateTenant_ReceiptImageLabelTooLong(t *testing.T) {
	fx := newTenant(t)
	long := make([]byte, 81)
	for i := range long {
		long[i] = 'x'
	}
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{"receiptImageLabel": string(long)},
	}).expectErr(400, "bad_request")
}

func TestUpdateTenant_PreferencesMergeDoesNotClobber(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{
			"combinedSettle": true,
			"stackItems":     true,
		},
	}).expectStatus(200)

	// Update only stackItems — combinedSettle must survive.
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{"stackItems": false},
	}).expectStatus(200)

	m := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).json()
	prefs, _ := m["preferences"].(map[string]any)
	if prefs["combinedSettle"].(bool) != true {
		t.Fatalf("combinedSettle = %v, should still be true", prefs["combinedSettle"])
	}
	if prefs["stackItems"].(bool) != false {
		t.Fatalf("stackItems = %v, want false after update", prefs["stackItems"])
	}
}

func TestUpdateTenant_OpeningHoursRoundTrip(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{
			"openingHours": map[string]any{
				"1": map[string]any{"start": "08:00", "end": "20:00"},
				"6": map[string]any{"start": "10:00", "end": "23:00"},
			},
			"comfortCoverage": 3,
		},
	}).expectStatus(200)

	m := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).json()
	prefs, _ := m["preferences"].(map[string]any)
	if prefs == nil {
		t.Fatal("preferences field is nil")
	}
	oh, _ := prefs["openingHours"].(map[string]any)
	if oh == nil {
		t.Fatal("openingHours missing from preferences")
	}
	mon, _ := oh["1"].(map[string]any)
	if mon == nil || mon["start"].(string) != "08:00" || mon["end"].(string) != "20:00" {
		t.Fatalf("Monday opening hours = %v, want 08:00–20:00", oh["1"])
	}
	// JSON numbers decode to float64.
	if prefs["comfortCoverage"].(float64) != 3 {
		t.Fatalf("comfortCoverage = %v, want 3", prefs["comfortCoverage"])
	}
}

func TestUpdateTenant_OpeningHoursRejectsBadTimes(t *testing.T) {
	fx := newTenant(t)
	// end before start
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{
			"openingHours": map[string]any{"1": map[string]any{"start": "18:00", "end": "09:00"}},
		},
	}).expectErr(400, "bad_request")

	// malformed time
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{
			"openingHours": map[string]any{"2": map[string]any{"start": "8am", "end": "20:00"}},
		},
	}).expectErr(400, "bad_request")

	// invalid day key
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{
		"preferences": map[string]any{
			"openingHours": map[string]any{"9": map[string]any{"start": "08:00", "end": "20:00"}},
		},
	}).expectErr(400, "bad_request")
}

func TestUpdateTenant_NoFieldsIsNoOp(t *testing.T) {
	fx := newTenant(t)
	var before, after Tenant
	callHandler(t, fx, GetTenant, "GET", "/", nil).decode(&before)
	callHandler(t, fx, UpdateTenant, "PATCH", "/", map[string]any{}).
		expectStatus(200).decode(&after)
	if after.Name != before.Name {
		t.Fatalf("name changed on no-op update: %q → %q", before.Name, after.Name)
	}
	if after.Timezone != before.Timezone {
		t.Fatalf("timezone changed on no-op update")
	}
}

func TestUpdateTenant_WritesAuditLogEntry(t *testing.T) {
	fx := newTenant(t)
	before := fx.audCountEvents()
	callHandler(t, fx, UpdateTenant, "PATCH", "/",
		map[string]any{"name": "Audited Cafe"}).
		expectStatus(200)
	after := fx.audCountEvents()
	if after != before+1 {
		t.Fatalf("audit_log rows: before=%d after=%d, want +1", before, after)
	}
}

// =========================================================================
// UploadLogo — multipart tests outside callHandler
//
// These tests exercise the handler's validation branches (missing file field,
// wrong content-type) which all abort before touching the DB. We build a
// minimal HTTP context (RLS context injected manually) so the handler can
// read the tenant from context, then fail on the multipart checks.
// =========================================================================

// audBuildLogoRequest creates a multipart request for UploadLogo. If fieldName
// is empty, the "file" field is omitted so the handler returns bad_request.
func audBuildLogoRequest(t *testing.T, tenantID uuid.UUID, slug string, fieldName, contentType string, body []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if fieldName != "" {
		h := make(textproto.MIMEHeader)
		h.Set("Content-Disposition", `form-data; name="`+fieldName+`"; filename="logo.bin"`)
		h.Set("Content-Type", contentType)
		part, _ := mw.CreatePart(h)
		_, _ = part.Write(body)
	}
	_ = mw.Close()

	req := httptest.NewRequest("POST", "/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	ctx := appctx.WithTenant(req.Context(), appctx.Tenant{
		ID: tenantID, Slug: slug, Name: "Test",
	})
	req = req.WithContext(ctx)
	return req
}

// audErrKind extracts the "code" field from a JSON response body.
func audErrKind(b []byte) string {
	var env struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(b, &env)
	return env.Code
}

func TestUploadLogo_FileMissing(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store, err := storage.NewLocal(t.TempDir(), "/uploads")
	if err != nil {
		t.Fatal(err)
	}
	req := audBuildLogoRequest(t, fx.Tenant, fx.Slug, "", "image/png", []byte{})
	rec := httptest.NewRecorder()
	UploadLogo(store).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if got := audErrKind(rec.Body.Bytes()); got != "bad_request" {
		t.Fatalf("code = %q, want bad_request", got)
	}
}

func TestUploadLogo_WrongContentType(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store, err := storage.NewLocal(t.TempDir(), "/uploads")
	if err != nil {
		t.Fatal(err)
	}
	// Send a PDF (not allowed).
	req := audBuildLogoRequest(t, fx.Tenant, fx.Slug, "file", "application/pdf", []byte("fake pdf data"))
	rec := httptest.NewRecorder()
	UploadLogo(store).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", rec.Code)
	}
	if got := audErrKind(rec.Body.Bytes()); got != "bad_type" {
		t.Fatalf("code = %q, want bad_type", got)
	}
}

func TestUploadLogo_PNGSuccess(t *testing.T) {
	requireDB(t)
	fx := newTenant(t)
	store, err := storage.NewLocal(t.TempDir(), "/uploads")
	if err != nil {
		t.Fatal(err)
	}

	// Minimal 1×1 PNG (valid PNG magic bytes trigger image/png detection).
	pngBytes := []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG sig
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR len + type
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1×1
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
		0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
		0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
		0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
		0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
		0x44, 0xae, 0x42, 0x60, 0x82,
	}

	// Wire an app-pool tx manually (mirrors callHandler's behaviour) so the
	// UPDATE tenants SET branding = ... inside UploadLogo actually commits.
	bg := context.Background()
	tx, err := appPool.BeginTx(bg, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(bg)
		}
	}()
	if _, err := tx.Exec(bg, "SELECT set_config('app.tenant_id', $1, true)", fx.Tenant.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(bg, "SELECT set_config('app.user_id', $1, true)", fx.User.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}

	req := audBuildLogoRequest(t, fx.Tenant, fx.Slug, "file", "image/png", pngBytes)
	ctx := appctx.WithTenant(req.Context(), appctx.Tenant{ID: fx.Tenant, Slug: fx.Slug, Name: fx.Name})
	ctx = appctx.WithUser(ctx, appctx.User{ID: fx.User})
	ctx = appctx.WithRoles(ctx, fx.Roles)
	ctx = appctx.WithTx(ctx, tx)
	ctx = appctx.WithPostCommit(ctx)
	ctx = appctx.WithRequestID(ctx, "test-req")
	ctx = appctx.WithIP(ctx, "127.0.0.1")
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	UploadLogo(store).ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["logo_url"] == nil {
		t.Fatal("logo_url missing from response")
	}

	if err := tx.Commit(bg); err != nil {
		t.Fatalf("commit: %v", err)
	}
	committed = true

	// Verify branding was persisted.
	m := callHandler(t, fx, GetTenant, "GET", "/", nil).
		expectStatus(200).json()
	br, _ := m["branding"].(map[string]any)
	if br == nil || br["logoUrl"] == nil {
		t.Fatal("logoUrl not persisted in branding")
	}
}

// =========================================================================
// ListKitchenTickets
// =========================================================================

func TestListKitchenTickets_Empty(t *testing.T) {
	fx := newTenant(t)
	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 0 {
		t.Fatalf("tickets = %d, want 0", len(tickets))
	}
}

func TestListKitchenTickets_PendingItemsNotIncluded(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	// Default status is 'pending' — should not appear in KDS list.
	fx.seedOrderItem(order, item, 1, 500)

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 0 {
		t.Fatalf("pending ticket visible: tickets = %d, want 0", len(tickets))
	}
}

func TestListKitchenTickets_ServedItemsNotIncluded(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	fx.knSeedItemWithStatus(order, item, 1, 500, "served")

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 0 {
		t.Fatalf("served ticket visible: tickets = %d, want 0", len(tickets))
	}
}

func TestListKitchenTickets_InProgressItemIncluded(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	itemID := fx.knSeedItemWithStatus(order, item, 1, 500, "in_progress")

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 1 {
		t.Fatalf("tickets = %d, want 1", len(tickets))
	}
	m := tickets[0].(map[string]any)
	if m["item_id"].(string) != itemID.String() {
		t.Fatalf("item_id = %s, want %s", m["item_id"], itemID)
	}
	if m["kitchen_status"].(string) != "in_progress" {
		t.Fatalf("kitchen_status = %q, want in_progress", m["kitchen_status"])
	}
}

func TestListKitchenTickets_ReadyItemIncluded(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	itemID := fx.knSeedItemWithStatus(order, item, 1, 500, "ready")

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 1 {
		t.Fatalf("tickets = %d, want 1", len(tickets))
	}
	m := tickets[0].(map[string]any)
	if m["item_id"].(string) != itemID.String() {
		t.Fatalf("item_id mismatch")
	}
	if m["kitchen_status"].(string) != "ready" {
		t.Fatalf("kitchen_status = %q, want ready", m["kitchen_status"])
	}
}

func TestListKitchenTickets_VoidedItemsNotIncluded(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	itemID := fx.knSeedItemWithStatus(order, item, 1, 500, "in_progress")
	// Void the item.
	fx.adminExec(`UPDATE order_items SET voided_at = now() WHERE id = $1`, itemID)

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 0 {
		t.Fatalf("voided item visible: tickets = %d, want 0", len(tickets))
	}
}

func TestListKitchenTickets_ClosedOrderItemsNotIncluded(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	fx.knSeedItemWithStatus(order, item, 1, 500, "in_progress")
	// Close the order.
	fx.setOrderStatus(order, "closed")

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 0 {
		t.Fatalf("closed-order item visible: tickets = %d, want 0", len(tickets))
	}
}

func TestListKitchenTickets_OrderedByOldestFirst(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	o1 := fx.seedOpenOrder(nil)
	o2 := fx.seedOpenOrder(nil)
	now := time.Now().UTC()

	// Item on o1 was sent to kitchen earlier.
	i1 := fx.knSeedItemWithStatus(o1, item, 1, 500, "in_progress")
	i2 := fx.knSeedItemWithStatus(o2, item, 1, 500, "in_progress")
	fx.adminExec(`UPDATE order_items SET sent_to_kitchen_at = $2 WHERE id = $1`, i1, now.Add(-5*time.Minute))
	fx.adminExec(`UPDATE order_items SET sent_to_kitchen_at = $2 WHERE id = $1`, i2, now.Add(-1*time.Minute))

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 2 {
		t.Fatalf("tickets = %d, want 2", len(tickets))
	}
	// Oldest first.
	if tickets[0].(map[string]any)["item_id"].(string) != i1.String() {
		t.Fatalf("first ticket = %v, want %s (oldest)", tickets[0].(map[string]any)["item_id"], i1)
	}
	if tickets[1].(map[string]any)["item_id"].(string) != i2.String() {
		t.Fatalf("second ticket = %v, want %s (newer)", tickets[1].(map[string]any)["item_id"], i2)
	}
}

func TestListKitchenTickets_FieldsPresent(t *testing.T) {
	fx := newTenant(t)
	table := fx.seedTable("T1")
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "KDS Item", 750)
	order := fx.seedOpenOrder(ptrUUID(table))
	fx.knSeedItemWithStatus(order, item, 2, 750, "in_progress")

	r := callHandler(t, fx, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 1 {
		t.Fatalf("tickets = %d, want 1", len(tickets))
	}
	m := tickets[0].(map[string]any)
	for _, field := range []string{"item_id", "order_id", "menu_item_name", "qty", "kitchen_status"} {
		if m[field] == nil {
			t.Errorf("field %q missing from ticket", field)
		}
	}
	if m["service_table_name"] == nil {
		t.Error("service_table_name should be present when order has a table")
	}
	if int(m["qty"].(float64)) != 2 {
		t.Fatalf("qty = %v, want 2", m["qty"])
	}
}

func TestListKitchenTickets_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)

	cat := fx2.seedCategory("Cat")
	item := fx2.seedMenuItem(cat, "FX2 Item", 500)
	order := fx2.seedOpenOrder(nil)
	fx2.knSeedItemWithStatus(order, item, 1, 500, "in_progress")

	// fx1 should see no tickets even though fx2 has one.
	r := callHandler(t, fx1, ListKitchenTickets, "GET", "/", nil).
		expectStatus(200).json()
	tickets, _ := r["tickets"].([]any)
	if len(tickets) != 0 {
		t.Fatalf("isolation: fx1 sees %d tickets from fx2, want 0", len(tickets))
	}
}

// =========================================================================
// UpdateKitchenTicket
// =========================================================================

func TestUpdateKitchenTicket_BadItemID(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", "not-a-uuid")).
		expectErr(400, "bad_request")
}

func TestUpdateKitchenTicket_BadJSON(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/", "{bad",
		withParam("itemId", uuid.NewString())).
		expectErr(400, "bad_request")
}

func TestUpdateKitchenTicket_BadStatusPending(t *testing.T) {
	fx := newTenant(t)
	// "pending" is an invalid target status for this endpoint.
	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "pending"},
		withParam("itemId", uuid.NewString())).
		expectErr(400, "bad_request")
}

func TestUpdateKitchenTicket_BadStatusGibberish(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "burnt"},
		withParam("itemId", uuid.NewString())).
		expectErr(400, "bad_request")
}

func TestUpdateKitchenTicket_ItemNotFound(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", uuid.NewString())).
		expectErr(404, "not_found")
}

func TestUpdateKitchenTicket_VoidedItemIsNotFound(t *testing.T) {
	fx := newTenant(t)
	_, itemID := knSeedReadyOrder(fx)
	fx.adminExec(`UPDATE order_items SET voided_at = now() WHERE id = $1`, itemID)

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", itemID.String())).
		expectErr(404, "not_found")
}

func TestUpdateKitchenTicket_InvalidTransition_PendingToReady(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	// Default status is 'pending'.
	itemID := fx.seedOrderItem(order, item, 1, 500)

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", itemID.String())).
		expectErr(409, "invalid_transition")
}

func TestUpdateKitchenTicket_InvalidTransition_ReadyToInProgress(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	itemID := fx.knSeedItemWithStatus(order, item, 1, 500, "ready")

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "in_progress"},
		withParam("itemId", itemID.String())).
		expectErr(409, "invalid_transition")
}

func TestUpdateKitchenTicket_InvalidTransition_ServedToReady(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	itemID := fx.knSeedItemWithStatus(order, item, 1, 500, "served")

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", itemID.String())).
		expectErr(409, "invalid_transition")
}

func TestUpdateKitchenTicket_InProgressToReady(t *testing.T) {
	fx := newTenant(t)
	_, itemID := knSeedReadyOrder(fx) // starts as in_progress

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", itemID.String())).
		expectStatus(204)

	if got := fx.knItemStatus(itemID); got != "ready" {
		t.Fatalf("kitchen_status = %q, want ready", got)
	}
}

func TestUpdateKitchenTicket_ReadyToServed(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	itemID := fx.knSeedItemWithStatus(order, item, 1, 500, "ready")

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "served"},
		withParam("itemId", itemID.String())).
		expectStatus(204)

	if got := fx.knItemStatus(itemID); got != "served" {
		t.Fatalf("kitchen_status = %q, want served", got)
	}
}

func TestUpdateKitchenTicket_IdempotentSameState(t *testing.T) {
	fx := newTenant(t)
	_, itemID := knSeedReadyOrder(fx) // in_progress

	// Sending in_progress again is idempotent — 204, no transition error.
	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "in_progress"},
		withParam("itemId", itemID.String())).
		expectStatus(204)

	if got := fx.knItemStatus(itemID); got != "in_progress" {
		t.Fatalf("kitchen_status = %q, want in_progress after idempotent update", got)
	}
}

func TestUpdateKitchenTicket_StampsReadyAt(t *testing.T) {
	fx := newTenant(t)
	_, itemID := knSeedReadyOrder(fx)

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", itemID.String())).
		expectStatus(204)

	var readyAt *time.Time
	fx.adminScan([]any{&readyAt},
		`SELECT ready_at FROM order_items WHERE id = $1`, itemID)
	if readyAt == nil {
		t.Fatal("ready_at should be stamped after in_progress → ready transition")
	}
}

func TestUpdateKitchenTicket_StampsServedAt(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Cat")
	item := fx.seedMenuItem(cat, "Item", 500)
	order := fx.seedOpenOrder(nil)
	itemID := fx.knSeedItemWithStatus(order, item, 1, 500, "ready")

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "served"},
		withParam("itemId", itemID.String())).
		expectStatus(204)

	var servedAt *time.Time
	fx.adminScan([]any{&servedAt},
		`SELECT served_at FROM order_items WHERE id = $1`, itemID)
	if servedAt == nil {
		t.Fatal("served_at should be stamped after ready → served transition")
	}
}

func TestUpdateKitchenTicket_AutoServeOnReady(t *testing.T) {
	fx := newTenant(t)
	fx.setTenantPref("autoServeOnReady", true)
	_, itemID := knSeedReadyOrder(fx)

	// Marking "ready" with auto-serve ON should collapse to "served".
	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", itemID.String())).
		expectStatus(204)

	if got := fx.knItemStatus(itemID); got != "served" {
		t.Fatalf("kitchen_status = %q, want served (auto-serve collapsed ready→served)", got)
	}

	// Both ready_at and served_at should be stamped.
	var readyAt, servedAt *time.Time
	fx.adminScan([]any{&readyAt, &servedAt},
		`SELECT ready_at, served_at FROM order_items WHERE id = $1`, itemID)
	if readyAt == nil {
		t.Fatal("ready_at should be stamped even when auto-serve collapses to served")
	}
	if servedAt == nil {
		t.Fatal("served_at should be stamped when auto-serve collapses to served")
	}
}

func TestUpdateKitchenTicket_AutoServeOff_StaysReady(t *testing.T) {
	fx := newTenant(t)
	// Explicitly disable auto-serve (default is false, but be explicit).
	fx.setTenantPref("autoServeOnReady", false)
	_, itemID := knSeedReadyOrder(fx)

	callHandler(t, fx, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", itemID.String())).
		expectStatus(204)

	if got := fx.knItemStatus(itemID); got != "ready" {
		t.Fatalf("kitchen_status = %q, want ready when auto-serve is off", got)
	}
}

func TestUpdateKitchenTicket_TenantIsolation(t *testing.T) {
	fx1 := newTenant(t)
	fx2 := newTenant(t)
	cat := fx2.seedCategory("Cat")
	item := fx2.seedMenuItem(cat, "Item", 500)
	order := fx2.seedOpenOrder(nil)
	itemID := fx2.knSeedItemWithStatus(order, item, 1, 500, "in_progress")

	// fx1 should not be able to update fx2's item — should 404 due to RLS.
	callHandler(t, fx1, UpdateKitchenTicket(testHub()), "PATCH", "/",
		map[string]any{"kitchen_status": "ready"},
		withParam("itemId", itemID.String())).
		expectErr(404, "not_found")

	// Item remains unchanged in fx2.
	if got := fx2.knItemStatus(itemID); got != "in_progress" {
		t.Fatalf("isolation: fx2 item status = %q after fx1 attempted update", got)
	}
}
