package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
)

// =========================================================================
// ENGAGE — campaign + reward tier configuration (0065)
//
// A café runs ONE campaign at a time, so the owner-facing API is a singleton
// rather than a collection: GET/PUT /v1/engage/campaign edits "the current
// campaign", and a status flip to 'ended' retires it so the next PUT starts a
// fresh one. The schema itself allows many rows per tenant — issued codes
// outlive the campaign that minted them, and an ended campaign has to stay
// readable for analytics — but only one is ever 'active', which is enforced by
// the engage_campaigns_one_active partial unique index rather than by a handler
// that would have to guess which of two live campaigns wins.
//
// Reward VALUES never come from the client on the read path. estimated_value_cents
// is computed here at save time (see tierEstimatedValue) because it is what the
// budget caps are enforced against; a client-supplied figure would let a café's
// own dashboard lie to it about how much a campaign is costing.
// =========================================================================

// engageGames / engageDifficulties mirror the CHECK constraints in 0065. Kept in
// Go too so a bad value is a 400 with a readable message rather than a 500 from
// a constraint violation.
var engageGames = map[string]bool{"tea_runner": true, "memory_match": true, "stack": true}
var engageDifficulties = map[string]bool{"gentle": true, "normal": true, "tricky": true}

// engageStatuses are the states an owner may set directly. 'ended' is terminal.
var engageStatuses = map[string]bool{"draft": true, "active": true, "paused": true, "ended": true}

type EngageCampaign struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Status     string    `json:"status"`
	StartsOn   *string   `json:"starts_on"`
	EndsOn     *string   `json:"ends_on"`
	ActiveDays []int16   `json:"active_days"`
	ActiveFrom *string   `json:"active_from"`
	ActiveTo   *string   `json:"active_to"`

	Game       string `json:"game"`
	Difficulty string `json:"difficulty"`

	RewardTTLSeconds int `json:"reward_ttl_seconds"`
	GraceSeconds     int `json:"grace_seconds"`

	AllowClaimWithoutPlay bool `json:"allow_claim_without_play"`

	BudgetTotalCents *int64 `json:"budget_total_cents"`
	BudgetDailyCents *int64 `json:"budget_daily_cents"`
	BudgetDailyCount *int   `json:"budget_daily_count"`

	ContactCaptureEnabled bool `json:"contact_capture_enabled"`

	Headline  string `json:"headline"`
	Subhead   string `json:"subhead"`
	TermsText string `json:"terms_text"`
}

type EngageTier struct {
	ID           uuid.UUID  `json:"id"`
	MinScore     int        `json:"min_score"`
	Label        string     `json:"label"`
	RewardKind   string     `json:"reward_kind"`
	PercentBP    *int       `json:"percent_bp"`
	AmountCents  *int64     `json:"amount_cents"`
	MenuItemID   *uuid.UUID `json:"menu_item_id"`
	MenuItemName string     `json:"menu_item_name,omitempty"`
	// Nil once the referenced item is deleted (the FK is ON DELETE SET NULL), which
	// is why the editor needs to be able to show a tier as broken rather than
	// silently treating it as a no-reward.
	MaxDiscountCents    *int64 `json:"max_discount_cents"`
	EstimatedValueCents int64  `json:"estimated_value_cents"`
	Sort                int    `json:"sort"`
}

// =========================================================================
// Loading
// =========================================================================

const engageCampaignCols = `
	id, name, status, starts_on, ends_on, active_days, active_from, active_to,
	game, difficulty, reward_ttl_seconds, grace_seconds, allow_claim_without_play,
	budget_total_cents, budget_daily_cents, budget_daily_count,
	contact_capture_enabled, headline, subhead, terms_text`

// scanCampaign reads engageCampaignCols in order. Dates and times are rendered as
// strings so the wire format stays stable regardless of the driver's time type.
func scanCampaign(row pgx.Row) (EngageCampaign, error) {
	var c EngageCampaign
	err := row.Scan(&c.ID, &c.Name, &c.Status, &c.StartsOn, &c.EndsOn, &c.ActiveDays,
		&c.ActiveFrom, &c.ActiveTo, &c.Game, &c.Difficulty, &c.RewardTTLSeconds,
		&c.GraceSeconds, &c.AllowClaimWithoutPlay, &c.BudgetTotalCents, &c.BudgetDailyCents,
		&c.BudgetDailyCount, &c.ContactCaptureEnabled, &c.Headline, &c.Subhead, &c.TermsText)
	if c.ActiveDays == nil {
		c.ActiveDays = []int16{}
	}
	return c, err
}

