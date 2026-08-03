package super

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// Person is one entry in the platform people registry — the humans who onboard
// and look after cafes. Deliberately not an auth surface: an agent with no
// email and no users row is a perfectly valid person (see migration 0057).
type Person struct {
	ID        uuid.UUID  `json:"id"`
	Name      string     `json:"name"`
	Kind      string     `json:"kind"`
	Email     *string    `json:"email,omitempty"`
	Phone     string     `json:"phone"`
	UserID    *uuid.UUID `json:"user_id,omitempty"`
	Active    bool       `json:"active"`
	Notes     string     `json:"notes"`
	CreatedAt time.Time  `json:"created_at"`

	// Derived, so the registry table can be read at a glance.
	CafesOnboarded int  `json:"cafes_onboarded"`
	CafesManaged   int  `json:"cafes_managed"`
	ConsoleAccess  bool `json:"console_access"`
}

var personKinds = map[string]bool{"admin": true, "agent": true, "partner": true}

// personSelect is shared by the list and the single-row read so the two can't
// drift. Counts exclude soft-deleted tenants — a purged cafe shouldn't inflate
// somebody's portfolio.
const personSelect = `
	SELECT pp.id, pp.name, pp.kind, pp.email::text, pp.phone, pp.user_id, pp.active, pp.notes, pp.created_at,
	       (SELECT count(*)::int FROM tenants t
	          WHERE t.onboarded_by_person_id = pp.id AND t.deleted_at IS NULL),
	       (SELECT count(*)::int FROM tenants t
	          WHERE t.relationship_manager_id = pp.id AND t.deleted_at IS NULL),
	       (pp.user_id IS NOT NULL AND EXISTS(SELECT 1 FROM platform_admins pa WHERE pa.user_id = pp.user_id))
	FROM platform_people pp
`

func scanPeople(rows pgx.Rows) ([]Person, error) {
	defer rows.Close()
	out := []Person{}
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.ID, &p.Name, &p.Kind, &p.Email, &p.Phone, &p.UserID,
			&p.Active, &p.Notes, &p.CreatedAt,
			&p.CafesOnboarded, &p.CafesManaged, &p.ConsoleAccess); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListPeople — GET /v1/super/people?include_inactive=1.
