package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/insight"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// =========================================================================
// /v1/insights — the findings this café has been shown, and what it decided.
//
// The list is filtered PER RECIPIENT, not per café. insight:read gets you the
// endpoint; which findings you actually see depends on the permission each
// detector declares (report:read for margin, shift:read for the drawer,
// house_tab:read for credit) and on the café's plan. So an owner and a manager
// can hit the same URL and correctly get different lists, and there is no
// separate permission model to keep in step — insight.Visible applies the same
// rules the nightly brief uses.
// =========================================================================

// viewerFor builds the filter for whoever is asking.
func viewerFor(r *http.Request) insight.Viewer {
	set, _ := appctx.Permissions(r.Context())
	ps := rbac.PermissionSet{Set: set}
	st, hasState := billing.StateFromContext(r.Context())

	return insight.Viewer{
		Can: ps.Has,
		HasFeature: func(k billing.FeatureKey) bool {
			// No billing state loaded should never happen behind RequireMember,
			// but failing CLOSED here would silently empty the list rather than
			// erroring, which is the worst of both. Fail open and let the route's
			// own RequireFeature gates do their job.
			if !hasState {
				return true
			}
			return st.Has(k)
		},
	}
}

// insightDTO is one finding as the UI sees it: the claim, the numbers behind it,
// and where it came from.
type insightDTO struct {
	ID           uuid.UUID `json:"id"`
	DetectorKey  string    `json:"detector_key"`
	Label        string    `json:"label"`
	SubjectKind  string    `json:"subject_kind"`
	SubjectKey   string    `json:"subject_key"`
	SubjectLabel string    `json:"subject_label"`
	Severity     string    `json:"severity"`
	State        string    `json:"state"`
	DeepLink     string    `json:"deep_link"`

	// Detail is today's sentence — the product.
	Detail      string  `json:"detail"`
	MetricValue float64 `json:"metric_value"`
	MetricUnit  string  `json:"metric_unit"`
	// Baseline is null when there was nothing to compare against, which the UI
	// must show as "no baseline" rather than as zero.
	Baseline *float64       `json:"baseline_value"`
	Facts    map[string]any `json:"facts"`

	FirstSeenOn string `json:"first_seen_on"`
	LastSeenOn  string `json:"last_seen_on"`

	SnoozedUntil *string `json:"snoozed_until"`
	FollowUpOn   *string `json:"follow_up_on"`
	Note         string  `json:"note"`

	// Then is the metric as it stood on the day this was accepted, present only
	// for accepted findings. With MetricValue it answers "did it move" — a
	// comparison, never a stored diff.
	Then *float64 `json:"then_value"`
}

func dateStr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format("2006-01-02")
	return &s
}

