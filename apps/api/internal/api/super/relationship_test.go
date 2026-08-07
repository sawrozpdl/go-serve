package super

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// Relationship attribution + CRM notes (0057)
// =========================================================================

// relRow reads a tenant's relationship columns.
func (sf *superFixture) relRow(id uuid.UUID) (onboarder, rm *uuid.UUID, source, ownerName string) {
	sf.t.Helper()
	sf.adminScan([]any{&onboarder, &rm, &source, &ownerName},
		`SELECT onboarded_by_person_id, relationship_manager_id, acquisition_source, owner_name
		 FROM tenants WHERE id = $1`, id)
	return
}

func setRelationship(t *testing.T, sf *superFixture, tenantID uuid.UUID, body map[string]any) *superResp {
	t.Helper()
	return callSuper(t, sf, SetTenantRelationship, http.MethodPatch,
		"/v1/super/tenants/"+tenantID.String()+"/relationship", body,
		superParam("id", tenantID.String()))
}

// The core convenience: naming only an onboarder makes them the RM too.
func TestSetRelationship_RMDefaultsToOnboarder(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Defaulting Cafe")
	person := sf.seedPerson("Solo Operator", "agent")

	setRelationship(t, sf, tenantID, map[string]any{
		"onboarded_by_person_id": person.String(),
		"acquisition_source":     "walk_in",
	}).expectStatus(http.StatusOK)

	onboarder, rm, source, _ := sf.relRow(tenantID)
	if onboarder == nil || *onboarder != person {
		t.Fatalf("onboarded_by = %v, want %v", onboarder, person)
	}
	if rm == nil || *rm != person {
		t.Errorf("relationship_manager = %v, want it defaulted to the onboarder %v", rm, person)
	}
	if source != "walk_in" {
		t.Errorf("acquisition_source = %q, want walk_in", source)
	}
}

// …and the two can then diverge. This is the reason RM is a stored column
// rather than a COALESCE on read: a handover has to stick.
func TestSetRelationship_CanDivergeFromOnboarder(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Handover Cafe")
	scout := sf.seedPerson("Scout", "agent")
	keeper := sf.seedPerson("Keeper", "admin")

	setRelationship(t, sf, tenantID, map[string]any{
		"onboarded_by_person_id": scout.String(),
	}).expectStatus(http.StatusOK)

	setRelationship(t, sf, tenantID, map[string]any{
		"onboarded_by_person_id":  scout.String(),
		"relationship_manager_id": keeper.String(),
		"rm_provided":             true,
	}).expectStatus(http.StatusOK)

	onboarder, rm, _, _ := sf.relRow(tenantID)
	if onboarder == nil || *onboarder != scout {
		t.Errorf("onboarder should stay %v, got %v", scout, onboarder)
	}
	if rm == nil || *rm != keeper {
		t.Errorf("RM should be reassigned to %v, got %v", keeper, rm)
	}
}

// rm_provided=true with a null id means "explicitly unassigned" — it must NOT
// silently fall back to the onboarder.
func TestSetRelationship_ExplicitNullRMClears(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Unassigned Cafe")
	scout := sf.seedPerson("Scout Only", "agent")

	setRelationship(t, sf, tenantID, map[string]any{
		"onboarded_by_person_id":  scout.String(),
		"relationship_manager_id": nil,
		"rm_provided":             true,
	}).expectStatus(http.StatusOK)

	onboarder, rm, _, _ := sf.relRow(tenantID)
	if onboarder == nil {
		t.Fatal("onboarder should be set")
	}
	if rm != nil {
		t.Errorf("RM should be explicitly cleared, got %v", rm)
	}
}

func TestSetRelationship_UnknownPersonIs400(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Bad Person Cafe")
	setRelationship(t, sf, tenantID, map[string]any{
		"onboarded_by_person_id": uuid.New().String(),
	}).expectErr(http.StatusBadRequest, "unknown_person")
}

