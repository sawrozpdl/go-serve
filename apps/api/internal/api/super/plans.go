package super

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
)

// Plan is the wire shape for the plan catalog.
type Plan struct {
	ID           uuid.UUID `json:"id"`
	Key          string    `json:"key"`
	Name         string    `json:"name"`
	MemberLimit  *int      `json:"member_limit"`
	PriceCopy    string    `json:"price_copy"`
	IsEnterprise bool      `json:"is_enterprise"`
	SortOrder    int       `json:"sort_order"`
	Active       bool      `json:"active"`
	Features     []string  `json:"features"`
}

func queryPlans(r *http.Request) ([]Plan, error) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT p.id, p.key, p.name, p.member_limit, p.price_copy, p.is_enterprise,
		       p.sort_order, p.active,
		       COALESCE(array_agg(pf.feature_key) FILTER (WHERE pf.feature_key IS NOT NULL), '{}')
		FROM plans p
		LEFT JOIN plan_features pf ON pf.plan_id = p.id
		GROUP BY p.id
		ORDER BY p.sort_order, p.name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Plan{}
	for rows.Next() {
		var p Plan
		if err := rows.Scan(&p.ID, &p.Key, &p.Name, &p.MemberLimit, &p.PriceCopy,
			&p.IsEnterprise, &p.SortOrder, &p.Active, &p.Features); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListPlans — GET /v1/super/plans.
func ListPlans(w http.ResponseWriter, r *http.Request) {
	plans, err := queryPlans(r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plans": plans})
}

// ListFeatureRegistry — GET /v1/super/features. The code-defined feature keys
// the plan editor offers as toggles.
func ListFeatureRegistry(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"features": billing.Registry})
}

type planInput struct {
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	MemberLimit  *int     `json:"member_limit"`
	PriceCopy    string   `json:"price_copy"`
	IsEnterprise bool     `json:"is_enterprise"`
	SortOrder    int      `json:"sort_order"`
	Active       *bool    `json:"active"`
	Features     []string `json:"features"`
}

// CreatePlan — POST /v1/super/plans.
func CreatePlan(w http.ResponseWriter, r *http.Request) {
	var in planInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if in.Key == "" || in.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "key and name are required")
		return
	}
	if bad := unknownFeature(in.Features); bad != "" {
		writeErr(w, http.StatusBadRequest, "bad_feature", "unknown feature key: "+bad)
		return
	}
	tx := appctx.Tx(r.Context())
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	var id uuid.UUID
	err := tx.QueryRow(r.Context(), `
		INSERT INTO plans (key, name, member_limit, price_copy, is_enterprise, sort_order, active)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
	`, in.Key, in.Name, in.MemberLimit, in.PriceCopy, in.IsEnterprise, in.SortOrder, active).Scan(&id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeErr(w, http.StatusConflict, "key_taken", "a plan with that key already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := replaceFeatures(r, id, in.Features); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "plan.create", TargetID: in.Key, Summary: "created plan " + in.Key})
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// UpdatePlan — PATCH /v1/super/plans/{id}. Replaces mutable fields + features.
func UpdatePlan(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var in planInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if bad := unknownFeature(in.Features); bad != "" {
		writeErr(w, http.StatusBadRequest, "bad_feature", "unknown feature key: "+bad)
		return
	}
	tx := appctx.Tx(r.Context())
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	ct, err := tx.Exec(r.Context(), `
		UPDATE plans SET name=$1, member_limit=$2, price_copy=$3, is_enterprise=$4,
		                 sort_order=$5, active=$6
		WHERE id=$7
	`, in.Name, in.MemberLimit, in.PriceCopy, in.IsEnterprise, in.SortOrder, active, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such plan")
		return
	}
	if err := replaceFeatures(r, id, in.Features); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "plan.update", TargetID: id.String(), Summary: "updated plan " + in.Name})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// DeletePlan — DELETE /v1/super/plans/{id}. Blocked when tenants reference it.
func DeletePlan(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	tx := appctx.Tx(r.Context())
	var inUse int
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM tenants WHERE plan_id = $1`, id).Scan(&inUse); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if inUse > 0 {
		writeErr(w, http.StatusConflict, "plan_in_use", "move those tenants to another plan first")
		return
	}
	ct, err := tx.Exec(r.Context(), `DELETE FROM plans WHERE id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if ct.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "no such plan")
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "plan.delete", TargetID: id.String(), Summary: "deleted plan"})
	w.WriteHeader(http.StatusNoContent)
}

// unknownFeature returns the first feature key not in the registry, or "".
func unknownFeature(keys []string) string {
	for _, k := range keys {
		if !billing.IsKnownFeature(k) {
			return k
		}
	}
	return ""
}

// replaceFeatures wipes and re-inserts the plan's feature rows.
func replaceFeatures(r *http.Request, planID uuid.UUID, keys []string) error {
	tx := appctx.Tx(r.Context())
	if _, err := tx.Exec(r.Context(), `DELETE FROM plan_features WHERE plan_id = $1`, planID); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, k := range keys {
		if seen[k] {
			continue
		}
		seen[k] = true
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO plan_features (plan_id, feature_key) VALUES ($1,$2)`, planID, k); err != nil {
			return err
		}
	}
	return nil
}
