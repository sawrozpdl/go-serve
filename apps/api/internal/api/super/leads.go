package super

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// Leads are the pipeline BEFORE a cafe exists — see migration 0061. A lead is
// one cafe-in-conversation owned by a platform_people row; winning it either
// provisions a tenant (ConvertLead) or attaches to one that already exists
// (LinkLead), and in both cases the tenant inherits the lead's attribution.
//
// The public request-access form writes here too (source='request_access'), so
// this is also the inbound queue that /super/requests used to be.

// Lead is the wire shape. Dates that the UI edits with a date input are
// rendered as YYYY-MM-DD strings rather than timestamps — next_follow_up_at is
// a DATE in the database, and marshalling it as RFC3339 would invite a timezone
// shift on a value that has no time in it.
type Lead struct {
	ID            uuid.UUID  `json:"id"`
	CafeName      string     `json:"cafe_name"`
	ContactName   string     `json:"contact_name"`
	Email         *string    `json:"email,omitempty"`
	Phone         string     `json:"phone"`
	Source        string     `json:"source"`
	DesiredPlan   string     `json:"desired_plan"`
	ExpectedSeats *int       `json:"expected_seats,omitempty"`
	Message       string     `json:"message"`
	Stage         string     `json:"stage"`
	OwnerPersonID *uuid.UUID `json:"owner_person_id,omitempty"`
	OwnerName     string     `json:"owner_name"`

	NextFollowUpAt    *string    `json:"next_follow_up_at,omitempty"`
	LostReason        string     `json:"lost_reason"`
	ConvertedTenantID *uuid.UUID `json:"converted_tenant_id,omitempty"`
	ConvertedSlug     *string    `json:"converted_slug,omitempty"`
	ConvertedName     *string    `json:"converted_name,omitempty"`
	ClosedAt          *time.Time `json:"closed_at,omitempty"`

	Notes     string    `json:"notes"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// Derived, so the board can be read without opening every row.
	ActivityCount  int        `json:"activity_count"`
	LastActivityAt *time.Time `json:"last_activity_at,omitempty"`
}

// LeadActivity is one entry in a lead's timeline. 'stage_change' rows are
// written by the handlers, never by a user.
type LeadActivity struct {
	ID         uuid.UUID `json:"id"`
	Kind       string    `json:"kind"`
	Body       string    `json:"body"`
	OccurredAt time.Time `json:"occurred_at"`
	AuthorName string    `json:"author_name"`
	CreatedAt  time.Time `json:"created_at"`
}

// LeadDetail is the drill-down: the lead plus everything that happened to it.
type LeadDetail struct {
	Lead       Lead           `json:"lead"`
	Activities []LeadActivity `json:"activities"`
}

// The stage vocabulary, ordered. Anything past 'negotiating' is closed.
var leadStages = []string{"new", "contacted", "demo", "negotiating", "won", "lost"}

// Same value set as tenants.acquisition_source, so ConvertLead copies the
// lead's source straight across with no mapping.
var leadSources = acquisitionSources

// Kinds a human may log. 'stage_change' is deliberately absent — the timeline
// would stop being trustworthy if anyone could forge one.
var leadActivityKinds = map[string]bool{
	"call": true, "visit": true, "message": true, "demo": true, "note": true,
}

func leadStageValid(s string) bool {
	for _, v := range leadStages {
		if v == s {
			return true
		}
	}
	return false
}

// leadClosed reports whether a stage is terminal. Both closed stages are
// off-limits to the ordinary update path: 'won' is only reachable via
// convert/link, and reopening either would strand converted_tenant_id.
func leadClosed(stage string) bool { return stage == "won" || stage == "lost" }

// leadSelect is shared by the list and the single-row read so the two can't
// drift, exactly as personSelect is.
const leadSelect = `
	SELECT l.id, l.cafe_name, l.contact_name, l.email::text, l.phone, l.source,
	       l.desired_plan, l.expected_seats, l.message, l.stage,
	       l.owner_person_id, COALESCE(pp.name, ''),
	       to_char(l.next_follow_up_at, 'YYYY-MM-DD'),
	       l.lost_reason, l.converted_tenant_id, t.slug, t.name, l.closed_at,
	       l.notes, l.created_at, l.updated_at,
	       (SELECT count(*)::int FROM platform_lead_activities a WHERE a.lead_id = l.id),
	       (SELECT max(a.occurred_at)  FROM platform_lead_activities a WHERE a.lead_id = l.id)
	FROM platform_leads l
	LEFT JOIN platform_people pp ON pp.id = l.owner_person_id
	LEFT JOIN tenants t          ON t.id  = l.converted_tenant_id
`

func scanLeads(rows pgx.Rows) ([]Lead, error) {
	defer rows.Close()
	out := []Lead{}
	for rows.Next() {
		var l Lead
		if err := rows.Scan(&l.ID, &l.CafeName, &l.ContactName, &l.Email, &l.Phone, &l.Source,
			&l.DesiredPlan, &l.ExpectedSeats, &l.Message, &l.Stage,
			&l.OwnerPersonID, &l.OwnerName, &l.NextFollowUpAt,
			&l.LostReason, &l.ConvertedTenantID, &l.ConvertedSlug, &l.ConvertedName, &l.ClosedAt,
			&l.Notes, &l.CreatedAt, &l.UpdatedAt,
			&l.ActivityCount, &l.LastActivityAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// leadFilters turns the query string into SQL. The stage clause is kept apart
// from the rest because the stage COUNTS must ignore it — otherwise clicking
// one stage chip would zero every other chip and you could never see where the
// pipeline actually sits.
type leadFilters struct {
	base     []string
	args     []any
	stages   []string // explicit stage list, when the caller named one
	openOnly bool     // otherwise: hide closed leads unless include_closed
}

func (f *leadFilters) add(clause string, arg any) {
	f.args = append(f.args, arg)
	f.base = append(f.base, fmt.Sprintf(clause, len(f.args)))
}

// where renders the clauses and their args together, so the placeholder numbers
// and the arg slice can't fall out of step.
func (f *leadFilters) where(withStage bool) (string, []any) {
	clauses := append([]string{}, f.base...)
	args := append([]any{}, f.args...)
	if withStage {
		switch {
		case len(f.stages) > 0:
			args = append(args, f.stages)
			clauses = append(clauses, fmt.Sprintf("l.stage = ANY($%d)", len(args)))
		case f.openOnly:
			clauses = append(clauses, "l.stage NOT IN ('won','lost')")
		}
	}
	if len(clauses) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func parseLeadFilters(r *http.Request) *leadFilters {
	q := r.URL.Query()
	f := &leadFilters{}

	if s := strings.TrimSpace(q.Get("source")); s != "" {
		f.add("l.source = $%d", s)
	}
	switch owner := strings.TrimSpace(q.Get("owner_person_id")); owner {
	case "":
	case "none":
		f.base = append(f.base, "l.owner_person_id IS NULL")
	default:
		if id, err := uuid.Parse(owner); err == nil {
			f.add("l.owner_person_id = $%d", id)
		}
	}
	if s := strings.TrimSpace(q.Get("q")); s != "" {
		// One arg, four columns — ILIKE over the whole contact block is what
		// somebody typing half a cafe name actually means.
		f.args = append(f.args, "%"+s+"%")
		n := len(f.args)
		f.base = append(f.base, fmt.Sprintf(
			"(l.cafe_name ILIKE $%d OR l.contact_name ILIKE $%d OR l.email::text ILIKE $%d OR l.phone ILIKE $%d)",
			n, n, n, n))
	}
	// Follow-up windows are evaluated against CURRENT_DATE in Postgres rather
	// than a Go-side date, so "today" means today in the database's timezone
	// and can't disagree with what the digest query sees.
	switch q.Get("due") {
	case "overdue":
		f.base = append(f.base, "l.next_follow_up_at < CURRENT_DATE AND l.stage NOT IN ('won','lost')")
	case "today":
		f.base = append(f.base, "l.next_follow_up_at <= CURRENT_DATE AND l.stage NOT IN ('won','lost')")
	case "week":
		f.base = append(f.base, "l.next_follow_up_at <= CURRENT_DATE + 7 AND l.stage NOT IN ('won','lost')")
	}

	// Stage: an explicit list wins; otherwise hide closed leads unless asked.
	if stages := q["stage"]; len(stages) > 0 {
		f.stages = stages
	} else {
		f.openOnly = q.Get("include_closed") == ""
	}
	return f
}

// ListLeads — GET /v1/super/leads.
//
// Filters: stage (repeatable), source, owner_person_id (or "none"), due
// (overdue|today|week), q, include_closed. Returns the rows plus a stage→count
// facet computed in the same request, so the board header cannot disagree with
// the board.
func ListLeads(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	f := parseLeadFilters(r)

	listWhere, listArgs := f.where(true)
	rows, err := tx.Query(r.Context(), leadSelect+listWhere+`
		ORDER BY (l.stage IN ('won','lost')), l.next_follow_up_at NULLS LAST, l.created_at DESC
	`, listArgs...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	leads, err := scanLeads(rows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	counts := map[string]int{}
	for _, s := range leadStages {
		counts[s] = 0
	}
	countWhere, countArgs := f.where(false)
	cRows, err := tx.Query(r.Context(),
		`SELECT l.stage, count(*)::int FROM platform_leads l`+countWhere+` GROUP BY l.stage`,
		countArgs...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer cRows.Close()
	for cRows.Next() {
		var stage string
		var n int
		if err := cRows.Scan(&stage, &n); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		counts[stage] = n
	}
	if err := cRows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"leads": leads, "counts": counts})
}

// leadInput is the create/update body. Email and NextFollowUpAt are pointers so
// "field omitted" stays distinguishable from "explicitly cleared".
type leadInput struct {
	CafeName       string     `json:"cafe_name"`
	ContactName    string     `json:"contact_name"`
	Email          *string    `json:"email"`
	Phone          string     `json:"phone"`
	Source         string     `json:"source"`
	DesiredPlan    string     `json:"desired_plan"`
	ExpectedSeats  *int       `json:"expected_seats"`
	Message        string     `json:"message"`
	Notes          string     `json:"notes"`
	OwnerPersonID  *uuid.UUID `json:"owner_person_id"`
	NextFollowUpAt *string    `json:"next_follow_up_at"`
	Stage          string     `json:"stage"`
	LostReason     string     `json:"lost_reason"`
}

// normalized is the cleaned form of a leadInput: nil email means NULL (not the
// empty string — the partial unique index depends on that), and nil follow-up
// means no date.
type normalizedLead struct {
	email    *string
	followUp *string
}

func (in *leadInput) normalize(w http.ResponseWriter) (normalizedLead, bool) {
	var out normalizedLead

	in.CafeName = strings.TrimSpace(in.CafeName)
	if in.CafeName == "" || len(in.CafeName) > 120 {
		writeErr(w, http.StatusBadRequest, "bad_request", "cafe name must be 1–120 characters")
		return out, false
	}
	in.ContactName = strings.TrimSpace(in.ContactName)
	if len(in.ContactName) > 120 {
		writeErr(w, http.StatusBadRequest, "bad_request", "contact name must be 120 characters or fewer")
		return out, false
	}
	in.Phone = strings.TrimSpace(in.Phone)

	if in.Email != nil {
		e := strings.ToLower(strings.TrimSpace(*in.Email))
		if e != "" {
			if !strings.Contains(e, "@") {
				writeErr(w, http.StatusBadRequest, "bad_request", "email must be a valid address, or blank")
				return out, false
			}
			out.email = &e
		}
	}
	// A lead an agent picked up on foot may be a shop name and a phone number.
	// But with neither there is no way to ever contact them, which makes the
	// row useless rather than merely sparse.
	if out.email == nil && in.Phone == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "give at least an email or a phone number")
		return out, false
	}

	if in.Source == "" {
		in.Source = "outbound"
	}
	if !leadSources[in.Source] {
		writeErr(w, http.StatusBadRequest, "bad_request", "unknown lead source")
		return out, false
	}
	if in.ExpectedSeats != nil && *in.ExpectedSeats <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "expected seats must be a positive number, or blank")
		return out, false
	}
	if len(in.Message) > 2000 || len(in.Notes) > 4000 {
		writeErr(w, http.StatusBadRequest, "bad_request", "one of the fields is too long")
		return out, false
	}
	in.DesiredPlan = strings.TrimSpace(in.DesiredPlan)
	in.LostReason = strings.TrimSpace(in.LostReason)
	if len(in.LostReason) > 500 {
		writeErr(w, http.StatusBadRequest, "bad_request", "lost reason must be 500 characters or fewer")
		return out, false
	}

	if in.NextFollowUpAt != nil {
		if s := strings.TrimSpace(*in.NextFollowUpAt); s != "" {
			d, ok := parseDateOnly(s)
			if !ok {
				writeErr(w, http.StatusBadRequest, "bad_request", "follow-up date must be YYYY-MM-DD")
				return out, false
			}
			out.followUp = &d
		}
	}
	return out, true
}

// CreateLead — POST /v1/super/leads.
//
// The owner defaults to the acting admin's registry row, matching CreateTenant:
// whoever enters a lead is working it until somebody says otherwise, which
// beats leaving it unassigned and hoping the attention queue catches it.
func CreateLead(w http.ResponseWriter, r *http.Request) {
	var in leadInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	norm, ok := in.normalize(w)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())
	actor, _ := appctx.UserFromContext(r.Context())

	// Validate up front so a bad id is a 400, not an FK 500.
	if _, ok := lookupPersonName(r.Context(), tx, w, in.OwnerPersonID); !ok {
		return
	}
	owner := in.OwnerPersonID
	if owner == nil {
		owner = actingPersonID(r.Context(), tx, actor.ID)
	}

	var id uuid.UUID
	err := tx.QueryRow(r.Context(), `
		INSERT INTO platform_leads (
			cafe_name, contact_name, email, phone, source, desired_plan, expected_seats,
			message, notes, owner_person_id, next_follow_up_at, created_by_user_id
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12)
		RETURNING id
	`, in.CafeName, in.ContactName, norm.email, in.Phone, in.Source, in.DesiredPlan,
		in.ExpectedSeats, in.Message, in.Notes, owner, norm.followUp, nullableUser(actor.ID)).Scan(&id)
	if isUniqueViolation(err) {
		writeErr(w, http.StatusConflict, "lead_exists",
			"there is already an open lead with that email — find it in the pipeline instead of starting a second one")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	logPlatform(r, tx, audit.PlatformEntry{Action: "lead.create", TargetID: id.String(),
		Summary: "added lead " + in.CafeName,
		Meta:    map[string]any{"source": in.Source, "assigned": owner != nil}})
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// GetLead — GET /v1/super/leads/{id}.
func GetLead(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())

	rows, err := tx.Query(r.Context(), leadSelect+` WHERE l.id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	leads, err := scanLeads(rows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if len(leads) == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such lead")
		return
	}

	acts, err := loadLeadActivities(r.Context(), tx, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, LeadDetail{Lead: leads[0], Activities: acts})
}

