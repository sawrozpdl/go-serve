package api

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PublicPlan is the customer-safe plan shape for the request-access form's
// plan picker. Excludes internal flags.
type PublicPlan struct {
	Key          string `json:"key"`
	Name         string `json:"name"`
	MemberLimit  *int   `json:"member_limit"`
	PriceCopy    string `json:"price_copy"`
	IsEnterprise bool   `json:"is_enterprise"`
}

// ListPublicPlans — GET /public/plans. Active paid tiers (trial is automatic on
// provisioning, so it's omitted from the picker).
func ListPublicPlans(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := pool.Query(r.Context(), `
			SELECT key, name, member_limit, price_copy, is_enterprise
			FROM plans
			WHERE active AND key <> 'trial'
			ORDER BY sort_order, name
		`)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		defer rows.Close()
		out := []PublicPlan{}
		for rows.Next() {
			var p PublicPlan
			if err := rows.Scan(&p.Key, &p.Name, &p.MemberLimit, &p.PriceCopy, &p.IsEnterprise); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			out = append(out, p)
		}
		writeJSON(w, http.StatusOK, map[string]any{"plans": out})
	}
}

// RequestAccess — POST /public/request-access (unauthenticated).
//
//	body: { name, cafe_name, email, phone, desired_plan?, message? }
//
// Captures an inbound lead. A partial unique index allows only one pending
// request per email; a duplicate returns a friendly "already pending" rather
// than an error (and never reveals whether the email is otherwise known).
func RequestAccess(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string `json:"name"`
			CafeName    string `json:"cafe_name"`
			Email       string `json:"email"`
			Phone       string `json:"phone"`
			DesiredPlan string `json:"desired_plan"`
			Message     string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
			return
		}
		name := strings.TrimSpace(body.Name)
		cafe := strings.TrimSpace(body.CafeName)
		email := strings.ToLower(strings.TrimSpace(body.Email))
		phone := strings.TrimSpace(body.Phone)
		if name == "" || cafe == "" || email == "" || !strings.Contains(email, "@") {
			writeErr(w, http.StatusBadRequest, "bad_request", "name, cafe name and a valid email are required")
			return
		}
		if phone == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "a contact phone number is required")
			return
		}
		if len(name) > 120 || len(cafe) > 120 || len(body.Message) > 2000 {
			writeErr(w, http.StatusBadRequest, "bad_request", "one of the fields is too long")
			return
		}

		var ipArg any
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			if ip := net.ParseIP(host); ip != nil {
				ipArg = ip.String()
			}
		}

		_, err := pool.Exec(r.Context(), `
			INSERT INTO tenant_requests (name, cafe_name, email, phone, desired_plan, message, source_ip)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, name, cafe, email, phone,
			strings.TrimSpace(body.DesiredPlan), strings.TrimSpace(body.Message), ipArg)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				writeJSON(w, http.StatusOK, map[string]any{"status": "already_pending"})
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", "could not save your request")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"status": "received"})
	}
}