func TestSetRelationship_UnknownSourceIs400(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Bad Source Cafe")
	setRelationship(t, sf, tenantID, map[string]any{"acquisition_source": "telepathy"}).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestSetRelationship_MissingTenantIs404(t *testing.T) {
	sf := newSuperFixture(t)
	missing := uuid.New()
	setRelationship(t, sf, missing, map[string]any{"owner_name": "Nobody"}).
		expectErr(http.StatusNotFound, "not_found")
}

// onboarded_on uses COALESCE, so omitting it must not wipe an existing date.
func TestSetRelationship_OmittedDateKeepsExisting(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Dated Cafe")
	sf.adminExec(`UPDATE tenants SET onboarded_on = DATE '2026-01-15' WHERE id = $1`, tenantID)

	setRelationship(t, sf, tenantID, map[string]any{"owner_name": "Ram"}).expectStatus(http.StatusOK)

	var kept bool
	sf.adminScan([]any{&kept}, `SELECT onboarded_on = DATE '2026-01-15' FROM tenants WHERE id = $1`, tenantID)
	if !kept {
		t.Error("omitting onboarded_on must not clear the stored date")
	}
}

func TestSetRelationship_BadDateIs400(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Bad Date Cafe")
	setRelationship(t, sf, tenantID, map[string]any{"onboarded_on": "15/01/2026"}).
		expectErr(http.StatusBadRequest, "bad_request")
}

// --- provisioning attribution -------------------------------------------

// Provisioning through the console attributes the cafe to the acting admin's
// registry row without anyone having to pick it.
func TestCreateTenant_AttributesToActingAdmin(t *testing.T) {
	sf := newSuperFixture(t)
	// Give the acting admin a registry row linked to their user.
	var personID uuid.UUID
	if err := adminPool.QueryRow(context.Background(),
		`INSERT INTO platform_people (name, kind, user_id) VALUES ('Acting Admin', 'admin', $1) RETURNING id`,
		sf.AdminUser).Scan(&personID); err != nil {
		t.Fatalf("seed acting person: %v", err)
	}
	t.Cleanup(func() { cleanupPerson(personID) })

	var out struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost, "/v1/super/tenants", map[string]any{
		"name": "Attributed Cafe", "owner_email": "owner@attributed.test",
		"owner_name": "Sita Rai", "phone": "+977 9800000000",
	}).expectStatus(http.StatusCreated).decode(&out)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, out.ID)
	})

	onboarder, rm, source, ownerName := sf.relRow(out.ID)
	if onboarder == nil || *onboarder != personID {
		t.Errorf("onboarded_by = %v, want the acting admin's person %v", onboarder, personID)
	}
	if rm == nil || *rm != personID {
		t.Errorf("relationship_manager = %v, want it seeded to the onboarder", rm)
	}
	if source != "direct" {
		t.Errorf("acquisition_source = %q, want direct", source)
	}
	// owner_email in the summaries view needs an ACCEPTED invite, so without
	// owner_name a freshly provisioned cafe shows no human at all.
	if ownerName != "Sita Rai" {
		t.Errorf("owner_name = %q, want the name supplied at provision time", ownerName)
	}
	var onboardedToday bool
	sf.adminScan([]any{&onboardedToday},
		`SELECT onboarded_on = CURRENT_DATE FROM tenants WHERE id = $1`, out.ID)
	if !onboardedToday {
		t.Error("onboarded_on should default to today at provision time")
	}
}

// An explicit onboarder wins — that's how a cafe an outside agent signed up
// gets recorded correctly.
func TestCreateTenant_ExplicitOnboarderWins(t *testing.T) {
	sf := newSuperFixture(t)
	agent := sf.seedPerson("Field Agent", "agent")

	var out struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost, "/v1/super/tenants", map[string]any{
		"name": "Agent Signed Cafe", "owner_email": "owner@agentsigned.test",
		"phone": "+977 9811111111", "onboarded_by_person_id": agent.String(),
		"acquisition_source": "referral",
	}).expectStatus(http.StatusCreated).decode(&out)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, out.ID)
	})

	onboarder, rm, source, _ := sf.relRow(out.ID)
	if onboarder == nil || *onboarder != agent {
		t.Errorf("onboarded_by = %v, want the named agent %v", onboarder, agent)
	}
	if rm == nil || *rm != agent {
		t.Errorf("RM = %v, want it seeded to the named agent", rm)
	}
	if source != "referral" {
		t.Errorf("acquisition_source = %q, want referral", source)
	}
}

func TestCreateTenant_UnknownOnboarderIs400(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateTenant(sf.rbacRepo), http.MethodPost, "/v1/super/tenants", map[string]any{
		"name": "Ghost Onboarder", "owner_email": "o@ghost.test", "phone": "+977 98",
		"onboarded_by_person_id": uuid.New().String(),
	}).expectErr(http.StatusBadRequest, "unknown_person")
}

// Converting a lead must leave a two-way link and carry the source across —
// the form captured both and nothing used to copy them onto the tenant.
func TestConvertLead_LinksBackToLead(t *testing.T) {
	sf := newSuperFixture(t)
	leadID := sf.seedLead("Lead Cafe", "lead-"+uuid.NewString()[:8]+"@example.test")

	var out struct {
		TenantID uuid.UUID `json:"tenant_id"`
	}
	callSuper(t, sf, ConvertLead(sf.rbacRepo), http.MethodPost,
		"/v1/super/leads/"+leadID.String()+"/convert", map[string]any{},
		superParam("id", leadID.String())).
		expectStatus(http.StatusOK).decode(&out)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, out.TenantID)
	})

	var sourceLead *uuid.UUID
	var source string
	sf.adminScan([]any{&sourceLead, &source},
		`SELECT source_lead_id, acquisition_source FROM tenants WHERE id = $1`, out.TenantID)
	if sourceLead == nil || *sourceLead != leadID {
		t.Errorf("source_lead_id = %v, want the originating lead %v", sourceLead, leadID)
	}
	if source != "request_access" {
		t.Errorf("acquisition_source = %q, want request_access", source)
	}
}

// --- notes ---------------------------------------------------------------

