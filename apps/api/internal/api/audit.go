package api

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// Wire types
// =========================================================================

type AuditEvent struct {
	ID         uuid.UUID  `json:"id"`
	ActorID    *uuid.UUID `json:"actor_id,omitempty"`
	ActorName  string     `json:"actor_name"`
	ActorEmail string     `json:"actor_email"`
	RoleSnap   []string   `json:"role_snap"`
	Action     string     `json:"action"`
	Entity     string     `json:"entity"`
	EntityID   *uuid.UUID `json:"entity_id,omitempty"`
	Summary    string     `json:"summary"`
	IP         *string    `json:"ip,omitempty"`
	RequestID  string     `json:"request_id"`
	CreatedAt  time.Time  `json:"created_at"`
}

type AuditActor struct {
	ActorID    *uuid.UUID `json:"actor_id,omitempty"`
	ActorName  string     `json:"actor_name"`
	ActorEmail string     `json:"actor_email"`
}

// ListAuditEvents returns paginated audit_log rows for the active tenant.
// Owner/manager only.
//
// Query params:
//
//	actor    repeatable, uuid     filter by actor_id
//	entity   repeatable, text     filter by entity (expense|order|...)
//	action   repeatable, text     filter by action (create|update|delete|...)
//	from     RFC3339              created_at >= from
//	to       RFC3339              created_at <= to
//	q        text                 ILIKE on summary
//	cursor   base64(ts|id)        keyset pagination cursor
//	limit    int (default 50)     page size, capped at 200
func ListAuditEvents(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())

	q := r.URL.Query()
	args := []any{}
	clauses := []string{"1=1"}

	actors := q["actor"]
	if len(actors) > 0 {
		ids := make([]uuid.UUID, 0, len(actors))
		for _, s := range actors {
			if id, err := uuid.Parse(s); err == nil {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			args = append(args, ids)
			clauses = append(clauses, "actor_id = ANY($"+strconv.Itoa(len(args))+")")
		}
	}
	if entities := q["entity"]; len(entities) > 0 {
		args = append(args, entities)
		clauses = append(clauses, "entity = ANY($"+strconv.Itoa(len(args))+")")
	}
	if actions := q["action"]; len(actions) > 0 {
		args = append(args, actions)
		clauses = append(clauses, "action = ANY($"+strconv.Itoa(len(args))+")")
	}
	if from := q.Get("from"); from != "" {
		if t, err := time.Parse(time.RFC3339, from); err == nil {
			args = append(args, t)
			clauses = append(clauses, "created_at >= $"+strconv.Itoa(len(args)))
		}
	}
	if to := q.Get("to"); to != "" {
		if t, err := time.Parse(time.RFC3339, to); err == nil {
			args = append(args, t)
			clauses = append(clauses, "created_at <= $"+strconv.Itoa(len(args)))
		}
	}
	if qs := strings.TrimSpace(q.Get("q")); qs != "" {
		args = append(args, "%"+qs+"%")
		clauses = append(clauses, "summary ILIKE $"+strconv.Itoa(len(args)))
	}

	// Keyset cursor: base64("RFC3339Nano|uuid"). Strictly < to avoid dupes.
	if cur := q.Get("cursor"); cur != "" {
		if ts, id, ok := decodeAuditCursor(cur); ok {
			args = append(args, ts)
			tsIdx := strconv.Itoa(len(args))
			args = append(args, id)
			idIdx := strconv.Itoa(len(args))
			clauses = append(clauses,
				"(created_at, id) < ($"+tsIdx+", $"+idIdx+")")
		}
	}

	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 200 {
				n = 200
			}
			limit = n
		}
	}
	// Fetch one extra to know whether there's a next page.
	args = append(args, limit+1)
	limitIdx := strconv.Itoa(len(args))

	sql := `
		SELECT id, actor_id, actor_name, actor_email, role_snap,
		       action, entity, entity_id, summary, host(ip), request_id, created_at
		FROM audit_log
		WHERE ` + strings.Join(clauses, " AND ") + `
		ORDER BY created_at DESC, id DESC
		LIMIT $` + limitIdx

	rows, err := tx.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []AuditEvent{}
	for rows.Next() {
		var e AuditEvent
		var ip *string
		if err := rows.Scan(&e.ID, &e.ActorID, &e.ActorName, &e.ActorEmail, &e.RoleSnap,
			&e.Action, &e.Entity, &e.EntityID, &e.Summary, &ip, &e.RequestID, &e.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		e.IP = ip
		out = append(out, e)
	}

	var nextCursor *string
	if len(out) > limit {
		last := out[limit-1]
		cur := encodeAuditCursor(last.CreatedAt, last.ID)
		nextCursor = &cur
		out = out[:limit]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items":       out,
		"next_cursor": nextCursor,
	})
}

// ListAuditActors returns the distinct actors that have written audit rows
// in the active tenant — used to populate the filter dropdown.
func ListAuditActors(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())

	rows, err := tx.Query(r.Context(), `
		SELECT DISTINCT ON (lower(actor_email))
		       actor_id, actor_name, actor_email
		FROM audit_log
		ORDER BY lower(actor_email), actor_id NULLS LAST
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []AuditActor{}
	for rows.Next() {
		var a AuditActor
		if err := rows.Scan(&a.ActorID, &a.ActorName, &a.ActorEmail); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, a)
	}
	writeJSON(w, http.StatusOK, map[string]any{"actors": out})
}

func encodeAuditCursor(ts time.Time, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString(
		[]byte(ts.UTC().Format(time.RFC3339Nano) + "|" + id.String()))
}

func decodeAuditCursor(cur string) (time.Time, uuid.UUID, bool) {
	b, err := base64.RawURLEncoding.DecodeString(cur)
	if err != nil {
		return time.Time{}, uuid.Nil, false
	}
	parts := strings.SplitN(string(b), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, uuid.Nil, false
	}
	ts, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, uuid.Nil, false
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return time.Time{}, uuid.Nil, false
	}
	return ts, id, true
}
