package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/config"
)

// =========================================================================
// ENGAGE — the public play surface (0065)
//
// Unauthenticated, world-readable, and it WRITES — which makes it the most
// sensitive surface in the app after auth itself. Four things about it differ
// from every other handler in this package, and each one is a bug if forgotten:
//
//  1. billing.RequireFeature CANNOT be used here. It reads billing.State, which
//     is only ever put on the context by auth.RequireMember. On /public there is
//     no state at all, so the middleware would 403 every guest. Each handler
//     calls billing.LoadStateTx itself — and returns 404, not 403, because the
//     world should not learn that a café exists but is on the wrong plan.
//
//  2. billing.WriteGate does not cover /public either. Without an explicit
//     WriteLocked check a trial-expired café would keep minting real discounts.
//
//  3. There is no app.user_id, only app.tenant_id. No query here may depend on
//     current_user_id(), and no row written here has an actor.
//
//  4. The guest is anonymous. Identity is a salted device hash, and every honest
//     limitation of that is documented at deviceHash.
//
// THE FIVE-MINUTE RULE
//
// A won code expires in reward_ttl_seconds (default 300) from the moment it is
// revealed. That is the feature's primary anti-abuse control: a code cannot be
// farmed at home, shared usefully, or stockpiled, because to spend it you have
// to be standing in the café with the countdown on your screen.
// =========================================================================

// playSessionTTL is how long a started run stays resumable. Long enough that a
// dropped connection or a phone call doesn't cost the guest their one winnable
// attempt of the day; short enough that a session can't be parked and cashed in
// hours later.
const playSessionTTL = 30 * time.Minute

// =========================================================================
// Identity
// =========================================================================

// deviceHash turns a client-supplied fingerprint into a stored identity.
//
// Peppered and tenant-scoped, so the stored value is neither enumerable nor
// correlatable across cafés — one café cannot tell that a guest also plays at
// another.
//
// The honest limits, because this is what the once-a-day gate rests on:
// fingerprints COLLIDE (two identical phone models on one café's NAT can hash
// alike) and they are RESETTABLE (clearing site data mints a new one). The
// client mixes a random localStorage id into its fingerprint, which trades
// collisions for resettability — deliberately, because a false "you already
// played today" is a worse guest experience than the occasional extra free
// coffee, and the budget caps are what actually bound the café's loss.
func deviceHash(tenantID uuid.UUID, fingerprint, pepper string) string {
	sum := sha256.Sum256([]byte(tenantID.String() + "|" + fingerprint + "|" + pepper))
	return hex.EncodeToString(sum[:])
}

// ipHash stores "which host" without storing a guest's IP address. Used only for
// the per-IP issuance backstop and for fraud review.
func ipHash(ip, pepper string) string {
	if ip == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(ip + "|" + pepper))
	return hex.EncodeToString(sum[:])
}

// newSessionToken mints the raw token handed to the guest once, plus the hash
// that is all we keep. Same discipline as ws_tickets and email OTPs: a database
// leak must not yield anything replayable.
func newSessionToken() (raw, hash string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	raw = base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(raw))
	return raw, hex.EncodeToString(sum[:]), nil
}

func hashSessionToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// =========================================================================
// Shared loading
// =========================================================================

// playCampaign is the live campaign plus everything the play flow needs.
type playCampaign struct {
	ID                    uuid.UUID
	Name                  string
	Game                  string
	Difficulty            string
	RewardTTLSeconds      int
	GraceSeconds          int
	AllowClaimWithoutPlay bool
	ContactCaptureEnabled bool
	Headline              string
	Subhead               string
	TermsText             string
	BudgetTotalCents      *int64
	BudgetDailyCents      *int64
	BudgetDailyCount      *int
}

