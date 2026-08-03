package super

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// =========================================================================
// People registry (0057)
//
// The point of this table is that it is NOT an auth surface: an agent with no
// email and no users row must be a first-class entry, and removing someone
// must never blank out the cafes they onboarded. Most of what's asserted here
// is that those two properties hold.
// =========================================================================

// seedPerson inserts a registry row directly and cleans it up. Used where the
// test needs a person to exist but isn't exercising CreatePerson itself.
func (sf *superFixture) seedPerson(name, kind string) uuid.UUID {
	sf.t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO platform_people (name, kind) VALUES ($1, $2) RETURNING id`, name, kind,
	).Scan(&id); err != nil {
		sf.t.Fatalf("seedPerson: %v", err)
	}
	sf.t.Cleanup(func() { cleanupPerson(id) })
	return id
}

// cleanupPerson removes a test person AND the finance rows that
// RESTRICT-reference them. Without the children the DELETE fails, and because
// test cleanups ignore errors it fails SILENTLY — which is how the dev database
// accumulated dozens of orphaned "Collector" and "Depositor" rows before anyone
// noticed.
func cleanupPerson(id uuid.UUID) {
	bg := context.Background()
	_, _ = adminPool.Exec(bg, `DELETE FROM platform_cash_entries WHERE person_id = $1 OR counterparty_person_id = $1`, id)
	_, _ = adminPool.Exec(bg, `DELETE FROM platform_expenses WHERE paid_by_person_id = $1`, id)
	_, _ = adminPool.Exec(bg, `DELETE FROM platform_people WHERE id = $1`, id)
}

// personRow reads one registry row back through the admin pool.
func (sf *superFixture) personRow(id uuid.UUID) (name, kind string, email *string, userID *uuid.UUID, active bool) {
	sf.t.Helper()
	sf.adminScan([]any{&name, &kind, &email, &userID, &active},
		`SELECT name, kind, email::text, user_id, active FROM platform_people WHERE id = $1`, id)
	return
}

func createPerson(t *testing.T, sf *superFixture, body map[string]any) uuid.UUID {
	t.Helper()
	var out struct {
		ID uuid.UUID `json:"id"`
	}
	callSuper(t, sf, CreatePerson, http.MethodPost, "/v1/super/people", body).
		expectStatus(http.StatusCreated).decode(&out)
	t.Cleanup(func() { cleanupPerson(out.ID) })
	return out.ID
}

// The headline requirement: a market agent who has never touched the product
// still gets a registry entry.
func TestCreatePerson_AgentWithNoEmail(t *testing.T) {
	sf := newSuperFixture(t)
	id := createPerson(t, sf, map[string]any{"name": "Bikash Field", "kind": "agent", "phone": "+977 98"})

	name, kind, email, userID, active := sf.personRow(id)
	if name != "Bikash Field" || kind != "agent" {
		t.Errorf("got name=%q kind=%q", name, kind)
	}
	if email != nil {
		t.Errorf("email should be NULL, got %v", *email)
	}
	if userID != nil {
		t.Errorf("user_id should be NULL for someone who has never signed in, got %v", *userID)
	}
	if !active {
		t.Error("new people should be active")
	}
}

// Two email-less agents must coexist — the unique index is partial precisely so
// NULLs don't collide.
func TestCreatePerson_MultipleWithoutEmail(t *testing.T) {
	sf := newSuperFixture(t)
	createPerson(t, sf, map[string]any{"name": "Agent One", "kind": "agent"})
	createPerson(t, sf, map[string]any{"name": "Agent Two", "kind": "agent"})
}

// An empty-string email must become NULL, not "" — otherwise the second
// blank-email agent trips the unique index.
func TestCreatePerson_BlankEmailStoresNull(t *testing.T) {
	sf := newSuperFixture(t)
	id := createPerson(t, sf, map[string]any{"name": "Blank Email", "email": "   "})
	if _, _, email, _, _ := sf.personRow(id); email != nil {
		t.Errorf("blank email should store NULL, got %q", *email)
	}
	createPerson(t, sf, map[string]any{"name": "Blank Email Two", "email": ""})
}

func TestCreatePerson_LinksExistingUser(t *testing.T) {
	sf := newSuperFixture(t)
	userID, email := sf.seedUser("linkme")

	id := createPerson(t, sf, map[string]any{"name": "Linked Admin", "kind": "admin", "email": email})
	_, _, gotEmail, gotUser, _ := sf.personRow(id)
	if gotUser == nil || *gotUser != userID {
		t.Errorf("user_id = %v, want %v", gotUser, userID)
	}
	if gotEmail == nil || *gotEmail != email {
		t.Errorf("email = %v, want %v", gotEmail, email)
	}
}

func TestCreatePerson_DuplicateEmailIs409(t *testing.T) {
	sf := newSuperFixture(t)
	createPerson(t, sf, map[string]any{"name": "First", "email": "dupe-person@test.local"})
	callSuper(t, sf, CreatePerson, http.MethodPost, "/v1/super/people",
		map[string]any{"name": "Second", "email": "dupe-person@test.local"}).
		expectErr(http.StatusConflict, "person_exists")
	// The 409 above rolled back; clean up the survivor.
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(),
			`DELETE FROM platform_people WHERE email = 'dupe-person@test.local'`)
	})
}

func TestCreatePerson_Validation(t *testing.T) {
	sf := newSuperFixture(t)
	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"empty name", map[string]any{"name": "  "}},
		{"unknown kind", map[string]any{"name": "X", "kind": "wizard"}},
		{"bad email", map[string]any{"name": "X", "email": "not-an-address"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			callSuper(t, sf, CreatePerson, http.MethodPost, "/v1/super/people", tc.body).
				expectErr(http.StatusBadRequest, "bad_request")
		})
	}
}

// Deactivating must PRESERVE attribution. If this ever became a delete, the
// ON DELETE SET NULL would silently blank the onboarder on every cafe they
// ever signed up.
func TestUpdatePerson_DeactivateKeepsAttribution(t *testing.T) {
	sf := newSuperFixture(t)
	personID := sf.seedPerson("Retiring Agent", "agent")
	tenantID, _ := sf.seedTenant("Their Cafe")
	sf.adminExec(`UPDATE tenants SET onboarded_by_person_id = $1, relationship_manager_id = $1 WHERE id = $2`,
		personID, tenantID)

	callSuper(t, sf, UpdatePerson, http.MethodPatch, "/v1/super/people/"+personID.String(),
		map[string]any{"name": "Retiring Agent", "kind": "agent", "active": false},
		superParam("id", personID.String())).
		expectStatus(http.StatusOK)

	if _, _, _, _, active := sf.personRow(personID); active {
		t.Error("person should be deactivated")
	}
	var stillAttributed bool
	sf.adminScan([]any{&stillAttributed},
		`SELECT onboarded_by_person_id = $1 FROM tenants WHERE id = $2`, personID, tenantID)
	if !stillAttributed {
		t.Error("deactivating a person must not clear the cafes they onboarded")
	}
}

// The default list is for picking an RM, so a deactivated agent must not appear
// in it — but must still be reachable when explicitly asked for.
func TestListPeople_ExcludesInactiveByDefault(t *testing.T) {
	sf := newSuperFixture(t)
	activeID := sf.seedPerson("Still Here", "agent")
	goneID := sf.seedPerson("Long Gone", "agent")
	sf.adminExec(`UPDATE platform_people SET active = false WHERE id = $1`, goneID)

	has := func(query string, want uuid.UUID) bool {
		var out struct {
			People []Person `json:"people"`
		}
		opts := []func(*superReqOpts){}
		if query != "" {
			opts = append(opts, superQuery(query))
		}
		callSuper(t, sf, ListPeople, http.MethodGet, "/v1/super/people", nil, opts...).
			expectStatus(http.StatusOK).decode(&out)
		for _, p := range out.People {
			if p.ID == want {
				return true
			}
		}
		return false
	}

	if !has("", activeID) {
		t.Error("active person missing from the default list")
	}
	if has("", goneID) {
		t.Error("inactive person must not appear in the default list")
	}
	if !has("include_inactive=1", goneID) {
		t.Error("inactive person should appear with include_inactive")
	}
}

func TestPersonPortfolio_SplitsOnboardedAndManaged(t *testing.T) {
	sf := newSuperFixture(t)
	scout := sf.seedPerson("The Scout", "agent")
	keeper := sf.seedPerson("The Keeper", "admin")

	// One cafe the scout signed up but the keeper now manages, and one the
	// scout still owns end to end.
	handedOver, _ := sf.seedTenant("Handed Over Cafe")
	sf.adminExec(`UPDATE tenants SET onboarded_by_person_id = $1, relationship_manager_id = $2 WHERE id = $3`,
		scout, keeper, handedOver)
	kept, _ := sf.seedTenant("Kept Cafe")
	sf.adminExec(`UPDATE tenants SET onboarded_by_person_id = $1, relationship_manager_id = $1 WHERE id = $2`,
		scout, kept)

	var out PersonPortfolio
	callSuper(t, sf, GetPersonPortfolio, http.MethodGet, "/v1/super/people/"+scout.String(), nil,
		superParam("id", scout.String())).
		expectStatus(http.StatusOK).decode(&out)

	if out.Person.CafesOnboarded != 2 {
		t.Errorf("cafes_onboarded = %d, want 2", out.Person.CafesOnboarded)
	}
	if out.Person.CafesManaged != 1 {
		t.Errorf("cafes_managed = %d, want 1 (the handed-over cafe belongs to the keeper now)", out.Person.CafesManaged)
	}
	if len(out.Onboards) != 2 || len(out.Cafes) != 1 {
		t.Errorf("onboards = %d, managed = %d; want 2 and 1", len(out.Onboards), len(out.Cafes))
	}
}

func TestPersonPortfolio_NotFound(t *testing.T) {
	sf := newSuperFixture(t)
	missing := uuid.New()
	callSuper(t, sf, GetPersonPortfolio, http.MethodGet, "/v1/super/people/"+missing.String(), nil,
		superParam("id", missing.String())).
		expectErr(http.StatusNotFound, "not_found")
}

// A purged cafe must not keep inflating somebody's portfolio count.
func TestPersonPortfolio_IgnoresDeletedTenants(t *testing.T) {
	sf := newSuperFixture(t)
	personID := sf.seedPerson("Counter", "agent")
	tenantID, _ := sf.seedTenant("Doomed Cafe")
	sf.adminExec(`UPDATE tenants SET onboarded_by_person_id = $1, deleted_at = now() WHERE id = $2`,
		personID, tenantID)

	var out PersonPortfolio
	callSuper(t, sf, GetPersonPortfolio, http.MethodGet, "/v1/super/people/"+personID.String(), nil,
		superParam("id", personID.String())).
		expectStatus(http.StatusOK).decode(&out)
	if out.Person.CafesOnboarded != 0 {
		t.Errorf("cafes_onboarded = %d, want 0 for a soft-deleted tenant", out.Person.CafesOnboarded)
	}
}

// console_access must reflect platform_admins, NOT mere presence in the
// registry — adding an agent must never be mistaken for granting them access.
func TestListPeople_ConsoleAccessTracksPlatformAdmins(t *testing.T) {
	sf := newSuperFixture(t)
	userID, email := sf.seedUser("consoleuser")
	linked := createPerson(t, sf, map[string]any{"name": "Linked", "kind": "admin", "email": email})
	agent := sf.seedPerson("No Login", "agent")

	read := func() map[uuid.UUID]bool {
		var out struct {
			People []Person `json:"people"`
		}
		callSuper(t, sf, ListPeople, http.MethodGet, "/v1/super/people", nil).
			expectStatus(http.StatusOK).decode(&out)
		m := map[uuid.UUID]bool{}
		for _, p := range out.People {
			m[p.ID] = p.ConsoleAccess
		}
		return m
	}

	got := read()
	if got[linked] {
		t.Error("a linked user who is not a platform admin must not report console access")
	}
	if got[agent] {
		t.Error("an agent with no user row must not report console access")
	}

	sf.adminExec(`INSERT INTO platform_admins (user_id, source) VALUES ($1, 'manual')`, userID)
	if !read()[linked] {
		t.Error("console access should follow platform_admins membership")
	}
}
