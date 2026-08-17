package api

import (
	"net/http"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// ENGAGE — analytics (0065)
//
// HOW THESE NUMBERS ARE DEFINED, AND WHAT THEY ARE NOT
//
// Every rate here is computed in Go from raw counts, so the zero-denominator
// case is handled once and every count stays visible for auditing. The
// definitions are deliberate and a couple of them are easy to get subtly wrong:
//
//	scans              unique device-DAYS that opened the play page. Not raw
//	                   hits (reported separately as `scan_loads`), because
//	                   "scans" should mean guests, not refreshes.
//	completion rate    completed / started, over ALL runs.
//	win rate           codes issued / completed WINNABLE runs. Practice runs are
//	                   excluded or the number is meaningless — they can never win.
//	redemption rate    redeemed / issued, windowed by ISSUED_ON, never by
//	                   redeemed_on. Mixing the two produces rates above 100% at
//	                   the tail of a window; this is the single most commonly
//	                   botched figure in the module.
//	returning players  devices seen on >= 2 distinct days. Deliberately NOT
//	                   called "repeat visits" — see below.
//	spend lift         mean SUBTOTAL of bills carrying a redeemed code vs bills
//	                   without, same window. Subtotal, not total: the reward IS a
//	                   discount inside total_cents, so comparing totals
//	                   mechanically penalises the group that redeemed and
//	                   understates any real effect.
//
// WHAT IS NOT MEASURABLE, and must not be implied
//
// With one café-wide QR and no guest identity there is no way to know whether a
// redeeming guest would have come anyway. Spend lift here is an ASSOCIATION, not
// causation, and it is selection-biased: guests who play and redeem are
// self-selected engaged customers. "Returning players" counts devices, so a
// guest who plays but never orders is not a proven visit, and one guest with two
// phones is two players. The response carries these caveats so the UI cannot
// quietly present them as something stronger.
// =========================================================================

type engageFunnel struct {
	Scans     int64 `json:"scans"`
	ScanLoads int64 `json:"scan_loads"`
	Started   int64 `json:"started"`
	Completed int64 `json:"completed"`
	Won       int64 `json:"won"`
	Redeemed  int64 `json:"redeemed"`
}

type engageRates struct {
	Completion float64 `json:"completion"`
	Win        float64 `json:"win"`
	Redemption float64 `json:"redemption"`
	// Returning is nil for windows under 7 days, where it is 0 by construction
	// and would read as a real result. ReturningReason says why.
	Returning       *float64 `json:"returning"`
	ReturningReason string   `json:"returning_reason,omitempty"`
}

type engageSpendLift struct {
	WithRewardOrders    int64 `json:"with_reward_orders"`
	WithoutRewardOrders int64 `json:"without_reward_orders"`
	AvgWithSubtotal     int64 `json:"avg_with_subtotal_cents"`
	AvgWithoutSubtotal  int64 `json:"avg_without_subtotal_cents"`
	DifferenceCents     int64 `json:"difference_cents"`
	AvgWithTotal        int64 `json:"avg_with_total_cents"`
	AvgWithoutTotal     int64 `json:"avg_without_total_cents"`
	// Basis and Caveats travel with the numbers so no UI can present them as
	// causal without actively ignoring the payload.
	Basis   string   `json:"basis"`
	Caveats []string `json:"caveats"`
}

type engageStats struct {
	Funnel engageFunnel `json:"funnel"`
	Rates  engageRates  `json:"rates"`
	// Practice runs, reported separately so they never dilute the headline.
	PracticeRuns int64 `json:"practice_runs"`
	FlaggedRuns  int64 `json:"flagged_runs"`
	// Value issued (what was promised, at each tier's ceiling) vs value actually
	// discounted at the till. They answer different questions and an owner will
	// want both on day one.
	ValueIssuedCents   int64 `json:"value_issued_cents"`
	ValueRedeemedCents int64 `json:"value_redeemed_cents"`
	// InFlight are codes still inside their window — not failures.
	InFlightCodes  int64            `json:"in_flight_codes"`
	SpendLift      engageSpendLift  `json:"spend_lift"`
	ScoreHistogram []engageScoreBin `json:"score_histogram"`
	From           string           `json:"from"`
	To             string           `json:"to"`
}

type engageScoreBin struct {
	Bucket int   `json:"bucket"`
	Count  int64 `json:"count"`
}

// rate is a safe division: zero denominator means "no data", not NaN or a
// divide-by-zero panic. Every rate on this page goes through it.
func rate(num, den int64) float64 {
	if den <= 0 {
		return 0
	}
	return float64(num) / float64(den)
}

// localDateWindow converts the range's absolute INSTANTS into the tenant-local
// DATES that the engage tables actually store.
//
// This conversion is not optional, and getting it wrong is silent. rangeWindow's
// From/To are true instants bounding the café's local day — local midnight in
// Kathmandu is 18:15 UTC the previous day. The engage tables store local dates
// (play_day, issued_on, scan_date, redeemed_on), so the two have to be brought
// into the same frame.
//
// Casting the instant directly with `$1::date` does NOT do that: it truncates
// the UTC wall clock, so between 18:15 and midnight local the whole window lands
// one day early and every figure on the page reads zero. Converting through the
// tenant's zone first is what makes "today" mean the café's today.
func localDateWindow(r *http.Request, rng rangeWindow) (from, to string, err error) {
	err = appctx.Tx(r.Context()).QueryRow(r.Context(),
		`SELECT ($1::timestamptz AT TIME ZONE $3)::date::text,
		        ($2::timestamptz AT TIME ZONE $3)::date::text`,
		rng.From, rng.To, rng.TZ).Scan(&from, &to)
	return
}

// GetEngageStats — GET /v1/engage/stats?range=&from=&to=
func GetEngageStats(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"), r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	fromDate, toDate, err := localDateWindow(r, rng)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	tx := appctx.Tx(r.Context())
	// The window the guest-facing tables are keyed by: the CAFÉ's dates.
	out := engageStats{From: fromDate, To: toDate}

	// One round trip for the funnel and the counts behind every rate. The local
	// date columns (play_day, issued_on, redeemed_on) are what make this
	// index-only; see the note in 0065 about why the handler passes both a date
	// and a timestamp form of the window.
	var (
		devicesSeen   int64
		repeatDevices int64
		winnableDone  int64
	)
	if err := tx.QueryRow(r.Context(), `
		WITH scans AS (
		  SELECT count(*)::bigint n, COALESCE(SUM(hits), 0)::bigint loads
		  FROM engage_scans WHERE scan_date >= $1::date AND scan_date < $2::date
		),
		sess AS (
		  SELECT count(*)::bigint started,
		         count(*) FILTER (WHERE completed_at IS NOT NULL)::bigint completed,
		         count(*) FILTER (WHERE is_winnable AND completed_at IS NOT NULL)::bigint winnable_done,
		         count(*) FILTER (WHERE outcome = 'practice')::bigint practice,
		         count(*) FILTER (WHERE status = 'flagged')::bigint flagged,
		         count(DISTINCT device_hash)::bigint devices
		  FROM engage_sessions WHERE play_day >= $1::date AND play_day < $2::date
		),
		codes AS (
		  SELECT count(*)::bigint issued,
		         count(*) FILTER (WHERE status = 'redeemed')::bigint redeemed,
		         count(*) FILTER (WHERE status = 'issued' AND expires_at > now())::bigint in_flight,
		         COALESCE(SUM(estimated_value_cents), 0)::bigint value_issued
		  FROM engage_codes
		  WHERE issued_on >= $1::date AND issued_on < $2::date AND status <> 'void'
		),
		red AS (
		  SELECT COALESCE(SUM(amount_cents), 0)::bigint value_redeemed
		  FROM engage_redemptions
		  WHERE redeemed_on >= $1::date AND redeemed_on < $2::date AND reverted_at IS NULL
		),
		rep AS (
		  SELECT count(*)::bigint repeat_devices FROM (
		    SELECT device_hash FROM engage_sessions
		    WHERE play_day >= $1::date AND play_day < $2::date
		    GROUP BY 1 HAVING count(DISTINCT play_day) >= 2
		  ) x
		)
		SELECT scans.n, scans.loads, sess.started, sess.completed, sess.winnable_done,
		       sess.practice, sess.flagged, sess.devices,
		       codes.issued, codes.redeemed, codes.in_flight, codes.value_issued,
		       red.value_redeemed, rep.repeat_devices
		FROM scans, sess, codes, red, rep
	`, fromDate, toDate).Scan(
		&out.Funnel.Scans, &out.Funnel.ScanLoads, &out.Funnel.Started, &out.Funnel.Completed,
		&winnableDone, &out.PracticeRuns, &out.FlaggedRuns, &devicesSeen,
		&out.Funnel.Won, &out.Funnel.Redeemed, &out.InFlightCodes, &out.ValueIssuedCents,
		&out.ValueRedeemedCents, &repeatDevices,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	out.Rates.Completion = rate(out.Funnel.Completed, out.Funnel.Started)
	out.Rates.Win = rate(out.Funnel.Won, winnableDone)
	out.Rates.Redemption = rate(out.Funnel.Redeemed, out.Funnel.Won)

	// Over a short window "played on 2 different days" is 0 by construction, and
	// a hard 0 would read as "nobody comes back" rather than "ask again later".
	if rng.Days >= 7 {
		v := rate(repeatDevices, devicesSeen)
		out.Rates.Returning = &v
	} else {
		out.Rates.ReturningReason = "window_too_short"
	}

	if err := loadEngageSpendLift(r, rng, &out.SpendLift); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := loadEngageScoreHistogram(r, fromDate, toDate, &out); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// loadEngageSpendLift compares bills that carried a redeemed reward with those
// that did not, over the same window.
func loadEngageSpendLift(r *http.Request, rng rangeWindow, out *engageSpendLift) error {
	out.Basis = "association_not_causal"
	out.Caveats = []string{
		"Guests who play and redeem choose to — they may already be your bigger spenders.",
		"There is no control group: every guest sees the same offer.",
		"One QR for the whole café means we can't tell if the person who scanned is the person paying.",
		"A table of four with one scanner puts the reward on one bill covering four people.",
	}
	return appctx.Tx(r.Context()).QueryRow(r.Context(), `
		WITH pop AS (
		  SELECT o.subtotal_cents, o.total_cents,
		         EXISTS (SELECT 1 FROM engage_redemptions rr
		                 WHERE rr.order_id = o.id AND rr.reverted_at IS NULL) AS had_reward
		  FROM orders o
		  WHERE o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
		)
		SELECT
		  count(*) FILTER (WHERE had_reward)::bigint,
		  count(*) FILTER (WHERE NOT had_reward)::bigint,
		  COALESCE(round(avg(subtotal_cents) FILTER (WHERE had_reward)), 0)::bigint,
		  COALESCE(round(avg(subtotal_cents) FILTER (WHERE NOT had_reward)), 0)::bigint,
		  COALESCE(round(avg(total_cents)    FILTER (WHERE had_reward)), 0)::bigint,
		  COALESCE(round(avg(total_cents)    FILTER (WHERE NOT had_reward)), 0)::bigint
		FROM pop
	`, rng.From, rng.To).Scan(&out.WithRewardOrders, &out.WithoutRewardOrders,
		&out.AvgWithSubtotal, &out.AvgWithoutSubtotal, &out.AvgWithTotal, &out.AvgWithoutTotal)
}

// loadEngageScoreHistogram buckets scores server-side — raw scores are never
// shipped. This is the chart that makes tier thresholds tunable: an owner can
// see the hump of players sitting just under a rung and move it.
func loadEngageScoreHistogram(r *http.Request, fromDate, toDate string, out *engageStats) error {
	out.ScoreHistogram = []engageScoreBin{}
	rows, err := appctx.Tx(r.Context()).Query(r.Context(), `
		SELECT (score / 5) * 5 AS bucket, count(*)::bigint
		FROM engage_sessions
		WHERE play_day >= $1::date AND play_day < $2::date
		  AND score IS NOT NULL AND status = 'completed'
		GROUP BY 1 ORDER BY 1
	`, fromDate, toDate)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var b engageScoreBin
		if err := rows.Scan(&b.Bucket, &b.Count); err != nil {
			return err
		}
		out.ScoreHistogram = append(out.ScoreHistogram, b)
	}
	return rows.Err()
}

type engageDayRow struct {
	Day       string `json:"day"`
	Scans     int64  `json:"scans"`
	Started   int64  `json:"started"`
	Completed int64  `json:"completed"`
	Won       int64  `json:"won"`
	Redeemed  int64  `json:"redeemed"`
	ValueCent int64  `json:"value_redeemed_cents"`
}

// GetEngageTimeseries — GET /v1/engage/timeseries.
// A zero-filled day spine, following the same generate_series pattern the rest
// of analytics.go uses, so a quiet day is a gap in the chart rather than a
// missing bar that silently shifts everything left.
func GetEngageTimeseries(w http.ResponseWriter, r *http.Request) {
	rng, err := resolveRangeFull(r.Context(),
		r.URL.Query().Get("range"), r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	fromDate, toDate, err := localDateWindow(r, rng)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	rows, err := appctx.Tx(r.Context()).Query(r.Context(), `
		WITH days AS (
		  SELECT d::date AS d FROM generate_series($1::date, ($2::date - 1), '1 day') d
		),
		s AS (
		  SELECT scan_date d, count(*)::bigint n FROM engage_scans
		  WHERE scan_date >= $1::date AND scan_date < $2::date GROUP BY 1
		),
		p AS (
		  SELECT play_day d, count(*)::bigint started,
		         count(*) FILTER (WHERE completed_at IS NOT NULL)::bigint completed
		  FROM engage_sessions WHERE play_day >= $1::date AND play_day < $2::date GROUP BY 1
		),
		i AS (
		  SELECT issued_on d, count(*)::bigint issued FROM engage_codes
		  WHERE issued_on >= $1::date AND issued_on < $2::date AND status <> 'void' GROUP BY 1
		),
		rd AS (
		  SELECT redeemed_on d, count(*)::bigint redeemed,
		         COALESCE(SUM(amount_cents), 0)::bigint value
		  FROM engage_redemptions
		  WHERE redeemed_on >= $1::date AND redeemed_on < $2::date AND reverted_at IS NULL
		  GROUP BY 1
		)
		SELECT to_char(days.d, 'YYYY-MM-DD'),
		       COALESCE(s.n, 0), COALESCE(p.started, 0), COALESCE(p.completed, 0),
		       COALESCE(i.issued, 0), COALESCE(rd.redeemed, 0), COALESCE(rd.value, 0)
		FROM days
		LEFT JOIN s  ON s.d  = days.d
		LEFT JOIN p  ON p.d  = days.d
		LEFT JOIN i  ON i.d  = days.d
		LEFT JOIN rd ON rd.d = days.d
		ORDER BY 1
	`, fromDate, toDate)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []engageDayRow{}
	for rows.Next() {
		var d engageDayRow
		if err := rows.Scan(&d.Day, &d.Scans, &d.Started, &d.Completed, &d.Won,
			&d.Redeemed, &d.ValueCent); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": out})
}