// ListInsights returns open findings, worst first.
func ListInsights(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	ctx := r.Context()

	// Includes snoozed rows whose date has passed, and accepted rows so the
	// owner can see what they committed to. Dismissed and closed are gone: the
	// former was an explicit "stop telling me", the latter fixed itself.
	rows, err := tx.Query(ctx, `
		SELECT f.id, f.detector_key, f.subject_kind, f.subject_key, f.subject_label,
		       f.severity, f.state, f.deep_link, f.first_seen_on, f.last_seen_on,
		       f.snoozed_until, f.follow_up_on, f.note,
		       o.detail, o.metric_value, o.baseline_value, o.metric_unit, o.facts,
		       then_obs.metric_value
		FROM insight_findings f
		JOIN LATERAL (
		  SELECT * FROM insight_observations x
		  WHERE x.finding_id = f.id ORDER BY x.day DESC LIMIT 1
		) o ON true
		LEFT JOIN insight_observations then_obs
		  ON then_obs.finding_id = f.id AND then_obs.day = f.accepted_on
		WHERE f.state IN ('new', 'seen', 'accepted')
		   OR (f.state = 'snoozed' AND f.snoozed_until <= CURRENT_DATE)
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	type row struct {
		dto insightDTO
		f   insight.Finding
	}
	var all []row
	for rows.Next() {
		var (
			d                   insightDTO
			firstSeen, lastSeen time.Time
			snoozed, followUp   *time.Time
			factsRaw            []byte
			baseline, then      *float64
		)
		if err := rows.Scan(&d.ID, &d.DetectorKey, &d.SubjectKind, &d.SubjectKey, &d.SubjectLabel,
			&d.Severity, &d.State, &d.DeepLink, &firstSeen, &lastSeen,
			&snoozed, &followUp, &d.Note,
			&d.Detail, &d.MetricValue, &baseline, &d.MetricUnit, &factsRaw, &then); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		d.FirstSeenOn = firstSeen.Format("2006-01-02")
		d.LastSeenOn = lastSeen.Format("2006-01-02")
		d.SnoozedUntil = dateStr(snoozed)
		d.FollowUpOn = dateStr(followUp)
		d.Baseline, d.Then = baseline, then
		if len(factsRaw) > 0 {
			_ = json.Unmarshal(factsRaw, &d.Facts)
		}
		if det, ok := insight.ByKey(d.DetectorKey); ok {
			d.Label = det.Label
		}
		all = append(all, row{dto: d, f: insight.Finding{
			DetectorKey: d.DetectorKey, Severity: insight.Severity(d.Severity),
			Unit: insight.Unit(d.MetricUnit), MetricValue: d.MetricValue,
			SubjectLabel: d.SubjectLabel,
		}})
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Filter and rank through exactly the same code the brief uses, so the list
	// and the email can never disagree about what matters or what is visible.
	viewer := viewerFor(r)
	if muted, err := insight.MutedDetectors(ctx, tx); err == nil {
		viewer.Muted = muted
	}

	findings := make([]insight.Finding, len(all))
	for i, a := range all {
		findings[i] = a.f
		findings[i].Facts = map[string]any{"idx": i}
	}
	ordered := insight.Rank(insight.Visible(findings, viewer))

	out := make([]insightDTO, 0, len(ordered))
	for _, f := range ordered {
		i, _ := f.Facts["idx"].(int)
		out = append(out, all[i].dto)
	}

	// Books Confidence is context for reading the list, not a finding, so it is
	// computed here rather than stored. Null is a real answer — a café that has
	// recorded too little gets "not enough yet", never 0%, which would read as
	// an accusation.
	var confidence *float64
	t, _ := appctx.TenantFromContext(ctx)
	tz := t.Timezone
	if tz == "" {
		tz = "Asia/Kathmandu"
	}
	if v, ok, err := insight.Confidence(ctx, tx, time.Now(), tz); err == nil && ok {
		confidence = &v
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"insights":         out,
		"books_confidence": confidence,
	})
}

// =========================================================================
// Lifecycle. Four narrow transitions rather than one PATCH, because each one
// means something different and each writes different columns — and the schema
// CHECKs that every terminal state is fully stamped, never half-recorded.
// =========================================================================

// openStates are the states a finding can be acted on from. Enforced in the
// UPDATE's WHERE clause rather than in Go: that is what makes it impossible for
// any caller — including, later, an AI assistant over MCP — to resurrect a
// closed finding or invent one.
const openStates = `('new', 'seen', 'snoozed', 'accepted')`

func insightID(r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	return id, err == nil
}

// applyTransition runs one lifecycle UPDATE and audits it. Returns false if it
// already wrote a response.
func applyTransition(w http.ResponseWriter, r *http.Request, sql, summary string, args ...any) bool {
	id, ok := insightID(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid insight id")
		return false
	}
	tx := appctx.Tx(r.Context())

	var detectorKey, label string
	err := tx.QueryRow(r.Context(), sql, append([]any{id}, args...)...).Scan(&detectorKey, &label)
	if errors.Is(err, pgx.ErrNoRows) {
		// Either it does not exist, belongs to another café (RLS), or is already
		// closed. All three are "not found" from here — telling them apart would
		// leak whether another café's row exists.
		writeErr(w, http.StatusNotFound, "not_found", "")
		return false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return false
	}

	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "insight", EntityID: &id,
		Summary: fmt.Sprintf("%s: %s", summary, label),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return false
	}
	return true
}

// MarkInsightSeen records that somebody read it. Not a decision, so it needs no
// permission beyond the read gate and never overwrites a real state.
func MarkInsightSeen(w http.ResponseWriter, r *http.Request) {
	if applyTransition(w, r, `
		UPDATE insight_findings
		SET state = 'seen', seen_at = COALESCE(seen_at, now())
		WHERE id = $1 AND state = 'new'
		RETURNING detector_key, subject_label`, "marked seen") {
		w.WriteHeader(http.StatusNoContent)
	}
}

// DismissInsight is "stop telling me about this". Three of these against one
// detector and the café stops hearing from it at all.
func DismissInsight(w http.ResponseWriter, r *http.Request) {
	if applyTransition(w, r, `
		UPDATE insight_findings
		SET state = 'dismissed', dismissed_at = now()
		WHERE id = $1 AND state IN `+openStates+`
		RETURNING detector_key, subject_label`, "dismissed insight") {
		w.WriteHeader(http.StatusNoContent)
	}
}

// SnoozeInsight hides a finding until a date. Distinct from dismissing: it does
// NOT count toward muting, because "not now" is not "never".
func SnoozeInsight(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Days int `json:"days"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	days := insight.ClampFollowUpDays(body.Days, 7)
	if applyTransition(w, r, `
		UPDATE insight_findings
		SET state = 'snoozed', snoozed_until = CURRENT_DATE + $2::int
		WHERE id = $1 AND state IN `+openStates+`
		RETURNING detector_key, subject_label`,
		fmt.Sprintf("snoozed insight for %d days", days), days) {
		w.WriteHeader(http.StatusNoContent)
	}
}

// AcceptInsight is the whole point of the feature: the owner decides to do
// something and books a date to see whether it worked.
//
// accepted_on records the observation day being accepted AGAINST, which is what
// lets the follow-up compare then with now as a query rather than a frozen diff.
func AcceptInsight(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Days int    `json:"follow_up_days"`
		Note string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	days := insight.ClampFollowUpDays(body.Days, 14)
	note := body.Note
	if len(note) > insight.MaxNoteLen {
		note = note[:insight.MaxNoteLen]
	}
	u, _ := appctx.UserFromContext(r.Context())

	if applyTransition(w, r, `
		UPDATE insight_findings
		SET state = 'accepted',
		    accepted_at = now(),
		    accepted_by_user_id = $3,
		    accepted_on = (SELECT MAX(day) FROM insight_observations WHERE finding_id = $1),
		    follow_up_on = CURRENT_DATE + $2::int,
		    note = $4
		WHERE id = $1 AND state IN `+openStates+`
		RETURNING detector_key, subject_label`,
		fmt.Sprintf("accepted insight, review in %d days", days), days, u.ID, note) {
		w.WriteHeader(http.StatusNoContent)
	}
}
