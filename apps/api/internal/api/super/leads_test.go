package super

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// =========================================================================
// Lead pipeline (0061)
//
// Two properties carry the feature and most of what follows asserts them:
//
//  1. A lead can only be WON by acquiring a cafe — convert or link — so a won
//     lead always has one, and a closed lead never re-enters the pipeline.
//  2. Winning hands the lead's attribution to the tenant, and linking to a cafe
//     that already has a relationship manager does NOT overwrite them.
//
// The rest is validation and the dedupe index that used to live on
// tenant_requests.
// =========================================================================

// leadEmail keeps every test's email unique — the partial unique index on open
// leads is global, so a fixed address would make tests collide with each other.
func leadEmail(hint string) string {
	return hint + "-" + uuid.NewString()[:8] + "@lead.test"
}

func createLead(t *testing.T, sf *superFixture, body map[string]any) uuid.UUID {
	t.Helper()
	var out struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, CreateLead, http.MethodPost, "/v1/super/leads", body).
		expectStatus(http.StatusCreated).decode(&out)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM platform_leads WHERE id = $1`, out.ID)
	})
	return out.ID
}

// leadRow reads back the fields the write paths are supposed to maintain.
func (sf *superFixture) leadRow(id uuid.UUID) (stage string, owner *uuid.UUID, tenant *uuid.UUID, closedAt *time.Time, lostReason string) {
	sf.t.Helper()
	sf.adminScan([]any{&stage, &owner, &tenant, &closedAt, &lostReason},
		`SELECT stage, owner_person_id, converted_tenant_id, closed_at, lost_reason
		 FROM platform_leads WHERE id = $1`, id)
	return
}

func (sf *superFixture) leadActivityKinds(id uuid.UUID) []string {
	sf.t.Helper()
	rows, err := adminPool.Query(context.Background(),
		`SELECT kind FROM platform_lead_activities WHERE lead_id = $1 ORDER BY created_at`, id)
	if err != nil {
		sf.t.Fatalf("leadActivityKinds: %v", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			sf.t.Fatalf("leadActivityKinds scan: %v", err)
		}
		out = append(out, k)
	}
	return out
}

// --- create ---------------------------------------------------------------

func TestCreateLead_DefaultsOwnerToActingAdmin(t *testing.T) {
	sf := newSuperFixture(t)
	// The acting admin needs a registry row for actingPersonID to find one.
	personID := sf.seedPerson("Acting Agent", "admin")
	sf.adminExec(`UPDATE platform_people SET user_id = $2 WHERE id = $1`, personID, sf.AdminUser)

	id := createLead(t, sf, map[string]any{
		"cafe_name": "Unassigned Cafe", "phone": "9800000001",
	})

	_, owner, _, _, _ := sf.leadRow(id)
	if owner == nil || *owner != personID {
		t.Errorf("owner_person_id = %v, want the acting admin's person %v", owner, personID)
	}
	if n := sf.countPlatformAudit("lead.create", nil); n == 0 {
		t.Error("expected a platform_audit row for lead.create")
	}
}

func TestCreateLead_PhoneOnlyIsValid(t *testing.T) {
	sf := newSuperFixture(t)
	// A market agent may genuinely have only a shop name and a number. That has
	// to be a first-class lead, not a validation error.
	createLead(t, sf, map[string]any{"cafe_name": "Footpath Tea", "phone": "9812345678"})
}

func TestCreateLead_NeedsAWayToContactThem(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateLead, http.MethodPost, "/v1/super/leads", map[string]any{
		"cafe_name": "Unreachable Cafe",
	}).expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreateLead_RequiresCafeName(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateLead, http.MethodPost, "/v1/super/leads", map[string]any{
		"phone": "9800000002",
	}).expectErr(http.StatusBadRequest, "bad_request")
}

func TestCreateLead_UnknownOwnerIs400(t *testing.T) {
	sf := newSuperFixture(t)
	// A bad person id must be a 400, not a foreign-key 500.
	callSuper(t, sf, CreateLead, http.MethodPost, "/v1/super/leads", map[string]any{
		"cafe_name": "Ghost Owner Cafe", "phone": "9800000003",
		"owner_person_id": uuid.New().String(),
	}).expectErr(http.StatusBadRequest, "unknown_person")
}

func TestCreateLead_UnknownSourceIs400(t *testing.T) {
	sf := newSuperFixture(t)
	callSuper(t, sf, CreateLead, http.MethodPost, "/v1/super/leads", map[string]any{
		"cafe_name": "Odd Source Cafe", "phone": "9800000004", "source": "telepathy",
	}).expectErr(http.StatusBadRequest, "bad_request")
}

// The dedupe index that used to stop request-access spam now also stops two
// agents working the same cafe.
func TestCreateLead_SecondOpenLeadForSameEmailIs409(t *testing.T) {
	sf := newSuperFixture(t)
	email := leadEmail("dupe")
	createLead(t, sf, map[string]any{"cafe_name": "First Bite", "email": email})

	callSuper(t, sf, CreateLead, http.MethodPost, "/v1/super/leads", map[string]any{
		"cafe_name": "Second Bite", "email": email,
	}).expectErr(http.StatusConflict, "lead_exists")
}

// ...but a CLOSED lead frees the address again, so a cafe that said no last
// year can be approached afresh.
func TestCreateLead_ClosedLeadFreesTheEmail(t *testing.T) {
	sf := newSuperFixture(t)
	email := leadEmail("reopen")
	first := createLead(t, sf, map[string]any{"cafe_name": "Maybe Later", "email": email})
	sf.adminExec(`UPDATE platform_leads SET stage='lost', lost_reason='too early' WHERE id=$1`, first)

	createLead(t, sf, map[string]any{"cafe_name": "Maybe Now", "email": email})
}

// --- list -----------------------------------------------------------------

func TestListLeads_HidesClosedByDefaultButCountsThem(t *testing.T) {
	sf := newSuperFixture(t)
	open := createLead(t, sf, map[string]any{"cafe_name": "Open Cafe", "email": leadEmail("open")})
	closed := createLead(t, sf, map[string]any{"cafe_name": "Closed Cafe", "email": leadEmail("closed")})
	sf.adminExec(`UPDATE platform_leads SET stage='lost', lost_reason='no budget' WHERE id=$1`, closed)

	var out struct {
		Leads  []Lead         `json:"leads"`
		Counts map[string]int `json:"counts"`
	}
	callSuper(t, sf, ListLeads, http.MethodGet, "/v1/super/leads", nil).
		expectStatus(http.StatusOK).decode(&out)

	seen := map[uuid.UUID]bool{}
	for _, l := range out.Leads {
		seen[l.ID] = true
	}
	if !seen[open] {
		t.Error("open lead missing from the default list")
	}
	if seen[closed] {
		t.Error("closed lead appeared without include_closed")
	}
	// The counts must still see the closed one — otherwise clicking a stage
	// chip would make every other chip read zero.
	if out.Counts["lost"] == 0 {
		t.Error("counts['lost'] = 0, want the closed lead counted")
	}
}

func TestListLeads_FiltersByStage(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Demo Stage Cafe", "email": leadEmail("stage")})
	sf.adminExec(`UPDATE platform_leads SET stage='demo' WHERE id=$1`, id)

	var out struct {
		Leads []Lead `json:"leads"`
	}
	callSuper(t, sf, ListLeads, http.MethodGet, "/v1/super/leads", nil, superQuery("stage=demo")).
		expectStatus(http.StatusOK).decode(&out)

	found := false
	for _, l := range out.Leads {
		if l.Stage != "demo" {
			t.Errorf("stage filter returned a %q lead", l.Stage)
		}
		if l.ID == id {
			found = true
		}
	}
	if !found {
		t.Error("stage=demo did not return the demo lead")
	}
}

func TestListLeads_FiltersOverdueFollowUps(t *testing.T) {
	sf := newSuperFixture(t)
	overdue := createLead(t, sf, map[string]any{"cafe_name": "Chase Me", "email": leadEmail("overdue")})
	future := createLead(t, sf, map[string]any{"cafe_name": "Later", "email": leadEmail("future")})
	sf.adminExec(`UPDATE platform_leads SET next_follow_up_at = CURRENT_DATE - 3 WHERE id=$1`, overdue)
	sf.adminExec(`UPDATE platform_leads SET next_follow_up_at = CURRENT_DATE + 30 WHERE id=$1`, future)

	var out struct {
		Leads []Lead `json:"leads"`
	}
	callSuper(t, sf, ListLeads, http.MethodGet, "/v1/super/leads", nil, superQuery("due=overdue")).
		expectStatus(http.StatusOK).decode(&out)

	seen := map[uuid.UUID]bool{}
	for _, l := range out.Leads {
		seen[l.ID] = true
	}
	if !seen[overdue] {
		t.Error("due=overdue missed a lead three days past its follow-up")
	}
	if seen[future] {
		t.Error("due=overdue returned a lead due next month")
	}
}

// --- update / stages ------------------------------------------------------

func TestUpdateLead_StageMoveWritesTimelineEntry(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Moving Cafe", "email": leadEmail("move")})

	callSuper(t, sf, UpdateLead, http.MethodPatch, "/v1/super/leads/"+id.String(),
		map[string]any{"cafe_name": "Moving Cafe", "phone": "9800000005", "stage": "contacted"},
		superParam("id", id.String())).
		expectStatus(http.StatusOK)

	stage, _, _, _, _ := sf.leadRow(id)
	if stage != "contacted" {
		t.Errorf("stage = %q, want contacted", stage)
	}
	// The timeline has to explain its own history without anyone typing a note.
	kinds := sf.leadActivityKinds(id)
	if len(kinds) != 1 || kinds[0] != "stage_change" {
		t.Errorf("activities = %v, want exactly one stage_change", kinds)
	}
}

func TestUpdateLead_LostRequiresAReason(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Doomed Cafe", "email": leadEmail("lost")})

	callSuper(t, sf, UpdateLead, http.MethodPatch, "/v1/super/leads/"+id.String(),
		map[string]any{"cafe_name": "Doomed Cafe", "phone": "9800000006", "stage": "lost"},
		superParam("id", id.String())).
		expectErr(http.StatusBadRequest, "lost_reason_required")

	callSuper(t, sf, UpdateLead, http.MethodPatch, "/v1/super/leads/"+id.String(),
		map[string]any{"cafe_name": "Doomed Cafe", "phone": "9800000006",
			"stage": "lost", "lost_reason": "went with a competitor"},
		superParam("id", id.String())).
		expectStatus(http.StatusOK)

	stage, _, _, closedAt, reason := sf.leadRow(id)
	if stage != "lost" || reason != "went with a competitor" {
		t.Errorf("stage/reason = %q/%q", stage, reason)
	}
	if closedAt == nil {
		t.Error("closed_at was not stamped on a lost lead")
	}
}

// Winning must go through convert/link so a won lead always has a cafe.
func TestUpdateLead_CannotWinDirectly(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Shortcut Cafe", "email": leadEmail("shortcut")})

	callSuper(t, sf, UpdateLead, http.MethodPatch, "/v1/super/leads/"+id.String(),
		map[string]any{"cafe_name": "Shortcut Cafe", "phone": "9800000007", "stage": "won"},
		superParam("id", id.String())).
		expectErr(http.StatusConflict, "use_convert")
}

func TestUpdateLead_CannotReopenAClosedLead(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Done Cafe", "email": leadEmail("done")})
	sf.adminExec(`UPDATE platform_leads SET stage='lost', lost_reason='no' WHERE id=$1`, id)

	callSuper(t, sf, UpdateLead, http.MethodPatch, "/v1/super/leads/"+id.String(),
		map[string]any{"cafe_name": "Done Cafe", "phone": "9800000008", "stage": "contacted"},
		superParam("id", id.String())).
		expectErr(http.StatusConflict, "already_closed")
}

func TestUpdateLead_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, UpdateLead, http.MethodPatch, "/v1/super/leads/"+id.String(),
		map[string]any{"cafe_name": "Nowhere", "phone": "980"},
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

// --- activities -----------------------------------------------------------

func TestLogLeadActivity_BooksTheNextFollowUpInTheSameCall(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Called Cafe", "email": leadEmail("call")})

	callSuper(t, sf, LogLeadActivity, http.MethodPost, "/v1/super/leads/"+id.String()+"/activities",
		map[string]any{"kind": "call", "body": "spoke to the owner, wants a demo",
			"next_follow_up_at": time.Now().AddDate(0, 0, 3).Format("2006-01-02")},
		superParam("id", id.String())).
		expectStatus(http.StatusCreated)

	if kinds := sf.leadActivityKinds(id); len(kinds) != 1 || kinds[0] != "call" {
		t.Errorf("activities = %v, want one call", kinds)
	}
	var due *string
	sf.adminScan([]any{&due},
		`SELECT to_char(next_follow_up_at, 'YYYY-MM-DD') FROM platform_leads WHERE id = $1`, id)
	if due == nil {
		t.Error("logging a call with a follow-up date did not book it")
	}
}

// A forged stage_change would make the timeline untrustworthy.
func TestLogLeadActivity_RejectsStageChangeKind(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Forged Cafe", "email": leadEmail("forge")})

	callSuper(t, sf, LogLeadActivity, http.MethodPost, "/v1/super/leads/"+id.String()+"/activities",
		map[string]any{"kind": "stage_change", "body": "won it, honest"},
		superParam("id", id.String())).
		expectErr(http.StatusBadRequest, "bad_request")
}

func TestLogLeadActivity_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, LogLeadActivity, http.MethodPost, "/v1/super/leads/"+id.String()+"/activities",
		map[string]any{"kind": "note", "body": "hello"},
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

// --- convert --------------------------------------------------------------

// The whole point of the pipeline: the agent's work becomes the cafe's
// attribution, without anyone re-typing it on the Relationship tab.
func TestConvertLead_TenantInheritsTheRelationship(t *testing.T) {
	sf := newSuperFixture(t)
	agent := sf.seedPerson("Market Agent", "agent")
	email := leadEmail("convert")
	id := createLead(t, sf, map[string]any{
		"cafe_name": "Inherited Cafe", "contact_name": "Bikash", "email": email,
		"phone": "9841000000", "source": "walk_in", "owner_person_id": agent.String(),
	})

	var out struct {
		TenantID uuid.UUID `json:"tenant_id"`
		Slug     string    `json:"slug"`
	}
	callSuper(t, sf, ConvertLead(sf.rbacRepo), http.MethodPost,
		"/v1/super/leads/"+id.String()+"/convert", map[string]any{},
		superParam("id", id.String())).
		expectStatus(http.StatusOK).decode(&out)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, out.TenantID)
	})

	var onboarder, rm, sourceLead *uuid.UUID
	var source, ownerName, phone string
	sf.adminScan([]any{&onboarder, &rm, &sourceLead, &source, &ownerName, &phone},
		`SELECT onboarded_by_person_id, relationship_manager_id, source_lead_id,
		        acquisition_source, owner_name, contact_phone
		 FROM tenants WHERE id = $1`, out.TenantID)

	if onboarder == nil || *onboarder != agent {
		t.Errorf("onboarded_by_person_id = %v, want the lead's owner %v", onboarder, agent)
	}
	// The RM seeds from the onboarder inside provisionTenant — that is what
	// makes the agent the ongoing owner of the account, not just its origin.
	if rm == nil || *rm != agent {
		t.Errorf("relationship_manager_id = %v, want %v", rm, agent)
	}
	if sourceLead == nil || *sourceLead != id {
		t.Errorf("source_lead_id = %v, want %v", sourceLead, id)
	}
	if source != "walk_in" {
		t.Errorf("acquisition_source = %q, want the lead's source walk_in", source)
	}
	if ownerName != "Bikash" || phone != "9841000000" {
		t.Errorf("owner_name/contact_phone = %q/%q, want the lead's contact details", ownerName, phone)
	}

	stage, _, tenant, closedAt, _ := sf.leadRow(id)
	if stage != "won" || tenant == nil || *tenant != out.TenantID || closedAt == nil {
		t.Errorf("lead after convert: stage=%q tenant=%v closed=%v", stage, tenant, closedAt)
	}
	if n := sf.countPlatformAudit("lead.convert", &out.TenantID); n == 0 {
		t.Error("expected a platform_audit row for lead.convert")
	}
}

func TestConvertLead_SecondConvertIs409(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Twice Cafe", "email": leadEmail("twice")})

	var out struct {
		TenantID uuid.UUID `json:"tenant_id"`
	}
	callSuper(t, sf, ConvertLead(sf.rbacRepo), http.MethodPost,
		"/v1/super/leads/"+id.String()+"/convert", map[string]any{},
		superParam("id", id.String())).
		expectStatus(http.StatusOK).decode(&out)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, out.TenantID)
	})

	callSuper(t, sf, ConvertLead(sf.rbacRepo), http.MethodPost,
		"/v1/super/leads/"+id.String()+"/convert", map[string]any{},
		superParam("id", id.String())).
		expectErr(http.StatusConflict, "already_closed")
}

// A phone-only lead has nobody to invite. Ask for an address rather than
// provisioning a cafe whose owner can never log in.
func TestConvertLead_PhoneOnlyNeedsAnOwnerEmail(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Phone Only Cafe", "phone": "9812340000"})

	callSuper(t, sf, ConvertLead(sf.rbacRepo), http.MethodPost,
		"/v1/super/leads/"+id.String()+"/convert", map[string]any{},
		superParam("id", id.String())).
		expectErr(http.StatusBadRequest, "owner_email_required")

	var out struct {
		TenantID uuid.UUID `json:"tenant_id"`
	}
	callSuper(t, sf, ConvertLead(sf.rbacRepo), http.MethodPost,
		"/v1/super/leads/"+id.String()+"/convert",
		map[string]any{"owner_email": leadEmail("supplied")},
		superParam("id", id.String())).
		expectStatus(http.StatusOK).decode(&out)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, out.TenantID)
	})
}

func TestConvertLead_SlugTakenIs409(t *testing.T) {
	sf := newSuperFixture(t)
	_, existingSlug := sf.seedTenant("Slug Clash Tenant")
	id := createLead(t, sf, map[string]any{"cafe_name": existingSlug, "email": leadEmail("slug")})

	callSuper(t, sf, ConvertLead(sf.rbacRepo), http.MethodPost,
		"/v1/super/leads/"+id.String()+"/convert", map[string]any{"slug": existingSlug},
		superParam("id", id.String())).
		expectErr(http.StatusConflict, "slug_taken")
}

func TestConvertLead_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, ConvertLead(sf.rbacRepo), http.MethodPost,
		"/v1/super/leads/"+id.String()+"/convert", map[string]any{},
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

// --- link -----------------------------------------------------------------

func TestLinkLead_FillsBlankRelationshipFields(t *testing.T) {
	sf := newSuperFixture(t)
	agent := sf.seedPerson("Linking Agent", "agent")
	tenantID, slug := sf.seedTenant("Already Existing Cafe")
	id := createLead(t, sf, map[string]any{
		"cafe_name": "Already Existing Cafe", "email": leadEmail("link"),
		"source": "referral", "owner_person_id": agent.String(),
	})

	callSuper(t, sf, LinkLead, http.MethodPost, "/v1/super/leads/"+id.String()+"/link",
		map[string]any{"tenant_id": tenantID.String()},
		superParam("id", id.String())).
		expectStatus(http.StatusOK)

	var onboarder, rm, sourceLead *uuid.UUID
	var source string
	sf.adminScan([]any{&onboarder, &rm, &sourceLead, &source},
		`SELECT onboarded_by_person_id, relationship_manager_id, source_lead_id, acquisition_source
		 FROM tenants WHERE id = $1`, tenantID)
	if onboarder == nil || *onboarder != agent || rm == nil || *rm != agent {
		t.Errorf("blank relationship not filled: onboarder=%v rm=%v", onboarder, rm)
	}
	if sourceLead == nil || *sourceLead != id {
		t.Errorf("source_lead_id = %v, want %v", sourceLead, id)
	}
	if source != "referral" {
		t.Errorf("acquisition_source = %q, want referral", source)
	}

	stage, _, tenant, _, _ := sf.leadRow(id)
	if stage != "won" || tenant == nil || *tenant != tenantID {
		t.Errorf("lead after link: stage=%q tenant=%v", stage, tenant)
	}
	if n := sf.countPlatformAudit("lead.link", &tenantID); n == 0 {
		t.Error("expected a platform_audit row for lead.link")
	}
	_ = slug
}

// Somebody tidying up the pipeline weeks later must not silently reassign a
// cafe that already has an owner.
func TestLinkLead_DoesNotOverwriteAnAssignedManager(t *testing.T) {
	sf := newSuperFixture(t)
	incumbent := sf.seedPerson("Incumbent RM", "admin")
	newcomer := sf.seedPerson("Latecomer", "agent")
	tenantID, _ := sf.seedTenant("Spoken For Cafe")
	sf.adminExec(`UPDATE tenants SET onboarded_by_person_id = $2, relationship_manager_id = $2,
	              acquisition_source = 'referral' WHERE id = $1`, tenantID, incumbent)

	id := createLead(t, sf, map[string]any{
		"cafe_name": "Spoken For Cafe", "email": leadEmail("clash"),
		"source": "outbound", "owner_person_id": newcomer.String(),
	})
	callSuper(t, sf, LinkLead, http.MethodPost, "/v1/super/leads/"+id.String()+"/link",
		map[string]any{"tenant_id": tenantID.String()},
		superParam("id", id.String())).
		expectStatus(http.StatusOK)

	var onboarder, rm *uuid.UUID
	var source string
	sf.adminScan([]any{&onboarder, &rm, &source},
		`SELECT onboarded_by_person_id, relationship_manager_id, acquisition_source
		 FROM tenants WHERE id = $1`, tenantID)
	if rm == nil || *rm != incumbent {
		t.Errorf("relationship_manager_id = %v, want the incumbent %v to survive", rm, incumbent)
	}
	if onboarder == nil || *onboarder != incumbent {
		t.Errorf("onboarded_by_person_id = %v, want %v", onboarder, incumbent)
	}
	if source != "referral" {
		t.Errorf("acquisition_source = %q, want the existing referral to survive", source)
	}
}

func TestLinkLead_TenantAlreadyClaimedIs409(t *testing.T) {
	sf := newSuperFixture(t)
	tenantID, _ := sf.seedTenant("Contested Cafe")
	first := createLead(t, sf, map[string]any{"cafe_name": "Contested Cafe", "email": leadEmail("first")})
	second := createLead(t, sf, map[string]any{"cafe_name": "Contested Cafe", "email": leadEmail("second")})

	callSuper(t, sf, LinkLead, http.MethodPost, "/v1/super/leads/"+first.String()+"/link",
		map[string]any{"tenant_id": tenantID.String()},
		superParam("id", first.String())).
		expectStatus(http.StatusOK)

	callSuper(t, sf, LinkLead, http.MethodPost, "/v1/super/leads/"+second.String()+"/link",
		map[string]any{"tenant_id": tenantID.String()},
		superParam("id", second.String())).
		expectErr(http.StatusConflict, "tenant_already_linked")
}

func TestLinkLead_UnknownTenantIs404(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Orphan Link", "email": leadEmail("orphan")})
	callSuper(t, sf, LinkLead, http.MethodPost, "/v1/super/leads/"+id.String()+"/link",
		map[string]any{"tenant_id": uuid.New().String()},
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}

// --- read -----------------------------------------------------------------

func TestGetLead_ReturnsTheTimeline(t *testing.T) {
	sf := newSuperFixture(t)
	id := createLead(t, sf, map[string]any{"cafe_name": "Detailed Cafe", "email": leadEmail("detail")})
	callSuper(t, sf, LogLeadActivity, http.MethodPost, "/v1/super/leads/"+id.String()+"/activities",
		map[string]any{"kind": "visit", "body": "dropped in, owner was out"},
		superParam("id", id.String())).
		expectStatus(http.StatusCreated)

	var out LeadDetail
	callSuper(t, sf, GetLead, http.MethodGet, "/v1/super/leads/"+id.String(), nil,
		superParam("id", id.String())).
		expectStatus(http.StatusOK).decode(&out)

	if out.Lead.ID != id {
		t.Fatalf("returned lead %v, want %v", out.Lead.ID, id)
	}
	if len(out.Activities) != 1 || out.Activities[0].Kind != "visit" {
		t.Errorf("activities = %+v, want one visit", out.Activities)
	}
}

func TestGetLead_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	id := uuid.New()
	callSuper(t, sf, GetLead, http.MethodGet, "/v1/super/leads/"+id.String(), nil,
		superParam("id", id.String())).
		expectErr(http.StatusNotFound, "not_found")
}
