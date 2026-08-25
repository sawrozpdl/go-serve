package insight

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Persistence. Like gather.go, every statement here relies on RLS for tenant
// scoping — there is no tenant_id predicate anywhere, and no tenant_id argument
// to pass wrongly.
//
// THE UPSERT IS THE INTERESTING PART
//
// A nightly run produces the findings that are true TODAY. Reconciling that
// against what is already stored has to do four different things at once:
//
//   * a finding that is new gets a row in state 'new'
//   * a finding that is already open gets last_seen_on moved forward and its
//     severity refreshed, but its STATE IS LEFT ALONE — this is what makes
//     'dismissed' terminal, and it is why the schema keeps one durable row per
//     finding rather than one per day
//   * either way it gets today's observation, so "did the number move" stays a
//     query over real history
//   * a finding that has STOPPED being true gets closed
//
// Closing is what keeps the findings page honest: a problem the café fixed
// disappears on its own, without anybody having to tell us they fixed it.

// DismissalsToMute is how many times a café has to dismiss a detector before it
// stops hearing from it.
//
// This is the whole of "the system learns what you care about". With one café
// and three months of history there is no model worth training, and pretending
// otherwise would be the gimmick this project exists to avoid. But a dismissal
// is a free, unambiguous signal, and acting on it deterministically does the
// actual job: the brief gets quieter about things this owner does not care
// about, and can explain exactly why.
const DismissalsToMute = 3

// Store reconciles today's findings against what is already recorded, and
// returns the ids of the rows that are now open, keyed by finding identity.
//
// `day` is the café's LOCAL date. Passing a UTC date would put a Kathmandu
// morning's brief on the previous day for six hours out of every twenty-four.
func Store(ctx context.Context, q Querier, day time.Time, findings []Finding) (map[string]uuid.UUID, error) {
	ids := make(map[string]uuid.UUID, len(findings))
	for _, f := range findings {
		factsJSON, err := json.Marshal(f.Facts)
		if err != nil {
			return nil, err
		}

		var findingID uuid.UUID
		// ON CONFLICT against the PARTIAL unique index (state <> 'closed'), so a
		// problem that recurs long after being closed correctly starts a fresh
		// row and a fresh lifecycle rather than reopening a settled argument.
		//
		// The DO UPDATE deliberately touches only last_seen_on, severity, the
		// frozen label and the link. It never writes `state`.
		if err := q.QueryRow(ctx, `
			INSERT INTO insight_findings
			  (tenant_id, detector_key, subject_kind, subject_key, subject_label,
			   severity, deep_link, state, first_seen_on, last_seen_on)
			VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, 'new', $7, $7)
			ON CONFLICT (tenant_id, detector_key, subject_kind, subject_key)
			  WHERE state <> 'closed'
			DO UPDATE SET
			  last_seen_on  = GREATEST(insight_findings.last_seen_on, EXCLUDED.last_seen_on),
			  severity      = EXCLUDED.severity,
			  subject_label = EXCLUDED.subject_label,
			  deep_link     = EXCLUDED.deep_link
			RETURNING id
		`, f.DetectorKey, string(f.SubjectKind), f.SubjectKey, f.SubjectLabel,
			string(f.Severity), linkFor(f), day).Scan(&findingID); err != nil {
			return nil, err
		}

		// One observation per finding per local day. A second run on the same day
		// overwrites it rather than failing, so a manual re-trigger is safe.
		if _, err := q.Exec(ctx, `
			INSERT INTO insight_observations
			  (tenant_id, finding_id, day, severity, metric_value, baseline_value,
			   metric_unit, detail, facts)
			VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (finding_id, day) DO UPDATE SET
			  severity       = EXCLUDED.severity,
			  metric_value   = EXCLUDED.metric_value,
			  baseline_value = EXCLUDED.baseline_value,
			  metric_unit    = EXCLUDED.metric_unit,
			  detail         = EXCLUDED.detail,
			  facts          = EXCLUDED.facts
		`, findingID, day, string(f.Severity), f.MetricValue, f.Baseline,
			string(f.Unit), f.Detail, factsJSON); err != nil {
			return nil, err
		}

		ids[identity(f)] = findingID
	}
	return ids, nil
}