// loadLiveCampaign returns the campaign a scan should resolve to: active, not
// deleted, and inside its date/day/time window in the CAFÉ's timezone. Returns
// pgx.ErrNoRows when the café has nothing running, which is a normal state and
// means "practice only", not an error.
func loadLiveCampaign(ctx context.Context, tz string) (playCampaign, error) {
	var c playCampaign
	err := appctx.Tx(ctx).QueryRow(ctx, `
		SELECT id, name, game, difficulty, reward_ttl_seconds, grace_seconds,
		       allow_claim_without_play, contact_capture_enabled, headline, subhead,
		       terms_text, budget_total_cents, budget_daily_cents, budget_daily_count
		FROM engage_campaigns
		WHERE status = 'active' AND deleted_at IS NULL
		  AND (starts_on IS NULL OR starts_on <= (now() AT TIME ZONE $1)::date)
		  AND (ends_on   IS NULL OR ends_on   >= (now() AT TIME ZONE $1)::date)
		  AND (active_days IS NULL OR cardinality(active_days) = 0
		       OR EXTRACT(DOW FROM (now() AT TIME ZONE $1))::smallint = ANY(active_days))
		  AND (active_from IS NULL OR (now() AT TIME ZONE $1)::time >= active_from)
		  AND (active_to   IS NULL OR (now() AT TIME ZONE $1)::time <= active_to)
		LIMIT 1
	`, tz).Scan(&c.ID, &c.Name, &c.Game, &c.Difficulty, &c.RewardTTLSeconds, &c.GraceSeconds,
		&c.AllowClaimWithoutPlay, &c.ContactCaptureEnabled, &c.Headline, &c.Subhead,
		&c.TermsText, &c.BudgetTotalCents, &c.BudgetDailyCents, &c.BudgetDailyCount)
	return c, err
}

// engageFeatureOK reports whether this café may serve the play page at all.
//
// Returns (ok=false) for a café without the feature — the caller 404s, matching
// what an unknown slug would do, so the endpoint reveals nothing about which
// cafés exist or what they pay for. writeLocked is separate: those cafés still
// get a playable page, just one that cannot mint rewards.
func engageFeatureOK(ctx context.Context, tenantID uuid.UUID) (ok, writeLocked bool, err error) {
	st, err := billing.LoadStateTx(ctx, appctx.Tx(ctx), tenantID)
	if err != nil {
		return false, false, err
	}
	return st.Has(billing.FeatureQRRewards), st.WriteLocked, nil
}

// budgetState is the campaign's spend so far, in one aggregate rather than
// denormalised counters — two sources of truth for a money-adjacent figure is
// the class of bug money.go exists to prevent.
type budgetState struct {
	TotalIssuedCents int64
	DayIssuedCents   int64
	DayIssuedCount   int
}

func loadBudgetState(ctx context.Context, campaignID uuid.UUID, tz string) (budgetState, error) {
	var b budgetState
	err := appctx.Tx(ctx).QueryRow(ctx, `
		SELECT COALESCE(SUM(estimated_value_cents), 0)::bigint,
		       COALESCE(SUM(estimated_value_cents) FILTER (WHERE issued_on = (now() AT TIME ZONE $2)::date), 0)::bigint,
		       count(*) FILTER (WHERE issued_on = (now() AT TIME ZONE $2)::date)
		FROM engage_codes
		WHERE campaign_id = $1 AND status <> 'void'
	`, campaignID, tz).Scan(&b.TotalIssuedCents, &b.DayIssuedCents, &b.DayIssuedCount)
	return b, err
}

// budgetExhausted reports whether the campaign can still afford the dearest tier
// a guest could reach.
//
// Checked at BOOTSTRAP, before anyone plays, which is the whole point: a guest
// who clears the top tier and is then told the till is dry has been played with.
// Better to open the page honestly in practice mode.
func budgetExhausted(c playCampaign, b budgetState, dearestTierCents int64) bool {
	if c.BudgetDailyCount != nil && b.DayIssuedCount >= *c.BudgetDailyCount {
		return true
	}
	if c.BudgetTotalCents != nil && b.TotalIssuedCents+dearestTierCents > *c.BudgetTotalCents {
		return true
	}
	if c.BudgetDailyCents != nil && b.DayIssuedCents+dearestTierCents > *c.BudgetDailyCents {
		return true
	}
	return false
}

// playTier is a ladder rung as the guest sees it, plus what issuing needs.
type playTier struct {
	ID          uuid.UUID
	MinScore    int
	Label       string
	RewardKind  string
	PercentBP   *int
	AmountCents *int64
	MenuItemID  *uuid.UUID
	MaxDiscount *int64
	EstValue    int64
}