func loadLeadActivities(ctx context.Context, tx pgx.Tx, leadID uuid.UUID) ([]LeadActivity, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.id, a.kind, a.body,
		       a.occurred_at,
		       COALESCE(NULLIF(btrim(u.name), ''), u.email::text, ''),
		       a.created_at
		FROM platform_lead_activities a
		LEFT JOIN users u ON u.id = a.author_user_id
		WHERE a.lead_id = $1
		ORDER BY a.occurred_at DESC, a.created_at DESC
	`, leadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LeadActivity{}
	for rows.Next() {
		var a LeadActivity
		if err := rows.Scan(&a.ID, &a.Kind, &a.Body, &a.OccurredAt, &a.AuthorName, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// logStageChange records a move on the timeline. Best-effort in the same tx as
// the move itself, so the two commit or roll back together.
func logStageChange(ctx context.Context, tx pgx.Tx, leadID uuid.UUID, actorID uuid.UUID, from, to, detail string) error {
	body := from + " → " + to
	if detail != "" {
		body += " · " + detail
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO platform_lead_activities (lead_id, kind, body, author_user_id)
		VALUES ($1, 'stage_change', $2, $3)
	`, leadID, body, nullableUser(actorID))
	return err
}

// nullableUser turns the zero uuid into a SQL NULL. Every users FK on these
// tables is ON DELETE SET NULL and nullable; passing uuid.Nil would fail the
// constraint rather than record "nobody in particular".
func nullableUser(id uuid.UUID) any {
	if id == uuid.Nil {
		return nil
	}
	return id
}