// CloseStale closes every open finding that today's run did NOT produce: the
// problem is gone. Returns how many were closed.
//
// Called with the same `day` as Store, and only after it, so "not seen today"
// means exactly "Store did not touch it".
func CloseStale(ctx context.Context, q Querier, day time.Time) (int64, error) {
	tag, err := q.Exec(ctx, `
		UPDATE insight_findings
		SET state = 'closed', closed_at = now()
		WHERE state IN ('new', 'seen', 'snoozed', 'accepted')
		  AND last_seen_on < $1
	`, day)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// MutedDetectors lists detector keys this café has dismissed at least
// DismissalsToMute times.
//
// Counted over dismissed_at rather than state, because a dismissed finding is
// later CLOSED when the problem goes away — which would erase the signal if this
// looked at state. That is why 0068 never clears dismissed_at.
func MutedDetectors(ctx context.Context, q Querier) (map[string]bool, error) {
	rows, err := q.Query(ctx, `
		SELECT detector_key
		FROM insight_findings
		WHERE dismissed_at IS NOT NULL
		GROUP BY detector_key
		HAVING COUNT(*) >= $1
	`, DismissalsToMute)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out[k] = true
	}
	return out, rows.Err()
}

// FollowUp is an accepted finding whose review date has arrived, with the number
// as it stood when the owner accepted it and as it stands now.
//
// The comparison is a JOIN over observations, never a diff stored at accept
// time: a stored diff freezes, and would be wrong the moment the detector ran
// again — which is every night.
type FollowUp struct {
	FindingID    uuid.UUID
	DetectorKey  string
	SubjectLabel string
	Note         string
	AcceptedOn   time.Time
	Unit         Unit
	Then         float64
	Now          float64
	// Detail is today's sentence, so a follow-up reads as the current situation
	// rather than a stale quote.
	Detail string
}

// Improved reports whether the number moved in the direction the owner wanted.
// For every metric in this package, lower is better — less money lost, fewer
// misses, a smaller share voided — with one exception handled by the caller:
// coverage ratios, where higher is better.
func (f FollowUp) Improved(higherIsBetter bool) bool {
	if higherIsBetter {
		return f.Now > f.Then
	}
	return f.Now < f.Then
}

// DueFollowUps lists accepted findings whose follow_up_on has arrived.
func DueFollowUps(ctx context.Context, q Querier, day time.Time) ([]FollowUp, error) {
	rows, err := q.Query(ctx, `
		SELECT f.id, f.detector_key, f.subject_label, f.note, f.accepted_on,
		       then_obs.metric_unit, then_obs.metric_value,
		       now_obs.metric_value, now_obs.detail
		FROM insight_findings f
		JOIN insight_observations then_obs
		  ON then_obs.finding_id = f.id AND then_obs.day = f.accepted_on
		JOIN LATERAL (
		  SELECT o.metric_value, o.detail FROM insight_observations o
		  WHERE o.finding_id = f.id ORDER BY o.day DESC LIMIT 1
		) now_obs ON true
		WHERE f.state = 'accepted' AND f.follow_up_on <= $1
		ORDER BY f.follow_up_on
	`, day)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FollowUp
	for rows.Next() {
		var fu FollowUp
		var unit string
		if err := rows.Scan(&fu.FindingID, &fu.DetectorKey, &fu.SubjectLabel, &fu.Note,
			&fu.AcceptedOn, &unit, &fu.Then, &fu.Now, &fu.Detail); err != nil {
			return nil, err
		}
		fu.Unit = Unit(unit)
		out = append(out, fu)
	}
	return out, rows.Err()
}

// identity is the finding's stable key, matching the schema's unique index.
func identity(f Finding) string {
	return f.DetectorKey + "|" + string(f.SubjectKind) + "|" + f.SubjectKey
}

// linkFor renders a finding's deep link through its detector, or "" if the
// detector is gone or the arity does not match.
func linkFor(f Finding) string {
	d, ok := ByKey(f.DetectorKey)
	if !ok {
		return ""
	}
	return d.Link(f)
}