//
// Active first, then by name: the common case is picking an RM from this list,
// and a deactivated agent should never be the first thing you see.
func ListPeople(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	where := "WHERE pp.active"
	if r.URL.Query().Get("include_inactive") != "" {
		where = ""
	}
	rows, err := tx.Query(r.Context(), personSelect+where+` ORDER BY pp.active DESC, pp.name`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	people, err := scanPeople(rows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": people})
}

// personInput is the create/update body. Email is a pointer so "field omitted"
// is distinguishable from "explicitly cleared".
type personInput struct {
	Name   string  `json:"name"`
	Kind   string  `json:"kind"`
	Email  *string `json:"email"`
	Phone  string  `json:"phone"`
	Notes  string  `json:"notes"`
	Active *bool   `json:"active"`
}

// normalize validates and cleans an input, returning the email as a *string
// where nil means "no email" (NULL, not empty string — the partial unique index
// depends on that distinction).
func (in *personInput) normalize(w http.ResponseWriter) (email *string, ok bool) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 120 {
		writeErr(w, http.StatusBadRequest, "bad_request", "name must be 1–120 characters")
		return nil, false
	}
	if in.Kind == "" {
		in.Kind = "agent"
	}
	if !personKinds[in.Kind] {
		writeErr(w, http.StatusBadRequest, "bad_request", "kind must be admin, agent or partner")
		return nil, false
	}
	in.Phone = strings.TrimSpace(in.Phone)
	if in.Email != nil {
		e := strings.ToLower(strings.TrimSpace(*in.Email))
		if e == "" {
			return nil, true // explicitly cleared → NULL
		}
		if !strings.Contains(e, "@") {
			writeErr(w, http.StatusBadRequest, "bad_request", "email must be a valid address, or blank")
			return nil, false
		}
		return &e, true
	}
	return nil, true
}

// isUniqueViolation reports a 23505, so a duplicate email becomes a 409 rather
// than a 500 with a raw constraint name in the body.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// CreatePerson — POST /v1/super/people.
//
// When the email matches an existing user we link them automatically. That link
// is what lets the console offer "grant console access" without asking for the
// address a second time — it does NOT itself grant anything.
func CreatePerson(w http.ResponseWriter, r *http.Request) {
	var in personInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	email, ok := in.normalize(w)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())

	var userID *uuid.UUID
	if email != nil {
		var id uuid.UUID
		switch err := tx.QueryRow(r.Context(), `SELECT id FROM users WHERE email = $1`, *email).Scan(&id); {
		case err == nil:
			userID = &id
		case errors.Is(err, pgx.ErrNoRows): // fine — they've never signed in
		default:
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	var id uuid.UUID
	err := tx.QueryRow(r.Context(), `
		INSERT INTO platform_people (name, kind, email, phone, user_id, notes)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id
	`, in.Name, in.Kind, email, in.Phone, userID, in.Notes).Scan(&id)
	if isUniqueViolation(err) {
		writeErr(w, http.StatusConflict, "person_exists", "someone with that email is already in the registry")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	logPlatform(r, tx, audit.PlatformEntry{Action: "person.create", TargetID: id.String(),
		Summary: "added " + in.Name + " to the people registry",
		Meta:    map[string]any{"kind": in.Kind, "linked_user": userID != nil}})
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// UpdatePerson — PATCH /v1/super/people/{id}. Includes the active toggle;
// there is no delete. Deactivating keeps historical attribution intact, which
// a delete would blank out across every cafe they ever touched.
func UpdatePerson(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePersonID(w, r)
	if !ok {
		return
	}
	var in personInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	email, ok := in.normalize(w)
	if !ok {
		return
	}
	active := true
	if in.Active != nil {
		active = *in.Active
	}

	tx := appctx.Tx(r.Context())
	// Re-resolve the user link on every save: an agent who has since signed in
	// should become linkable without anyone having to notice and re-enter it.
	var userID *uuid.UUID
	if email != nil {
		var uid uuid.UUID
		switch err := tx.QueryRow(r.Context(), `SELECT id FROM users WHERE email = $1`, *email).Scan(&uid); {
		case err == nil:
			userID = &uid
		case errors.Is(err, pgx.ErrNoRows):
		default:
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	ct, err := tx.Exec(r.Context(), `
		UPDATE platform_people
		SET name = $1, kind = $2, email = $3, phone = $4, notes = $5, active = $6, user_id = $7
		WHERE id = $8
	`, in.Name, in.Kind, email, in.Phone, in.Notes, active, userID, id)
	if isUniqueViolation(err) {
		writeErr(w, http.StatusConflict, "person_exists", "someone with that email is already in the registry")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such person")
		return
	}

	summary := "updated " + in.Name
	if !active {
		summary = "deactivated " + in.Name
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "person.update", TargetID: id.String(),
		Summary: summary, Meta: map[string]any{"kind": in.Kind, "active": active}})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// PersonPortfolio is the drill-down for one person: who they are plus the cafes
// they own the relationship for.
type PersonPortfolio struct {
	Person   Person          `json:"person"`
	Cafes    []PortfolioCafe `json:"cafes"`
	Onboards []PortfolioCafe `json:"onboards"`
}

// PortfolioCafe is a thin cafe reference — enough to render a row and link out.
type PortfolioCafe struct {
	TenantID    uuid.UUID  `json:"tenant_id"`
	Slug        string     `json:"slug"`
	Name        string     `json:"name"`
	Status      string     `json:"status"`
	PlanName    *string    `json:"plan_name,omitempty"`
	OnboardedOn *time.Time `json:"onboarded_on,omitempty"`
}

// GetPersonPortfolio — GET /v1/super/people/{id}.
func GetPersonPortfolio(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePersonID(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())

	rows, err := tx.Query(r.Context(), personSelect+` WHERE pp.id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	people, err := scanPeople(rows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if len(people) == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such person")
		return
	}

	load := func(column string) ([]PortfolioCafe, error) {
		// column is a fixed literal chosen below, never user input.
		rows, err := tx.Query(r.Context(), `
			SELECT t.id, t.slug, t.name, t.status, p.name, t.onboarded_on
			FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id
			WHERE t.`+column+` = $1 AND t.deleted_at IS NULL
			ORDER BY t.created_at DESC
		`, id)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []PortfolioCafe{}
		for rows.Next() {
			var c PortfolioCafe
			if err := rows.Scan(&c.TenantID, &c.Slug, &c.Name, &c.Status, &c.PlanName, &c.OnboardedOn); err != nil {
				return nil, err
			}
			out = append(out, c)
		}
		return out, rows.Err()
	}

	managed, err := load("relationship_manager_id")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	onboarded, err := load("onboarded_by_person_id")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, PersonPortfolio{Person: people[0], Cafes: managed, Onboards: onboarded})
}

// actingPersonID resolves the signed-in admin to their registry row, if they
// have one. Used as the default onboarder: whoever provisions a cafe owns the
// relationship until somebody says otherwise, which beats leaving it blank and
// hoping the platform_audit trail gets mined later.
//
// Returns nil (not an error) when the admin has no person row — the registry is
// optional, and provisioning must never fail because of a missing one.
func actingPersonID(ctx context.Context, tx pgx.Tx, actorID uuid.UUID) *uuid.UUID {
	if actorID == uuid.Nil {
		return nil
	}
	var id uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM platform_people WHERE user_id = $1 AND active`, actorID).Scan(&id); err != nil {
		return nil
	}
	return &id
}

func parsePersonID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return uuid.Nil, false
	}
	return id, true
}