func TestTenantNotes_AddListPinDelete(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Noted Cafe")
	base := "/v1/super/tenants/" + tenantID.String() + "/notes"

	var created struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, AddTenantNote, http.MethodPost, base,
		map[string]any{"body": "Owner wants a second outlet in Q4"},
		superParam("id", tenantID.String())).
		expectStatus(http.StatusCreated).decode(&created)

	var listed struct {
		Notes []TenantNote `json:"notes"`
	}
	callSuper(t, sf, ListTenantNotes, http.MethodGet, base, nil, superParam("id", tenantID.String())).
		expectStatus(http.StatusOK).decode(&listed)
	if len(listed.Notes) != 1 || listed.Notes[0].Body != "Owner wants a second outlet in Q4" {
		t.Fatalf("notes = %+v", listed.Notes)
	}
	// users.name is NOT NULL DEFAULT '', so a plain COALESCE would stop at the
	// empty string and never reach the email — every note would read as
	// authored by nobody.
	if listed.Notes[0].AuthorName == "" {
		t.Error("note should carry its author")
	}
	sf.adminExec(`UPDATE users SET name = '' WHERE id = $1`, sf.AdminUser)
	callSuper(t, sf, ListTenantNotes, http.MethodGet, base, nil, superParam("id", tenantID.String())).
		expectStatus(http.StatusOK).decode(&listed)
	if listed.Notes[0].AuthorName == "" {
		t.Error("an author with a blank name should fall back to their email")
	}

	callSuper(t, sf, UpdateTenantNote, http.MethodPatch, base+"/"+created.ID.String(),
		map[string]any{"pinned": true},
		superParam("id", tenantID.String()), superParam("noteId", created.ID.String())).
		expectStatus(http.StatusOK)

	callSuper(t, sf, DeleteTenantNote, http.MethodDelete, base+"/"+created.ID.String(), nil,
		superParam("id", tenantID.String()), superParam("noteId", created.ID.String())).
		expectStatus(http.StatusOK)

	callSuper(t, sf, ListTenantNotes, http.MethodGet, base, nil, superParam("id", tenantID.String())).
		expectStatus(http.StatusOK).decode(&listed)
	if len(listed.Notes) != 0 {
		t.Errorf("notes should be empty after delete, got %d", len(listed.Notes))
	}
}

// Pinned notes float to the top — that's the whole point of the flag.
func TestTenantNotes_PinnedFirst(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Pinned Cafe")
	base := "/v1/super/tenants/" + tenantID.String() + "/notes"

	callSuper(t, sf, AddTenantNote, http.MethodPost, base, map[string]any{"body": "older, unpinned"},
		superParam("id", tenantID.String())).expectStatus(http.StatusCreated)
	callSuper(t, sf, AddTenantNote, http.MethodPost, base,
		map[string]any{"body": "older, pinned", "pinned": true},
		superParam("id", tenantID.String())).expectStatus(http.StatusCreated)
	callSuper(t, sf, AddTenantNote, http.MethodPost, base, map[string]any{"body": "newest, unpinned"},
		superParam("id", tenantID.String())).expectStatus(http.StatusCreated)

	var listed struct {
		Notes []TenantNote `json:"notes"`
	}
	callSuper(t, sf, ListTenantNotes, http.MethodGet, base, nil, superParam("id", tenantID.String())).
		expectStatus(http.StatusOK).decode(&listed)
	if len(listed.Notes) != 3 {
		t.Fatalf("want 3 notes, got %d", len(listed.Notes))
	}
	if listed.Notes[0].Body != "older, pinned" {
		t.Errorf("pinned note should sort first, got %q", listed.Notes[0].Body)
	}
	if listed.Notes[1].Body != "newest, unpinned" {
		t.Errorf("unpinned notes should be newest-first, got %q", listed.Notes[1].Body)
	}
}

func TestTenantNotes_Validation(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Empty Note Cafe")
	callSuper(t, sf, AddTenantNote, http.MethodPost,
		"/v1/super/tenants/"+tenantID.String()+"/notes", map[string]any{"body": "   "},
		superParam("id", tenantID.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestTenantNotes_MissingTenantIs404(t *testing.T) {
	sf := newSuperFixture(t)
	missing := uuid.New()
	callSuper(t, sf, AddTenantNote, http.MethodPost,
		"/v1/super/tenants/"+missing.String()+"/notes", map[string]any{"body": "hello"},
		superParam("id", missing.String())).
		expectErr(http.StatusNotFound, "not_found")
}

// A note id from another cafe must not be reachable through this tenant's URL.
func TestTenantNotes_ScopedToTenant(t *testing.T) {
	sf := newSuperFixture(t)
	a, _ := sf.seedTenant("Cafe A")
	b, _ := sf.seedTenant("Cafe B")

	var created struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, AddTenantNote, http.MethodPost, "/v1/super/tenants/"+a.String()+"/notes",
		map[string]any{"body": "belongs to A"}, superParam("id", a.String())).
		expectStatus(http.StatusCreated).decode(&created)

	callSuper(t, sf, DeleteTenantNote, http.MethodDelete,
		"/v1/super/tenants/"+b.String()+"/notes/"+created.ID.String(), nil,
		superParam("id", b.String()), superParam("noteId", created.ID.String())).
		expectErr(http.StatusNotFound, "not_found")
}