func loadPlayTiers(ctx context.Context, campaignID uuid.UUID) ([]playTier, error) {
	rows, err := appctx.Tx(ctx).Query(ctx, `
		SELECT id, min_score, label, reward_kind, percent_bp, amount_cents,
		       menu_item_id, max_discount_cents, estimated_value_cents
		FROM engage_tiers WHERE campaign_id = $1 ORDER BY min_score
	`, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []playTier{}
	for rows.Next() {
		var t playTier
		if err := rows.Scan(&t.ID, &t.MinScore, &t.Label, &t.RewardKind, &t.PercentBP,
			&t.AmountCents, &t.MenuItemID, &t.MaxDiscount, &t.EstValue); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// dearestTierValue is the most a single play could cost the café.
func dearestTierValue(tiers []playTier) int64 {
	var max int64
	for _, t := range tiers {
		if t.EstValue > max {
			max = t.EstValue
		}
	}
	return max
}

// =========================================================================
// Wire types — a deliberately narrow projection
//
// This is the customer-facing DTO, in the same spirit as GetPublicMenu: the
// guest sees ladder LABELS and thresholds and nothing else. Reward VALUES,
// issuance limits, budget figures and menu_item_ids must never appear here —
// they would tell anyone reading the JSON exactly how to farm the campaign.
// =========================================================================

type publicPlayCafe struct {
	Name        string         `json:"name"`
	Slug        string         `json:"slug"`
	LogoURL     string         `json:"logo_url,omitempty"`
	AccentEmoji string         `json:"accent_emoji,omitempty"`
	Branding    map[string]any `json:"branding"`
}

type publicPlayTier struct {
	MinScore int    `json:"min_score"`
	Label    string `json:"label"`
}

type publicPlayCampaign struct {
	Game       string `json:"game"`
	Difficulty string `json:"difficulty"`
	Headline   string `json:"headline"`
	Subhead    string `json:"subhead"`
	TermsText  string `json:"terms_text"`
	// RewardTTLSeconds lets the page show the same countdown the cashier sees.
	RewardTTLSeconds      int  `json:"reward_ttl_seconds"`
	ContactCaptureEnabled bool `json:"contact_capture_enabled"`
	AllowClaimWithoutPlay bool `json:"allow_claim_without_play"`
}

type publicPlayBootstrap struct {
	Cafe     publicPlayCafe      `json:"cafe"`
	Campaign *publicPlayCampaign `json:"campaign"`
	Tiers    []publicPlayTier    `json:"tiers"`
	// CanWinToday is false once the device has spent its winnable attempt, when
	// nothing is running, or when the budget is done. The page stays playable
	// either way — practice is unlimited and framed as generosity.
	CanWinToday bool `json:"can_win_today"`
	// PracticeReason is deliberately coarse. "already_played_today",
	// "no_active_campaign", "rewards_claimed" — never anything that reveals how
	// close the budget is to running out.
	PracticeReason string `json:"practice_reason,omitempty"`
	// TodaysCode is the guest's live code, if they won one and it hasn't expired.
	// Returned so a refresh or an accidental back-button never loses it.
	TodaysCode *publicPlayCode `json:"todays_code,omitempty"`
}

type publicPlayCode struct {
	Code        string `json:"code"`
	Label       string `json:"label"`
	ExpiresAt   string `json:"expires_at"`
	SecondsLeft int    `json:"seconds_left"`
}

// =========================================================================
// POST /public/play/{slug}/bootstrap
// =========================================================================

// PlayBootstrap opens the play page: records the scan, works out whether this
// device can still win today, and returns the café's branding and ladder.
//
// It is a POST, not a GET, for two reasons: it writes a scan row, and it takes
// the device fingerprint in the BODY. A fingerprint in a query string would be
// copied into CDN logs, access logs and Referer headers — that is a tracking
// identifier, and it should not leak out of the request.
func PlayBootstrap(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := appctx.TenantFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		var body struct {
			Fingerprint string `json:"fingerprint"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Fingerprint) == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "fingerprint required")
			return
		}

		featureOK, writeLocked, err := engageFeatureOK(r.Context(), t.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !featureOK {
			// Same answer as an unknown slug: the world learns nothing about which
			// cafés exist or what plan they are on.
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}

		dev := deviceHash(t.ID, body.Fingerprint, cfg.EngageDevicePepper)
		out := publicPlayBootstrap{
			Cafe:  loadPlayCafe(r.Context(), t),
			Tiers: []publicPlayTier{},
		}

		camp, err := loadLiveCampaign(r.Context(), t.Timezone)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			out.PracticeReason = "no_active_campaign"
		case err != nil:
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		default:
			out.Campaign = &publicPlayCampaign{
				Game: camp.Game, Difficulty: camp.Difficulty, Headline: camp.Headline,
				Subhead: camp.Subhead, TermsText: camp.TermsText,
				RewardTTLSeconds:      camp.RewardTTLSeconds,
				ContactCaptureEnabled: camp.ContactCaptureEnabled,
				AllowClaimWithoutPlay: camp.AllowClaimWithoutPlay,
			}
		}

		// Record the scan even when nothing is running — "people are scanning the
		// tent but there's no campaign" is exactly the thing an owner needs to see.
		if err := recordScan(r.Context(), t, camp.ID, dev); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if out.Campaign != nil {
			tiers, err := loadPlayTiers(r.Context(), camp.ID)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			for _, tier := range tiers {
				out.Tiers = append(out.Tiers, publicPlayTier{MinScore: tier.MinScore, Label: tier.Label})
			}
			out.CanWinToday, out.PracticeReason, err = evaluateEligibility(
				r.Context(), t, camp, tiers, dev, writeLocked)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			out.TodaysCode, err = loadLiveCodeForDevice(r.Context(), t, dev)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}

		// Device-specific and it writes, so it must never be cached anywhere.
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, out)
	}
}

// loadPlayCafe builds the customer-safe café projection. Branding keys are
// ALLOW-LISTED rather than passed through, exactly as GetPublicMenu does.
func loadPlayCafe(ctx context.Context, t appctx.Tenant) publicPlayCafe {
	out := publicPlayCafe{Name: t.Name, Slug: t.Slug, Branding: map[string]any{}}
	var raw []byte
	if err := appctx.Tx(ctx).QueryRow(ctx,
		`SELECT branding FROM tenants WHERE id = $1`, t.ID).Scan(&raw); err != nil {
		return out
	}
	var branding map[string]any
	if json.Unmarshal(raw, &branding) != nil {
		return out
	}
	for _, k := range []string{"brandPrimary", "brandAccent", "mood", "typography"} {
		if v, ok := branding[k]; ok {
			out.Branding[k] = v
		}
	}
	if v, ok := branding["logoUrl"].(string); ok {
		out.LogoURL = v
	}
	if v, ok := branding["accentEmoji"].(string); ok {
		out.AccentEmoji = v
	}
	return out
}

// recordScan counts one device-day. Reloads bump `hits` rather than adding a
// row, so "scans" means "guests who opened it" and cannot be inflated by
// refreshing.
func recordScan(ctx context.Context, t appctx.Tenant, campaignID uuid.UUID, dev string) error {
	var camp *uuid.UUID
	if campaignID != uuid.Nil {
		camp = &campaignID
	}
	_, err := appctx.Tx(ctx).Exec(ctx, `
		INSERT INTO engage_scans (tenant_id, campaign_id, device_hash, scan_date)
		VALUES ($1, $2, $3, (now() AT TIME ZONE $4)::date)
		ON CONFLICT (tenant_id, device_hash, scan_date)
		DO UPDATE SET hits = engage_scans.hits + 1
	`, t.ID, camp, dev, t.Timezone)
	return err
}

// evaluateEligibility decides whether this device can still WIN today, and why
// not when it can't. The reasons are coarse on purpose — a precise "the budget
// has Rs 40 left" would be a free tuning guide for anyone farming the campaign.
func evaluateEligibility(ctx context.Context, t appctx.Tenant, camp playCampaign,
	tiers []playTier, dev string, writeLocked bool) (bool, string, error) {

	// A café that can't write shouldn't be handing out discounts. billing.WriteGate
	// does not reach /public, so this check is the only thing standing between a
	// trial-expired café and real money going out of the till.
	if writeLocked {
		return false, "rewards_unavailable", nil
	}
	if len(tiers) == 0 {
		return false, "no_rewards_configured", nil
	}

	// Budget FIRST, before anyone plays. Nobody clears the top tier and is then
	// told the till is dry.
	b, err := loadBudgetState(ctx, camp.ID, t.Timezone)
	if err != nil {
		return false, "", err
	}
	if budgetExhausted(camp, b, dearestTierValue(tiers)) {
		return false, "rewards_claimed", nil
	}

	var spent bool
	if err := appctx.Tx(ctx).QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM engage_sessions
		  WHERE device_hash = $1 AND play_day = (now() AT TIME ZONE $2)::date AND is_winnable
		)`, dev, t.Timezone).Scan(&spent); err != nil {
		return false, "", err
	}
	if spent {
		return false, "already_played_today", nil
	}
	return true, "", nil
}

// loadLiveCodeForDevice returns this device's still-valid code, so a refresh or
// a back-button never loses a prize the guest has already won.
func loadLiveCodeForDevice(ctx context.Context, t appctx.Tenant, dev string) (*publicPlayCode, error) {
	var c publicPlayCode
	var expires time.Time
	err := appctx.Tx(ctx).QueryRow(ctx, `
		SELECT c.code, c.label, c.expires_at
		FROM engage_codes c
		JOIN engage_sessions s ON s.id = c.session_id
		WHERE s.device_hash = $1 AND c.status = 'issued' AND c.expires_at > now()
		ORDER BY c.issued_at DESC LIMIT 1
	`, dev).Scan(&c.Code, &c.Label, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.ExpiresAt = expires.Format(time.RFC3339)
	c.SecondsLeft = int(time.Until(expires).Seconds())
	return &c, nil
}

// =========================================================================
// POST /public/play/{slug}/sessions
// =========================================================================

// StartPlaySession begins a run.
//
// THE WINNABLE ATTEMPT IS BURNED HERE, NOT AT SUBMIT. If it were spent on
// submit, a guest could start, see a bad score coming, abandon, and start again
// — unlimited retries, and score tiers would mean nothing. To keep that humane,
// an unfinished session for the same device is RESUMED for playSessionTTL, so a
// dropped connection or an interruption doesn't cost anyone their turn.
func StartPlaySession(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := appctx.TenantFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		var body struct {
			Fingerprint string `json:"fingerprint"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
			strings.TrimSpace(body.Fingerprint) == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "fingerprint required")
			return
		}

		featureOK, writeLocked, err := engageFeatureOK(r.Context(), t.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !featureOK {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}

		camp, err := loadLiveCampaign(r.Context(), t.Timezone)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "no_active_campaign", "there's no game running right now")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		dev := deviceHash(t.ID, body.Fingerprint, cfg.EngageDevicePepper)
		clientIP, _ := appctx.IP(r.Context())
		iph := ipHash(clientIP, cfg.EngageDevicePepper)
		tx := appctx.Tx(r.Context())

		// Resume an unfinished run before starting a new one.
		var existingID uuid.UUID
		var existingSeed int64
		err = tx.QueryRow(r.Context(), `
			SELECT id, seed FROM engage_sessions
			WHERE device_hash = $1 AND status = 'open' AND is_winnable
			  AND started_at > now() - $2::interval
			ORDER BY started_at DESC LIMIT 1
		`, dev, playSessionTTL.String()).Scan(&existingID, &existingSeed)
		if err == nil {
			// The raw token was only ever shown once, so a resumed session gets a
			// fresh one; the old hash is replaced.
			raw, hash, err := newSessionToken()
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if _, err := tx.Exec(r.Context(),
				`UPDATE engage_sessions SET session_token_hash = $2 WHERE id = $1`, existingID, hash); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"session_token": raw, "seed": existingSeed, "game": camp.Game,
				"difficulty": camp.Difficulty, "winnable": true, "resumed": true,
			})
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		tiers, err := loadPlayTiers(r.Context(), camp.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		winnable, _, err := evaluateEligibility(r.Context(), t, camp, tiers, dev, writeLocked)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		seed, err := rand.Int(rand.Reader, big.NewInt(1<<52))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		raw, hash, err := newSessionToken()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		ua := r.UserAgent()
		if len(ua) > 400 {
			ua = ua[:400]
		}

		// The daily gate is the partial unique index, not a read-then-write check:
		// two tabs racing cannot both come away winnable.
		var sessionID uuid.UUID
		err = tx.QueryRow(r.Context(), `
			INSERT INTO engage_sessions
			  (tenant_id, campaign_id, session_token_hash, device_hash, ip_hash, play_day,
			   is_winnable, game, difficulty, seed, user_agent)
			VALUES ($1,$2,$3,$4,$5,(now() AT TIME ZONE $6)::date,$7,$8,$9,$10,$11)
			ON CONFLICT (tenant_id, device_hash, play_day) WHERE is_winnable DO NOTHING
			RETURNING id
		`, t.ID, camp.ID, hash, dev, iph,
			t.Timezone, winnable, camp.Game, camp.Difficulty, seed.Int64(), ua).Scan(&sessionID)

		if errors.Is(err, pgx.ErrNoRows) {
			// Another session already holds today's winnable slot. Fall back to a
			// practice run rather than refusing — practice is unlimited by design.
			winnable = false
			err = tx.QueryRow(r.Context(), `
				INSERT INTO engage_sessions
				  (tenant_id, campaign_id, session_token_hash, device_hash, ip_hash, play_day,
				   is_winnable, game, difficulty, seed, user_agent)
				VALUES ($1,$2,$3,$4,$5,(now() AT TIME ZONE $6)::date,false,$7,$8,$9,$10)
				RETURNING id
			`, t.ID, camp.ID, hash, dev, iph,
				t.Timezone, camp.Game, camp.Difficulty, seed.Int64(), ua).Scan(&sessionID)
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{
			"session_token": raw, "seed": seed.Int64(), "game": camp.Game,
			"difficulty": camp.Difficulty, "winnable": winnable,
		})
	}
}

// =========================================================================
// POST /public/play/{slug}/sessions/score
// =========================================================================

// SubmitPlayScore closes a run and, when it was winnable and cleared a tier,
// mints the code.
//
// Idempotent by construction: a session already marked completed returns its
// stored outcome unchanged, so a retry over flaky café wifi can never mint a
// second code.
func SubmitPlayScore(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := appctx.TenantFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		var body struct {
			SessionToken string          `json:"session_token"`
			Score        int             `json:"score"`
			ElapsedMS    int             `json:"elapsed_ms"`
			Events       int             `json:"events"`
			Trace        json.RawMessage `json:"trace"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionToken == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "session_token required")
			return
		}
		// The trace is stored for a possible future replay check, never trusted.
		// Cap it so a guest cannot post a megabyte per play.
		if len(body.Trace) > 8*1024 {
			body.Trace = nil
		}

		featureOK, _, err := engageFeatureOK(r.Context(), t.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !featureOK {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}

		tx := appctx.Tx(r.Context())
		var (
			sessionID  uuid.UUID
			campaignID *uuid.UUID
			game       string
			status     string
			outcome    string
			isWinnable bool
			startedAt  time.Time
		)
		err = tx.QueryRow(r.Context(), `
			SELECT id, campaign_id, game, status, outcome, is_winnable, started_at
			FROM engage_sessions WHERE session_token_hash = $1 FOR UPDATE
		`, hashSessionToken(body.SessionToken)).Scan(&sessionID, &campaignID, &game,
			&status, &outcome, &isWinnable, &startedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "session_not_found", "that game has expired — scan again to play")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Replay: hand back exactly what the first submit decided.
		if status == "completed" || status == "flagged" {
			code, err := loadCodeForSession(r.Context(), sessionID)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"outcome": outcome, "code": code, "replayed": true,
			})
			return
		}

		serverElapsed := int(time.Since(startedAt).Milliseconds())
		ok2, reason := validateScore(scoreSubmission{
			Game: game, Score: body.Score, ServerElapsedMS: serverElapsed, EventCount: body.Events,
		})
		if !ok2 {
			if _, err := tx.Exec(r.Context(), `
				UPDATE engage_sessions SET status='flagged', outcome='rejected', reject_reason=$2,
				  score=$3, client_elapsed_ms=$4, server_elapsed_ms=$5, event_count=$6,
				  input_trace=$7, completed_at=now()
				WHERE id=$1`, sessionID, reason, body.Score, body.ElapsedMS, serverElapsed,
				body.Events, body.Trace); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			// Sampled by the alert throttle; a burst means someone is probing.
			alert.Fire(r.Context(), slog.LevelWarn, "engage.score.rejected", nil,
				"tenant", t.Slug, "game", game, "reason", reason, "score", body.Score)
			// The guest is told nothing specific — naming the bound they tripped
			// would be a free tuning guide.
			writeErr(w, http.StatusBadRequest, "implausible_score", "that score couldn't be verified")
			return
		}

		newOutcome := "practice"
		var issued *publicPlayCode
		if isWinnable && campaignID != nil {
			newOutcome, issued, err = issueRewardForScore(r.Context(), t, *campaignID, sessionID, body.Score)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE engage_sessions SET status='completed', outcome=$2, score=$3,
			  client_elapsed_ms=$4, server_elapsed_ms=$5, event_count=$6, input_trace=$7,
			  completed_at=now()
			WHERE id=$1`, sessionID, newOutcome, body.Score, body.ElapsedMS, serverElapsed,
			body.Events, body.Trace); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"outcome": newOutcome, "score": body.Score, "code": issued,
		})
	}
}

// loadCodeForSession returns the code a session already minted, if any.
func loadCodeForSession(ctx context.Context, sessionID uuid.UUID) (*publicPlayCode, error) {
	var c publicPlayCode
	var expires time.Time
	err := appctx.Tx(ctx).QueryRow(ctx, `
		SELECT code, label, expires_at FROM engage_codes WHERE session_id = $1
	`, sessionID).Scan(&c.Code, &c.Label, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.ExpiresAt = expires.Format(time.RFC3339)
	c.SecondsLeft = int(time.Until(expires).Seconds())
	return &c, nil
}

// issueRewardForScore resolves the tier and mints the code, re-checking the
// budget inside the same transaction that writes it.
//
// Returns ("no_reward", nil, nil) when the score cleared nothing or the budget
// ran out between bootstrap and submit — the guest sees the same "so close"
// screen either way, because telling them "you won but the till is dry" is worse
// than telling them nothing.
func issueRewardForScore(ctx context.Context, t appctx.Tenant, campaignID, sessionID uuid.UUID,
	score int) (string, *publicPlayCode, error) {

	tx := appctx.Tx(ctx)
	// Serialise issuance for this campaign so two guests finishing at the same
	// instant cannot both slip past the last of the budget.
	var camp playCampaign
	if err := tx.QueryRow(ctx, `
		SELECT id, reward_ttl_seconds, grace_seconds, budget_total_cents,
		       budget_daily_cents, budget_daily_count
		FROM engage_campaigns WHERE id = $1 FOR UPDATE
	`, campaignID).Scan(&camp.ID, &camp.RewardTTLSeconds, &camp.GraceSeconds,
		&camp.BudgetTotalCents, &camp.BudgetDailyCents, &camp.BudgetDailyCount); err != nil {
		return "", nil, err
	}

	tiers, err := loadPlayTiers(ctx, campaignID)
	if err != nil {
		return "", nil, err
	}
	scoreTiers := make([]scoreTier, 0, len(tiers))
	byID := map[string]playTier{}
	for _, tier := range tiers {
		scoreTiers = append(scoreTiers, scoreTier{
			ID: tier.ID.String(), MinScore: tier.MinScore, RewardKind: tier.RewardKind,
		})
		byID[tier.ID.String()] = tier
	}
	won := resolveTier(scoreTiers, score)
	if won == nil || won.RewardKind == "none" {
		return "no_reward", nil, nil
	}
	tier := byID[won.ID]

	// A free-item tier whose menu item has since been deleted has nothing to give
	// away. Treat it as a miss rather than minting a code that cannot be redeemed.
	if tier.RewardKind == "free_item" && tier.MenuItemID == nil {
		return "no_reward", nil, nil
	}

	b, err := loadBudgetState(ctx, campaignID, t.Timezone)
	if err != nil {
		return "", nil, err
	}
	if budgetExhausted(camp, b, tier.EstValue) {
		alert.Fire(ctx, slog.LevelWarn, "engage.budget_exhausted", nil,
			"tenant", t.Slug, "campaign", campaignID.String())
		return "no_reward", nil, nil
	}

	ttl := time.Duration(camp.RewardTTLSeconds) * time.Second
	grace := time.Duration(camp.GraceSeconds) * time.Second

	// Retry on the astronomically unlikely code collision rather than trusting
	// the odds — the unique index is there, so honour it.
	for attempt := 0; attempt < 5; attempt++ {
		display, norm, err := generateRewardCode()
		if err != nil {
			return "", nil, err
		}
		var expires time.Time
		err = tx.QueryRow(ctx, `
			INSERT INTO engage_codes
			  (tenant_id, campaign_id, tier_id, session_id, code, code_norm, reward_kind,
			   label, percent_bp, amount_cents, menu_item_id, max_discount_cents,
			   estimated_value_cents, issued_on, expires_at, grace_until)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
			        (now() AT TIME ZONE $14)::date, now() + $15::interval,
			        now() + $15::interval + $16::interval)
			RETURNING expires_at
		`, t.ID, campaignID, tier.ID, sessionID, display, norm, tier.RewardKind, tier.Label,
			tier.PercentBP, tier.AmountCents, tier.MenuItemID, tier.MaxDiscount, tier.EstValue,
			t.Timezone, ttl.String(), grace.String()).Scan(&expires)
		if err == nil {
			return "win", &publicPlayCode{
				Code: display, Label: tier.Label,
				ExpiresAt:   expires.Format(time.RFC3339),
				SecondsLeft: int(time.Until(expires).Seconds()),
			}, nil
		}
		if !strings.Contains(err.Error(), "engage_codes_tenant_norm_uniq") {
			return "", nil, err
		}
	}
	return "", nil, errors.New("could not mint a unique reward code")
}

// =========================================================================
// POST /public/play/{slug}/sessions/contact
// =========================================================================

// SubmitPlayContact stores an opted-in guest contact.
//
// Consent is not optional and not implied: the row cannot exist without it (a
// CHECK in 0065), and the exact wording the guest agreed to is stored alongside.
// The reward works whether or not they opt in — consent is never the price of
// the prize.
func SubmitPlayContact(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := appctx.TenantFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}
		var body struct {
			SessionToken       string `json:"session_token"`
			Name               string `json:"name"`
			Email              string `json:"email"`
			Phone              string `json:"phone"`
			Consent            bool   `json:"consent"`
			ConsentTextVersion string `json:"consent_text_version"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SessionToken == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "session_token required")
			return
		}
		if !body.Consent {
			// Belt and braces with the DB CHECK. A contact row without consent is
			// not a row we are willing to hold.
			writeErr(w, http.StatusBadRequest, "consent_required", "we can only save your details if you agree")
			return
		}
		body.Email = strings.ToLower(strings.TrimSpace(body.Email))
		body.Phone = strings.TrimSpace(body.Phone)
		body.Name = strings.TrimSpace(body.Name)
		if body.Email == "" && body.Phone == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "an email or a phone number is needed")
			return
		}
		if len(body.Name) > 120 || len(body.Email) > 200 || len(body.Phone) > 40 {
			writeErr(w, http.StatusBadRequest, "bad_request", "those details are too long")
			return
		}

		featureOK, _, err := engageFeatureOK(r.Context(), t.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !featureOK {
			writeErr(w, http.StatusNotFound, "not_found", "")
			return
		}

		tx := appctx.Tx(r.Context())
		var sessionID uuid.UUID
		var campaignID *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT id, campaign_id FROM engage_sessions
			WHERE session_token_hash = $1 AND status = 'completed'
		`, hashSessionToken(body.SessionToken)).Scan(&sessionID, &campaignID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "session_not_found", "finish your game first")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		key := body.Email + "|" + digitsOnly(body.Phone)
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO engage_contacts
			  (tenant_id, session_id, campaign_id, name, email, phone, contact_key,
			   consent, consent_text_version)
			VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)
			ON CONFLICT (tenant_id, contact_key) DO UPDATE
			  SET last_seen_at = now(),
			      times_seen   = engage_contacts.times_seen + 1,
			      name         = COALESCE(NULLIF(EXCLUDED.name, ''), engage_contacts.name)
		`, t.ID, sessionID, campaignID, body.Name, body.Email, body.Phone, key,
			body.ConsentTextVersion); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Deliberately says nothing about whether we already knew them — that
		// would leak one guest's history to whoever is holding the phone.
		writeJSON(w, http.StatusOK, map[string]any{"saved": true})
	}
}

// digitsOnly reduces a phone number to comparable digits, so "+977 98-1234"
// and "9779812 34" dedupe to the same guest.
func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