// loadLeadForWrite reads the mutable state a write path needs to reason about,
// locking the row so two admins can't both convert the same lead.
type leadRow struct {
	stage    string
	cafeName string
	contact  string
	email    *string
	phone    string
	source   string
	plan     string
	owner    *uuid.UUID
}

func loadLeadForWrite(ctx context.Context, tx pgx.Tx, id uuid.UUID) (leadRow, error) {
	var l leadRow
	err := tx.QueryRow(ctx, `
		SELECT stage, cafe_name, contact_name, email::text, phone, source, desired_plan, owner_person_id
		FROM platform_leads WHERE id = $1 FOR UPDATE
	`, id).Scan(&l.stage, &l.cafeName, &l.contact, &l.email, &l.phone, &l.source, &l.plan, &l.owner)
	return l, err
}

// UpdateLead — PATCH /v1/super/leads/{id}.
//
// Stage moves live here EXCEPT the two that need a cafe: 'won' is reachable
// only through convert/link, so a won lead always has one, and neither closed
// stage can be reopened (converted_tenant_id would be stranded, and a lost lead
// re-entering the pipeline should be a new lead with its own history).
func UpdateLead(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var in leadInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	norm, ok := in.normalize(w)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())
	actor, _ := appctx.UserFromContext(r.Context())

	cur, err := loadLeadForWrite(r.Context(), tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "no such lead")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if _, ok := lookupPersonName(r.Context(), tx, w, in.OwnerPersonID); !ok {
		return
	}

	stage := in.Stage
	if stage == "" {
		stage = cur.stage
	}
	if !leadStageValid(stage) {
		writeErr(w, http.StatusBadRequest, "bad_request", "unknown stage")
		return
	}
	if stage != cur.stage {
		if leadClosed(cur.stage) {
			writeErr(w, http.StatusConflict, "already_closed",
				"this lead is closed — start a fresh lead rather than reopening it")
			return
		}
		if stage == "won" {
			writeErr(w, http.StatusConflict, "use_convert",
				"win a lead by converting it to a cafe, or linking it to an existing one")
			return
		}
		if stage == "lost" && in.LostReason == "" {
			writeErr(w, http.StatusBadRequest, "lost_reason_required", "say why this lead was lost")
			return
		}
	}
	// Keep the reason attached to the stage it explains: clearing 'lost' isn't
	// possible, but a lead that was never lost must not carry one.
	if stage != "lost" {
		in.LostReason = ""
	}

	ct, err := tx.Exec(r.Context(), `
		UPDATE platform_leads SET
			cafe_name = $2, contact_name = $3, email = $4, phone = $5, source = $6,
			desired_plan = $7, expected_seats = $8, message = $9, notes = $10,
			owner_person_id = $11, next_follow_up_at = $12::date,
			stage = $13, lost_reason = $14,
			closed_at = CASE WHEN $13 = 'lost' THEN COALESCE(closed_at, now()) ELSE closed_at END
		WHERE id = $1
	`, id, in.CafeName, in.ContactName, norm.email, in.Phone, in.Source,
		in.DesiredPlan, in.ExpectedSeats, in.Message, in.Notes,
		in.OwnerPersonID, norm.followUp, stage, in.LostReason)
	if isUniqueViolation(err) {
		writeErr(w, http.StatusConflict, "lead_exists", "another open lead already uses that email")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such lead")
		return
	}

	action := "lead.update"
	summary := "updated lead " + in.CafeName
	if stage != cur.stage {
		if err := logStageChange(r.Context(), tx, id, actor.ID, cur.stage, stage, in.LostReason); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		action = "lead.stage"
		summary = in.CafeName + ": " + cur.stage + " → " + stage
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: action, TargetID: id.String(), Summary: summary,
		Meta: map[string]any{"stage": stage, "source": in.Source}})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// LogLeadActivity — POST /v1/super/leads/{id}/activities