// loadCurrentCampaign returns the café's live-or-editable campaign — anything not
// ended and not soft-deleted, newest first. Returns pgx.ErrNoRows when the café
// has never set one up.
func loadCurrentCampaign(r *http.Request) (EngageCampaign, error) {
	return scanCampaign(appctx.Tx(r.Context()).QueryRow(r.Context(), `
		SELECT `+engageCampaignCols+`
		FROM engage_campaigns
		WHERE deleted_at IS NULL AND status <> 'ended'
		ORDER BY created_at DESC
		LIMIT 1
	`))
}

func loadTiers(r *http.Request, campaignID uuid.UUID) ([]EngageTier, error) {
	rows, err := appctx.Tx(r.Context()).Query(r.Context(), `
		SELECT t.id, t.min_score, t.label, t.reward_kind, t.percent_bp, t.amount_cents,
		       t.menu_item_id, COALESCE(m.name, ''), t.max_discount_cents,
		       t.estimated_value_cents, t.sort
		FROM engage_tiers t
		LEFT JOIN menu_items m ON m.id = t.menu_item_id
		WHERE t.campaign_id = $1
		ORDER BY t.min_score
	`, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EngageTier{}
	for rows.Next() {
		var t EngageTier
		if err := rows.Scan(&t.ID, &t.MinScore, &t.Label, &t.RewardKind, &t.PercentBP,
			&t.AmountCents, &t.MenuItemID, &t.MenuItemName, &t.MaxDiscountCents,
			&t.EstimatedValueCents, &t.Sort); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetEngageCampaign — GET /v1/engage/campaign.
// Returns {campaign: null, tiers: []} for a café that has never configured one,
// rather than a 404: the Engage page is reachable the moment the feature is
// enabled, and an empty editor is the correct first screen.
func GetEngageCampaign(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "engage.campaign.get")

	c, err := loadCurrentCampaign(r)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{"campaign": nil, "tiers": []EngageTier{}})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	tiers, err := loadTiers(r, c.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": c, "tiers": tiers})
}

// =========================================================================
// Saving the campaign
// =========================================================================

type engageCampaignBody struct {
	Name       string  `json:"name"`
	StartsOn   *string `json:"starts_on"`
	EndsOn     *string `json:"ends_on"`
	ActiveDays []int16 `json:"active_days"`
	ActiveFrom *string `json:"active_from"`
	ActiveTo   *string `json:"active_to"`

	Game       string `json:"game"`
	Difficulty string `json:"difficulty"`

	RewardTTLSeconds int `json:"reward_ttl_seconds"`
	GraceSeconds     int `json:"grace_seconds"`

	AllowClaimWithoutPlay bool `json:"allow_claim_without_play"`

	BudgetTotalCents *int64 `json:"budget_total_cents"`
	BudgetDailyCents *int64 `json:"budget_daily_cents"`
	BudgetDailyCount *int   `json:"budget_daily_count"`

	ContactCaptureEnabled bool `json:"contact_capture_enabled"`

	Headline  string `json:"headline"`
	Subhead   string `json:"subhead"`
	TermsText string `json:"terms_text"`
}

// validateCampaign bounds every field the owner can set. Returns a human message
// on the first problem ("" == valid). The DB CHECKs are the backstop; these exist
// so the owner gets a sentence instead of a constraint name.
func validateCampaign(b *engageCampaignBody) string {
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" {
		return "name required"
	}
	if len(b.Name) > 120 {
		return "name must be ≤ 120 characters"
	}
	if !engageGames[b.Game] {
		return "game must be tea_runner, memory_match or stack"
	}
	if !engageDifficulties[b.Difficulty] {
		return "difficulty must be gentle, normal or tricky"
	}
	// The reward has to outlive the walk to the counter but not the visit. The
	// bounds match 0065's CHECK.
	if b.RewardTTLSeconds < 120 || b.RewardTTLSeconds > 1800 {
		return "reward window must be between 2 and 30 minutes"
	}
	if b.GraceSeconds < 0 || b.GraceSeconds > 3600 {
		return "grace period must be between 0 and 60 minutes"
	}
	for _, d := range b.ActiveDays {
		if d < 0 || d > 6 {
			return "active_days must be 0–6 (Sunday = 0)"
		}
	}
	if b.BudgetTotalCents != nil && *b.BudgetTotalCents < 0 {
		return "total budget can't be negative"
	}
	if b.BudgetDailyCents != nil && *b.BudgetDailyCents < 0 {
		return "daily budget can't be negative"
	}
	if b.BudgetDailyCount != nil && *b.BudgetDailyCount < 0 {
		return "daily reward limit can't be negative"
	}
	if len(b.Headline) > 120 || len(b.Subhead) > 240 {
		return "headline must be ≤ 120 and subhead ≤ 240 characters"
	}
	if len(b.TermsText) > 2000 {
		return "terms must be ≤ 2000 characters"
	}
	return ""
}

// PutEngageCampaign — PUT /v1/engage/campaign.
// Upserts the café's single current campaign. A café that has never configured
// one gets a fresh 'draft'; going live is a separate, deliberate action
// (SetEngageCampaignStatus) so saving copy can never switch the QR on by accident.
func PutEngageCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := appctx.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	user, _ := appctx.UserFromContext(r.Context())

	var body engageCampaignBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if msg := validateCampaign(&body); msg != "" {
		writeErr(w, http.StatusBadRequest, "bad_request", msg)
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "engage.campaign.put", "game", body.Game)

	tx := appctx.Tx(r.Context())
	existing, err := loadCurrentCampaign(r)
	isNew := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !isNew {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	var saved EngageCampaign
	if isNew {
		saved, err = scanCampaign(tx.QueryRow(r.Context(), `
			INSERT INTO engage_campaigns
			  (tenant_id, name, starts_on, ends_on, active_days, active_from, active_to,
			   game, difficulty, reward_ttl_seconds, grace_seconds, allow_claim_without_play,
			   budget_total_cents, budget_daily_cents, budget_daily_count,
			   contact_capture_enabled, headline, subhead, terms_text, created_by_user_id)
			VALUES ($1,$2,$3::date,$4::date,$5,$6::time,$7::time,$8,$9,$10,$11,$12,
			        $13,$14,$15,$16,$17,$18,$19,$20)
			RETURNING `+engageCampaignCols,
			t.ID, body.Name, body.StartsOn, body.EndsOn, body.ActiveDays, body.ActiveFrom,
			body.ActiveTo, body.Game, body.Difficulty, body.RewardTTLSeconds, body.GraceSeconds,
			body.AllowClaimWithoutPlay, body.BudgetTotalCents, body.BudgetDailyCents,
			body.BudgetDailyCount, body.ContactCaptureEnabled, body.Headline, body.Subhead,
			body.TermsText, user.ID))
	} else {
		saved, err = scanCampaign(tx.QueryRow(r.Context(), `
			UPDATE engage_campaigns SET
			  name = $2, starts_on = $3::date, ends_on = $4::date, active_days = $5,
			  active_from = $6::time, active_to = $7::time, game = $8, difficulty = $9,
			  reward_ttl_seconds = $10, grace_seconds = $11, allow_claim_without_play = $12,
			  budget_total_cents = $13, budget_daily_cents = $14, budget_daily_count = $15,
			  contact_capture_enabled = $16, headline = $17, subhead = $18, terms_text = $19
			WHERE id = $1
			RETURNING `+engageCampaignCols,
			existing.ID, body.Name, body.StartsOn, body.EndsOn, body.ActiveDays, body.ActiveFrom,
			body.ActiveTo, body.Game, body.Difficulty, body.RewardTTLSeconds, body.GraceSeconds,
			body.AllowClaimWithoutPlay, body.BudgetTotalCents, body.BudgetDailyCents,
			body.BudgetDailyCount, body.ContactCaptureEnabled, body.Headline, body.Subhead,
			body.TermsText))
	}
	if err != nil {
		// The date/time CHECKs are the likeliest failure here and both are the
		// owner's mistake, not ours.
		if strings.Contains(err.Error(), "engage_campaigns_dates_sane") {
			writeErr(w, http.StatusBadRequest, "bad_request", "the end date must be on or after the start date")
			return
		}
		if strings.Contains(err.Error(), "engage_campaigns_hours_sane") {
			writeErr(w, http.StatusBadRequest, "bad_request", "the daily end time must be after the start time")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	action := "update"
	if isNew {
		action = "create"
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: action, Entity: "engage_campaign", EntityID: &saved.ID,
		Summary: fmt.Sprintf("saved QR rewards campaign %s (%s)", audit.Quote(saved.Name), saved.Game),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	tiers, err := loadTiers(r, saved.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign": saved, "tiers": tiers})
}

// SetEngageCampaignStatus — POST /v1/engage/campaign/status.
// Going live is its own call, separate from saving, because it is the moment the
// café starts handing out real money.
func SetEngageCampaignStatus(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !engageStatuses[body.Status] {
		writeErr(w, http.StatusBadRequest, "bad_request", "status must be draft, active, paused or ended")
		return
	}

	tx := appctx.Tx(r.Context())
	c, err := loadCurrentCampaign(r)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "no campaign to update")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	// Going live with no winning tier would show guests a ladder they cannot
	// climb — every play would be a miss. Refuse it rather than let a café run a
	// campaign that can only disappoint.
	if body.Status == "active" {
		var winners int
		if err := tx.QueryRow(r.Context(),
			`SELECT count(*) FROM engage_tiers WHERE campaign_id = $1 AND reward_kind <> 'none'`,
			c.ID).Scan(&winners); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if winners == 0 {
			writeErr(w, http.StatusConflict, "no_reward_tiers",
				"add at least one reward tier before going live — as configured, every guest would lose")
			return
		}
	}

	if _, err := tx.Exec(r.Context(),
		`UPDATE engage_campaigns SET status = $2 WHERE id = $1`, c.ID, body.Status); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "engage_campaign", EntityID: &c.ID,
		Summary: fmt.Sprintf("set QR rewards campaign %s to %s", audit.Quote(c.Name), body.Status),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	c.Status = body.Status
	writeJSON(w, http.StatusOK, map[string]any{"campaign": c})
}

// =========================================================================
// Reward tiers — whole-list PUT
// =========================================================================

type engageTierBody struct {
	MinScore         int        `json:"min_score"`
	Label            string     `json:"label"`
	RewardKind       string     `json:"reward_kind"`
	PercentBP        *int       `json:"percent_bp"`
	AmountCents      *int64     `json:"amount_cents"`
	MenuItemID       *uuid.UUID `json:"menu_item_id"`
	MaxDiscountCents *int64     `json:"max_discount_cents"`
}

// validateTiers checks the ladder as a whole, not tier by tier: thresholds must
// be unique, and the reward shape has to match its kind. Returns a human message
// ("" == valid).
func validateTiers(tiers []engageTierBody) string {
	if len(tiers) == 0 {
		return ""
	}
	if len(tiers) > 12 {
		return "a ladder of more than 12 tiers is unreadable on a phone"
	}
	seen := map[int]bool{}
	for i := range tiers {
		t := &tiers[i]
		t.Label = strings.TrimSpace(t.Label)
		if t.Label == "" {
			return "every tier needs a label — it is what the guest sees on the ladder"
		}
		if len(t.Label) > 80 {
			return "tier labels must be ≤ 80 characters"
		}
		if t.MinScore < 0 {
			return "a score threshold can't be negative"
		}
		if seen[t.MinScore] {
			return fmt.Sprintf("two tiers both start at %d points — thresholds must be distinct", t.MinScore)
		}
		seen[t.MinScore] = true

		switch t.RewardKind {
		case "percent":
			if t.PercentBP == nil || *t.PercentBP < 1 || *t.PercentBP > 10000 {
				return "a percent reward must be between 0.01% and 100%"
			}
			// Not a nicety: without a ceiling the budget cap is unenforceable,
			// because the cost of a percentage reward is unknown until it lands
			// on a bill. The DB CHECK enforces it too.
			if t.MaxDiscountCents == nil || *t.MaxDiscountCents <= 0 {
				return "a percent reward needs a maximum discount, or one big table could spend the whole budget"
			}
		case "flat":
			if t.AmountCents == nil || *t.AmountCents <= 0 {
				return "a flat reward needs an amount above zero"
			}
		case "free_item":
			if t.MenuItemID == nil {
				return "pick the menu item this tier gives away"
			}
		case "none":
			// The deliberate "so close" tier. Nothing to validate.
		default:
			return "reward kind must be percent, flat, free_item or none"
		}
	}
	return ""
}

// tierEstimatedValue is what a tier costs the budget when it is issued. Computed
// server-side and never accepted from the client, because the budget caps are
// enforced against it:
//
//	percent    → its max_discount_cents ceiling (the worst case, which is the
//	             only honest basis for a cap)
//	flat       → the amount
//	free_item  → the item's price at save time
//	none       → nothing
func tierEstimatedValue(r *http.Request, t engageTierBody) (int64, error) {
	switch t.RewardKind {
	case "percent":
		if t.MaxDiscountCents != nil {
			return *t.MaxDiscountCents, nil
		}
	case "flat":
		if t.AmountCents != nil {
			return *t.AmountCents, nil
		}
	case "free_item":
		if t.MenuItemID != nil {
			var price int64
			// RLS scopes this to the caller's tenant, so an id belonging to
			// another café simply finds no row — which is also the check that
			// stops a cross-tenant menu_item_id being stored.
			err := appctx.Tx(r.Context()).QueryRow(r.Context(),
				`SELECT price_cents FROM menu_items WHERE id = $1 AND deleted_at IS NULL`,
				*t.MenuItemID).Scan(&price)
			return price, err
		}
	}
	return 0, nil
}

// PutEngageTiers — PUT /v1/engage/tiers.
// Whole-list replace: the editor is one form with a Save button, so a partial
// PATCH per row would only invite the two sides to drift. Rows are rewritten in
// one transaction, which also means a failed validation leaves the old ladder
// exactly as it was.
func PutEngageTiers(w http.ResponseWriter, r *http.Request) {
	t, ok := appctx.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusBadRequest, "tenant_required", "")
		return
	}
	var body struct {
		Tiers []engageTierBody `json:"tiers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if msg := validateTiers(body.Tiers); msg != "" {
		writeErr(w, http.StatusBadRequest, "bad_request", msg)
		return
	}

	tx := appctx.Tx(r.Context())
	c, err := loadCurrentCampaign(r)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "save the campaign before adding reward tiers")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "engage.tiers.put", "campaign_id", c.ID, "count", len(body.Tiers))

	// Sort ascending so `sort` matches the ladder the guest climbs, whatever
	// order the editor sent them in.
	sorted := append([]engageTierBody(nil), body.Tiers...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].MinScore < sorted[j].MinScore })

	// Resolve every free-item value BEFORE deleting anything, so an unknown menu
	// item aborts with the old ladder intact.
	values := make([]int64, len(sorted))
	for i, tier := range sorted {
		v, err := tierEstimatedValue(r, tier)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusBadRequest, "bad_request",
				fmt.Sprintf("the menu item for the %s tier no longer exists", audit.Quote(tier.Label)))
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		values[i] = v
	}

	if _, err := tx.Exec(r.Context(), `DELETE FROM engage_tiers WHERE campaign_id = $1`, c.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	for i, tier := range sorted {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO engage_tiers
			  (tenant_id, campaign_id, min_score, label, reward_kind, percent_bp,
			   amount_cents, menu_item_id, max_discount_cents, estimated_value_cents, sort)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		`, t.ID, c.ID, tier.MinScore, tier.Label, tier.RewardKind, tier.PercentBP,
			tier.AmountCents, tier.MenuItemID, tier.MaxDiscountCents, values[i], i); err != nil {
			if strings.Contains(err.Error(), "engage_tiers_shape_coherent") {
				writeErr(w, http.StatusBadRequest, "bad_request",
					fmt.Sprintf("the %s tier is missing the value for a %s reward", audit.Quote(tier.Label), tier.RewardKind))
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "engage_tiers", EntityID: &c.ID,
		Summary: fmt.Sprintf("set %d reward tier(s) on campaign %s", len(sorted), audit.Quote(c.Name)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	tiers, err := loadTiers(r, c.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tiers": tiers})
}
