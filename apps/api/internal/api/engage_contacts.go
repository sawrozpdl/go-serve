package api

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// =========================================================================
// ENGAGE — opted-in guest contacts (0065)
//
// This is the only PII in the module, which is why it sits behind its own
// permissions (engage:contacts_read / engage:contacts_delete) rather than
// travelling with engage:read. Seeing that a campaign is working and being able
// to export every guest's phone number are different privileges.
//
// There is NO sending here — no mailer, no SMS, no "message all contacts"
// button. v1 collects with consent, exports, and deletes. Anything that blasts
// a list is a different feature with different obligations.
// =========================================================================

type EngageContact struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Email       string    `json:"email"`
	Phone       string    `json:"phone"`
	ConsentAt   time.Time `json:"consent_at"`
	FirstSeenAt time.Time `json:"first_seen_at"`
	LastSeenAt  time.Time `json:"last_seen_at"`
	TimesSeen   int       `json:"times_seen"`
	// ConsentTextVersion identifies the exact wording this guest agreed to. If
	// the copy is ever changed, this is what tells you who consented to what.
	ConsentTextVersion string `json:"consent_text_version"`
}

// listContacts is shared by the JSON list and the CSV export so the two can
// never disagree about who is on the list.
func listContacts(r *http.Request, search string, limit int) ([]EngageContact, error) {
	q := strings.TrimSpace(search)
	rows, err := appctx.Tx(r.Context()).Query(r.Context(), `
		SELECT id, name, email, phone, consent_at, first_seen_at, last_seen_at,
		       times_seen, consent_text_version
		FROM engage_contacts
		WHERE ($1 = '' OR name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%')
		ORDER BY last_seen_at DESC
		LIMIT $2
	`, q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []EngageContact{}
	for rows.Next() {
		var c EngageContact
		if err := rows.Scan(&c.ID, &c.Name, &c.Email, &c.Phone, &c.ConsentAt,
			&c.FirstSeenAt, &c.LastSeenAt, &c.TimesSeen, &c.ConsentTextVersion); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListEngageContacts — GET /v1/engage/contacts?q=&limit=
func ListEngageContacts(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n := parseIntOr(v, 200); n > 0 && n <= 1000 {
			limit = n
		}
	}
	out, err := listContacts(r, r.URL.Query().Get("q"), limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"contacts": out})
}

// csvSafe defuses spreadsheet formula injection.
//
// Excel, Sheets and Numbers all execute a cell beginning with = + - or @, so a
// guest who types `=HYPERLINK("http://evil","click")` as their name would run
// that in the owner's spreadsheet. Prefixing a tab makes the cell inert while
// still reading as the original text.
func csvSafe(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}

// ExportEngageContacts — GET /v1/engage/contacts.csv
// Generated server-side so the export is the whole list rather than whatever
// page the browser happens to be showing, and so the consent columns come from
// the database rather than the UI's idea of them.
func ExportEngageContacts(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())

	// A generous ceiling rather than none: an unbounded export is a memory and
	// egress hazard on a surface whose whole point is bulk personal data.
	contacts, err := listContacts(r, "", 50000)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	filename := fmt.Sprintf("guest-contacts-%s-%s.csv", t.Slug, time.Now().Format("2006-01-02"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	cw := csv.NewWriter(w)
	defer cw.Flush()
	_ = cw.Write([]string{"name", "email", "phone", "consented_at", "consent_version",
		"first_seen", "last_seen", "times_seen"})
	for _, c := range contacts {
		_ = cw.Write([]string{
			csvSafe(c.Name), csvSafe(c.Email), csvSafe(c.Phone),
			c.ConsentAt.Format(time.RFC3339), csvSafe(c.ConsentTextVersion),
			c.FirstSeenAt.Format(time.RFC3339), c.LastSeenAt.Format(time.RFC3339),
			fmt.Sprint(c.TimesSeen),
		})
	}

	// Logged without any of the values: an audit trail for a PII export should
	// record that it happened, not duplicate the data into a second store.
	if err := audit.Log(r.Context(), appctx.Tx(r.Context()), audit.Entry{
		Action: "export", Entity: "engage_contacts",
		Summary: fmt.Sprintf("exported %d guest contacts", len(contacts)),
	}); err != nil {
		// The CSV body is already on the wire, so there is nothing useful to say
		// to the client; surface it in the log instead of corrupting the download.
		appctx.Logger(r.Context()).ErrorContext(r.Context(), "engage.contacts.audit_failed", "error", err)
	}
}

// DeleteEngageContact — DELETE /v1/engage/contacts/{id}.
// A hard delete. "Forget me" has to mean forgotten, so there is no soft-delete
// tombstone holding the address anyway.
func DeleteEngageContact(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid contact id")
		return
	}
	tx := appctx.Tx(r.Context())
	cmd, err := tx.Exec(r.Context(), `DELETE FROM engage_contacts WHERE id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if cmd.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	// The summary names no PII — an audit log that records the email of every
	// deleted contact defeats the deletion.
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "engage_contact", EntityID: &id,
		Summary: "deleted a guest contact",
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeleteAllEngageContacts — DELETE /v1/engage/contacts.
// The "we're done with this list" button. Gated behind a typed confirmation in
// the UI; the handler still requires the slug so a stray request cannot wipe a
// café's list.
func DeleteAllEngageContacts(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	if r.URL.Query().Get("confirm") != t.Slug {
		writeErr(w, http.StatusBadRequest, "confirm_required",
			"pass ?confirm=<slug> to delete every contact")
		return
	}
	tx := appctx.Tx(r.Context())
	cmd, err := tx.Exec(r.Context(), `DELETE FROM engage_contacts`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "engage_contacts",
		Summary: fmt.Sprintf("deleted all %d guest contacts", cmd.RowsAffected()),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": cmd.RowsAffected()})
}

// InvalidateEngageCodes — POST /v1/engage/codes/invalidate.
//
// The "kill everything outstanding" button. Note what it is NOT: there is no QR
// rotation in this module, because the printed URL grants nothing on its own —
// every scan mints a fresh session, so a leaked link is worthless and changing
// it would only brick the café's table tents. What an owner actually needs is a
// way to retire codes already in the wild, which is this.
func InvalidateEngageCodes(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	cmd, err := tx.Exec(r.Context(),
		`UPDATE engage_codes SET status = 'void' WHERE status = 'issued'`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "engage_codes",
		Summary: fmt.Sprintf("invalidated %d outstanding reward code(s)", cmd.RowsAffected()),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"voided": cmd.RowsAffected()})
}

// parseIntOr is a tiny local helper for optional query integers.
func parseIntOr(s string, def int) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return def
		}
		n = n*10 + int(r-'0')
		if n > 1_000_000 {
			return def
		}
	}
	if n == 0 {
		return def
	}
	return n
}