//
//	body: {kind, body, occurred_at?, next_follow_up_at?}
//
// The optional follow-up date is set in the same transaction on purpose:
// logging a call and booking the next one is one action for a field agent, and
// splitting it into two requests is how follow-ups get forgotten.
func LogLeadActivity(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		Kind           string  `json:"kind"`
		Body           string  `json:"body"`
		OccurredAt     *string `json:"occurred_at"`
		NextFollowUpAt *string `json:"next_follow_up_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.Kind == "" {
		body.Kind = "note"
	}
	if !leadActivityKinds[body.Kind] {
		writeErr(w, http.StatusBadRequest, "bad_request", "kind must be call, visit, message, demo or note")
		return
	}
	body.Body = strings.TrimSpace(body.Body)
	if body.Body == "" || len(body.Body) > 2000 {
		writeErr(w, http.StatusBadRequest, "bad_request", "say what happened, in 1–2000 characters")
		return
	}
	var occurred *time.Time
	if body.OccurredAt != nil && strings.TrimSpace(*body.OccurredAt) != "" {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(*body.OccurredAt))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "occurred_at must be an RFC3339 timestamp")
			return
		}
		occurred = &t
	}
	var followUp *string
	if body.NextFollowUpAt != nil {
		if s := strings.TrimSpace(*body.NextFollowUpAt); s != "" {
			d, ok := parseDateOnly(s)
			if !ok {
				writeErr(w, http.StatusBadRequest, "bad_request", "follow-up date must be YYYY-MM-DD")
				return
			}
			followUp = &d
		}
	}

	tx := appctx.Tx(r.Context())
	actor, _ := appctx.UserFromContext(r.Context())

	var actID uuid.UUID
	err := tx.QueryRow(r.Context(), `
		INSERT INTO platform_lead_activities (lead_id, kind, body, occurred_at, author_user_id)
		SELECT $1, $2, $3, COALESCE($4::timestamptz, now()), $5
		WHERE EXISTS (SELECT 1 FROM platform_leads WHERE id = $1)
		RETURNING id
	`, id, body.Kind, body.Body, occurred, nullableUser(actor.ID)).Scan(&actID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "no such lead")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Only touch the date when the caller sent the field at all — an omitted
	// next_follow_up_at must not silently clear a booked one.
	if body.NextFollowUpAt != nil {
		if _, err := tx.Exec(r.Context(),
			`UPDATE platform_leads SET next_follow_up_at = $2::date WHERE id = $1`, id, followUp); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	logPlatform(r, tx, audit.PlatformEntry{Action: "lead.activity", TargetID: id.String(),
		Summary: "logged a " + body.Kind + ": " + audit.Truncate(body.Body, 80),
		Meta:    map[string]any{"kind": body.Kind}})
	writeJSON(w, http.StatusCreated, map[string]any{"id": actID})
}

// ConvertLead — POST /v1/super/leads/{id}/convert
//
//	body: {slug?, timezone?, plan_key?, owner_email?}
//
// Provisions a cafe from the lead and hands the relationship straight over: the
// lead's owner becomes onboarded_by_person_id (and, through provisionTenant's
// seed-from-onboarder rule, the relationship manager), and the lead's source
// becomes acquisition_source. That inheritance is the whole point of the
// pipeline — it's what turns a market agent's work into attribution.
func ConvertLead(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := parseID(w, r)
		if !ok {
			return
		}
		var body struct {
			Slug       string `json:"slug"`
			Timezone   string `json:"timezone"`
			PlanKey    string `json:"plan_key"`
			OwnerEmail string `json:"owner_email"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body) // all optional

		tx := appctx.Tx(r.Context())
		actor, _ := appctx.UserFromContext(r.Context())

		lead, err := loadLeadForWrite(r.Context(), tx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "no such lead")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if leadClosed(lead.stage) {
			writeErr(w, http.StatusConflict, "already_closed", "this lead has already been closed")
			return
		}

		// A phone-only lead has no address to invite; ask for one rather than
		// provisioning a cafe whose owner can never log in.
		ownerEmail := strings.ToLower(strings.TrimSpace(body.OwnerEmail))
		if ownerEmail == "" && lead.email != nil {
			ownerEmail = *lead.email
		}
		if ownerEmail == "" || !strings.Contains(ownerEmail, "@") {
			writeErr(w, http.StatusBadRequest, "owner_email_required",
				"this lead has no email — supply the owner's address to provision their cafe")
			return
		}

		planKey := strings.TrimSpace(body.PlanKey)
		if planKey == "" {
			planKey = lead.plan
		}
		onboarder := lead.owner
		if onboarder == nil {
			onboarder = actingPersonID(r.Context(), tx, actor.ID)
		}

		tenantID, slug, err := provisionTenant(r.Context(), tx, repo, actor.ID, ProvisionParams{
			Name: lead.cafeName, Slug: body.Slug, Timezone: body.Timezone,
			OwnerEmail: ownerEmail, OwnerName: lead.contact, PlanKey: planKey, Phone: lead.phone,
			OnboardedBy:       onboarder,
			AcquisitionSource: lead.source,
			SourceLeadID:      &id,
		})
		if errors.Is(err, errSlugTaken) {
			writeErr(w, http.StatusConflict, "slug_taken", "that slug is already taken — pass a different one")
			return
		}
		if errors.Is(err, errInvalidSlug) {
			writeErr(w, http.StatusBadRequest, "invalid_slug",
				"Slug must be 2–63 characters: lowercase letters, numbers and hyphens only (e.g. my-cafe). Leave it blank to derive it from the name.")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// provisionTenant re-scoped app.tenant_id to the new cafe, but
		// platform_leads is a global table with no RLS, so this still applies.
		if _, err := tx.Exec(r.Context(), `
			UPDATE platform_leads
			SET stage = 'won', converted_tenant_id = $2, closed_at = now(), owner_person_id = COALESCE(owner_person_id, $3)
			WHERE id = $1
		`, id, tenantID, onboarder); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if err := logStageChange(r.Context(), tx, id, actor.ID, lead.stage, "won", "provisioned "+slug); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		logPlatform(r, tx, audit.PlatformEntry{Action: "lead.convert", TargetTenantID: &tenantID,
			TargetID: id.String(), Summary: "converted lead " + lead.cafeName + " → " + slug,
			Meta: map[string]any{"source": lead.source, "plan": planKey}})
		writeJSON(w, http.StatusOK, map[string]any{"tenant_id": tenantID, "slug": slug})
	}
}

// LinkLead — POST /v1/super/leads/{id}/link  body: {tenant_id}.
//
// For the cafe that was created some other way before anyone closed the lead.
// The relationship fields are filled in only where they are still BLANK: a
// deliberately-assigned relationship manager must survive somebody tidying up
// the pipeline weeks later.
func LinkLead(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var body struct {
		TenantID uuid.UUID `json:"tenant_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if body.TenantID == uuid.Nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "pick a cafe to link this lead to")
		return
	}

	tx := appctx.Tx(r.Context())
	actor, _ := appctx.UserFromContext(r.Context())

	lead, err := loadLeadForWrite(r.Context(), tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "no such lead")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if leadClosed(lead.stage) {
		writeErr(w, http.StatusConflict, "already_closed", "this lead has already been closed")
		return
	}

	var slug string
	switch err := tx.QueryRow(r.Context(),
		`SELECT slug FROM tenants WHERE id = $1 AND deleted_at IS NULL`, body.TenantID).Scan(&slug); {
	case err == nil:
	case errors.Is(err, pgx.ErrNoRows):
		writeErr(w, http.StatusNotFound, "not_found", "no such cafe")
		return
	default:
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE platform_leads
		SET stage = 'won', converted_tenant_id = $2, closed_at = now()
		WHERE id = $1
	`, id, body.TenantID); err != nil {
		if isUniqueViolation(err) {
			writeErr(w, http.StatusConflict, "tenant_already_linked",
				"another lead is already linked to that cafe")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// COALESCE, not assignment: never clobber an RM somebody chose on purpose.
	// acquisition_source only moves off its 'direct' default for the same
	// reason — 'direct' is what a cafe gets when nobody said otherwise.
	if _, err := tx.Exec(r.Context(), `
		UPDATE tenants SET
			onboarded_by_person_id  = COALESCE(onboarded_by_person_id,  $2),
			relationship_manager_id = COALESCE(relationship_manager_id, $2),
			acquisition_source      = CASE WHEN acquisition_source = 'direct' THEN $3 ELSE acquisition_source END,
			source_lead_id          = $4
		WHERE id = $1 AND deleted_at IS NULL
	`, body.TenantID, lead.owner, lead.source, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if err := logStageChange(r.Context(), tx, id, actor.ID, lead.stage, "won", "linked to "+slug); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "lead.link", TargetTenantID: &body.TenantID,
		TargetID: id.String(), Summary: "linked lead " + lead.cafeName + " → " + slug})
	writeJSON(w, http.StatusOK, map[string]any{"tenant_id": body.TenantID, "slug": slug})
}
