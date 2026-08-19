package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// =========================================================================
// ENGAGE — reward redemption at the till (0065)
//
// A guest shows the cashier a code with a live countdown; the cashier types it
// into the POS while the tab is still open. Redemption writes an ORDINARY
// order_adjustments row of type 'discount' and nothing else, which is what keeps
// buildQuote, CloseOrder, every report and platform_accuracy_check() working
// with no edits. The link back to the reward lives on engage_redemptions.
//
// Two invariants this file is responsible for:
//
//	* the applied discount NEVER exceeds remainingDiscountHeadroom, or the
//	  stored order columns stop reconciling;
//	* a code is spent at most once, enforced by SELECT ... FOR UPDATE plus the
//	  partial unique indexes, so a double-tap on a flaky connection cannot
//	  produce two discounts.
// =========================================================================

// normalizeRewardCode makes a typed code comparable: upper-cased with dashes and
// spaces stripped. Cashiers type these off a phone screen mid-service, so
// "tea-7k2m", "TEA 7K2M" and "TEA7K2M" all have to find the same row.
func normalizeRewardCode(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(s)) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// rewardCode is the loaded code plus everything redemption needs to decide.
type rewardCode struct {
	ID          uuid.UUID
	CampaignID  uuid.UUID
	Code        string
	Label       string
	RewardKind  string
	PercentBP   *int
	AmountCents *int64
	MenuItemID  *uuid.UUID
	MaxDiscount *int64
	Status      string
	ExpiresAt   time.Time
	GraceUntil  time.Time
}

// RewardLookup is what the POS shows the cashier before they commit.
type RewardLookup struct {
	Code       string `json:"code"`
	Label      string `json:"label"`
	RewardKind string `json:"reward_kind"`
	Status     string `json:"status"`
	ExpiresAt  string `json:"expires_at"`
	// SecondsLeft is negative once expired; the POS uses it to show the
	// countdown the guest is also watching.
	SecondsLeft int `json:"seconds_left"`
	// Expired but still honourable — the cashier is offered an explicit override
	// so a guest is never punished for the café's own queue.
	NeedsGraceOverride bool `json:"needs_grace_override"`
	Redeemable         bool `json:"redeemable"`
	// BlockedReason is a sentence for the cashier, not an error kind. Empty when
	// the code can be applied.
	BlockedReason string `json:"blocked_reason,omitempty"`
	// AppliesCents is what would actually come off THIS bill, after capping and
	// clamping. Only set when an order_id was supplied.
	AppliesCents *int64 `json:"applies_cents,omitempty"`
	WouldClamp   bool   `json:"would_clamp,omitempty"`
}

// loadRewardCode reads a code by its normalised form. RLS scopes the SELECT to
// the caller's tenant, so a code minted by another café simply does not exist
// here — that is the cross-tenant check, and it needs no handler logic.
func loadRewardCode(ctx context.Context, norm string, forUpdate bool) (rewardCode, error) {
	q := `
		SELECT id, campaign_id, code, label, reward_kind, percent_bp, amount_cents,
		       menu_item_id, max_discount_cents, status, expires_at, grace_until
		FROM engage_codes WHERE code_norm = $1`
	if forUpdate {
		// Serialises concurrent redeems of the same code; the second waits and
		// then sees status = 'redeemed'.
		q += " FOR UPDATE"
	}
	var c rewardCode
	err := appctx.Tx(ctx).QueryRow(ctx, q, norm).Scan(&c.ID, &c.CampaignID, &c.Code, &c.Label,
		&c.RewardKind, &c.PercentBP, &c.AmountCents, &c.MenuItemID, &c.MaxDiscount,
		&c.Status, &c.ExpiresAt, &c.GraceUntil)
	return c, err
}

// orderSubtotal is the non-voided line total. Percent rewards apply to THIS, not
// to subtotal + service charge: "10% off" means ten percent off the food, which
// is what both the owner and the guest understand it to mean.
func orderSubtotal(ctx context.Context, orderID uuid.UUID) (int64, error) {
	var subtotal int64
	err := appctx.Tx(ctx).QueryRow(ctx, `
		SELECT COALESCE(SUM(qty * unit_price_cents), 0)::bigint
		FROM order_items WHERE order_id = $1 AND voided_at IS NULL
	`, orderID).Scan(&subtotal)
	return subtotal, err
}

// rewardValueForOrder works out what a code is worth against one specific bill.
// Returns the intended amount (before the headroom clamp), the order item a
// free-item reward consumed, and a cashier-readable reason when it cannot apply
// at all.
func rewardValueForOrder(ctx context.Context, c rewardCode, orderID uuid.UUID) (int64, *uuid.UUID, string, error) {
	switch c.RewardKind {
	case "flat":
		if c.AmountCents == nil {
			return 0, nil, "this reward has no amount set", nil
		}
		return *c.AmountCents, nil, "", nil

	case "percent":
		if c.PercentBP == nil {
			return 0, nil, "this reward has no percentage set", nil
		}
		subtotal, err := orderSubtotal(ctx, orderID)
		if err != nil {
			return 0, nil, "", err
		}
		amount := subtotal * int64(*c.PercentBP) / 10000
		// The ceiling is what makes a percentage reward's cost knowable, and it
		// is required on every percent tier for exactly that reason.
		if c.MaxDiscount != nil && amount > *c.MaxDiscount {
			amount = *c.MaxDiscount
		}
		if amount <= 0 {
			return 0, nil, "there's nothing on this tab to discount yet", nil
		}
		return amount, nil, "", nil

	case "free_item":
		if c.MenuItemID == nil {
			// The tier's menu item was deleted after the code was issued. The code
			// is not the guest's fault, but there is nothing to give away.
			return 0, nil, "the item this reward gives away is no longer on the menu", nil
		}
		// The CHEAPEST matching line, so a guest with two of the item gets the
		// same reward either way and the café is never charged for the dearer one.
		var itemID uuid.UUID
		var price int64
		var name string
		err := appctx.Tx(ctx).QueryRow(ctx, `
			SELECT oi.id, oi.unit_price_cents, mi.name
			FROM order_items oi
			JOIN menu_items mi ON mi.id = oi.menu_item_id
			WHERE oi.order_id = $1 AND oi.menu_item_id = $2 AND oi.voided_at IS NULL
			ORDER BY oi.unit_price_cents
			LIMIT 1
		`, orderID, *c.MenuItemID).Scan(&itemID, &price, &name)
		if errors.Is(err, pgx.ErrNoRows) {
			var itemName string
			_ = appctx.Tx(ctx).QueryRow(ctx,
				`SELECT name FROM menu_items WHERE id = $1`, *c.MenuItemID).Scan(&itemName)
			if itemName == "" {
				itemName = "the reward item"
			}
			return 0, nil, fmt.Sprintf("add %s to the tab first — this reward pays for one", itemName), nil
		}
		if err != nil {
			return 0, nil, "", err
		}
		// ONE unit, never qty × price: the reward is "a free tea", not "free tea
		// however many you ordered".
		return price, &itemID, "", nil
	}
	return 0, nil, "this reward can't be applied", nil
}

// rewardBlockedReason reports why a code cannot be used at all, independent of
// any particular bill. Empty means usable (possibly needing a grace override).
func rewardBlockedReason(c rewardCode, now time.Time) string {
	switch c.Status {
	case "redeemed":
		return "this code has already been used"
	case "void":
		return "this code was cancelled"
	}
	if now.After(c.GraceUntil) {
		return "this code has expired"
	}
	return ""
}

// LookupRewardCode — GET /v1/engage/codes/{code}?order_id=…
// A dry run: it writes nothing, and tells the cashier exactly what would happen,
// including the amount after clamping. This is what the POS shows before the
// cashier commits.
func LookupRewardCode(w http.ResponseWriter, r *http.Request) {
	norm := normalizeRewardCode(chi.URLParam(r, "code"))
	if norm == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "reward code required")
		return
	}

	c, err := loadRewardCode(r.Context(), norm, false)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "code_not_found", "no reward with that code")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	now := time.Now()
	out := RewardLookup{
		Code:               c.Code,
		Label:              c.Label,
		RewardKind:         c.RewardKind,
		Status:             c.Status,
		ExpiresAt:          c.ExpiresAt.Format(time.RFC3339),
		SecondsLeft:        int(time.Until(c.ExpiresAt).Seconds()),
		NeedsGraceOverride: now.After(c.ExpiresAt) && !now.After(c.GraceUntil),
		BlockedReason:      rewardBlockedReason(c, now),
	}
	out.Redeemable = out.BlockedReason == ""

	// With an order in hand we can also say what it is worth on THIS bill.
	if raw := r.URL.Query().Get("order_id"); raw != "" && out.Redeemable {
		orderID, err := uuid.Parse(raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
			return
		}
		intended, _, reason, err := rewardValueForOrder(r.Context(), c, orderID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if reason != "" {
			out.Redeemable = false
			out.BlockedReason = reason
		} else {
			headroom, err := remainingDiscountHeadroom(r.Context(), orderID)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			applies := intended
			if headroom <= 0 {
				out.Redeemable = false
				out.BlockedReason = "this tab is already fully discounted"
			} else if applies > headroom {
				applies = headroom
				out.WouldClamp = true
			}
			out.AppliesCents = &applies
		}
	}

	writeJSON(w, http.StatusOK, out)
}

// RedeemRewardCode — POST /v1/engage/codes/{code}/redeem  {order_id}.
func RedeemRewardCode(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		user, _ := appctx.UserFromContext(r.Context())

		norm := normalizeRewardCode(chi.URLParam(r, "code"))
		if norm == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "reward code required")
			return
		}
		var body struct {
			OrderID uuid.UUID `json:"order_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OrderID == uuid.Nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "order_id required")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "engage.redeem", "order_id", body.OrderID)

		tx := appctx.Tx(r.Context())
		c, err := loadRewardCode(r.Context(), norm, true)
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "code_not_found", "no reward with that code")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Idempotency BEFORE the status guard. A POS retrying over flaky café wifi
		// must get the same answer as the first attempt, not an error telling the
		// cashier a code they just applied is already used.
		if c.Status == "redeemed" {
			var existingOrder uuid.UUID
			var amount int64
			err := tx.QueryRow(r.Context(), `
				SELECT order_id, amount_cents FROM engage_redemptions
				WHERE code_id = $1 AND reverted_at IS NULL
			`, c.ID).Scan(&existingOrder, &amount)
			if err == nil && existingOrder == body.OrderID {
				writeJSON(w, http.StatusOK, map[string]any{
					"code": c.Code, "label": c.Label, "amount_cents": amount, "already_applied": true,
				})
				return
			}
			if err == nil {
				writeErr(w, http.StatusConflict, "code_already_redeemed",
					"this code was already used on another tab")
				return
			}
		}

		now := time.Now()
		if reason := rewardBlockedReason(c, now); reason != "" {
			kind := "code_expired"
			if c.Status == "redeemed" {
				kind = "code_already_redeemed"
			} else if c.Status == "void" {
				kind = "code_void"
			}
			writeErr(w, http.StatusConflict, kind, reason)
			return
		}
		graceOverride := now.After(c.ExpiresAt)

		// The order must be open: CloseOrder freezes the totals via buildQuote and
		// nothing rewrites them afterwards, so a reward applied to a settled tab
		// would be money the café gave away without it appearing anywhere.
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status::text FROM orders WHERE id = $1 FOR UPDATE`, body.OrderID).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "not_found", "no such tab")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if status != "open" {
			writeErr(w, http.StatusConflict, "order_not_open",
				"this tab is already "+status+" — a reward has to go on before it's settled")
			return
		}

		intended, orderItemID, reason, err := rewardValueForOrder(r.Context(), c, body.OrderID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if reason != "" {
			// The code is deliberately NOT consumed: the guest can still use it on
			// this tab once the item is added, or on another one.
			writeErr(w, http.StatusConflict, "reward_not_applicable", reason)
			return
		}

		headroom, err := remainingDiscountHeadroom(r.Context(), body.OrderID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if headroom <= 0 {
			writeErr(w, http.StatusConflict, "discount_exceeds_bill",
				"this tab is already fully discounted — the reward can be used on another one")
			return
		}
		// Clamp rather than refuse: a Rs 200 reward on a Rs 150 bill should take
		// Rs 150 off, not throw an error at the counter with a guest watching.
		// Both figures are recorded so reward-cost reporting never overstates
		// itself.
		applied := intended
		clamped := false
		if applied > headroom {
			applied = headroom
			clamped = true
		}

		// The SAME shape as a manual discount. This is the line that keeps
		// buildQuote, CloseOrder and platform_accuracy_check() working unchanged.
		var adjID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO order_adjustments
			  (tenant_id, order_id, type, amount_cents, reason, applied_by_user_id, approved_by_user_id)
			VALUES ($1, $2, 'discount', $3, 'promotion', $4, $4)
			RETURNING id
		`, t.ID, body.OrderID, applied, user.ID).Scan(&adjID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if _, err := tx.Exec(r.Context(), `
			INSERT INTO engage_redemptions
			  (tenant_id, code_id, order_id, order_adjustment_id, order_item_id,
			   amount_cents, intended_amount_cents, was_clamped, was_grace_override,
			   redeemed_on, redeemed_by_user_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(now() AT TIME ZONE $10)::date,$11)
		`, t.ID, c.ID, body.OrderID, adjID, orderItemID, applied, intended, clamped,
			graceOverride, t.Timezone, user.ID); err != nil {
			// The one-reward-per-bill index. A race between two tablets lands here.
			if strings.Contains(err.Error(), "engage_redemptions_one_per_order") {
				writeErr(w, http.StatusConflict, "order_already_has_reward",
					"this tab already has a reward on it")
				return
			}
			if strings.Contains(err.Error(), "engage_redemptions_one_per_code") {
				writeErr(w, http.StatusConflict, "code_already_redeemed",
					"this code was already used")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if _, err := tx.Exec(r.Context(),
			`UPDATE engage_codes SET status = 'redeemed' WHERE id = $1`, c.ID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// audit.Log no-ops for tenants without the audit_logs feature, which is
		// most of them — the durable trail is the engage_redemptions row plus
		// order_adjustments.applied_by_user_id.
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "redeem", Entity: "engage_code", EntityID: &c.ID,
			Summary: fmt.Sprintf("redeemed QR reward %s (%s) for %s",
				c.Code, audit.Quote(c.Label), audit.Money(applied)),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic:  realtime.TopicOrders,
			Action: "order.adjustment.applied",
			Ref:    map[string]any{"order_id": body.OrderID.String(), "adjustment_id": adjID.String()},
		})

		writeJSON(w, http.StatusCreated, map[string]any{
			"code":                  c.Code,
			"label":                 c.Label,
			"amount_cents":          applied,
			"intended_amount_cents": intended,
			"was_clamped":           clamped,
			"was_grace_override":    graceOverride,
			"adjustment_id":         adjID,
		})
	}
}

// revertRewardForAdjustment hands a QR reward code back when the discount it
// created is removed from a bill. Returns the code that was returned (""
// when the adjustment was an ordinary manual discount, which is the common case).
//
// Called from RemoveOrderAdjustment BEFORE the delete. Without it, a cashier
// correcting a bill would silently burn the guest's reward: the discount comes
// off, and the code is left marked 'redeemed' with nothing to show for it.
//
// The revert is a soft one — engage_redemptions keeps the row and stamps
// reverted_at — so the history of "this code was applied and then taken off"
// survives, which matters when a café is working out where its reward budget
// went. Both partial unique indexes are WHERE reverted_at IS NULL, so the code
// is immediately redeemable again.
func revertRewardForAdjustment(ctx context.Context, adjustmentID uuid.UUID) (string, error) {
	tx := appctx.Tx(ctx)

	var redemptionID, codeID uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id, code_id FROM engage_redemptions
		WHERE order_adjustment_id = $1 AND reverted_at IS NULL
		FOR UPDATE
	`, adjustmentID).Scan(&redemptionID, &codeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil // an ordinary discount — nothing to hand back
	}
	if err != nil {
		return "", err
	}

	if _, err := tx.Exec(ctx,
		`UPDATE engage_redemptions SET reverted_at = now() WHERE id = $1`, redemptionID); err != nil {
		return "", err
	}

	// Back to 'issued', not 'void': the guest earned it and it may still be
	// inside its window.
	var code string
	if err := tx.QueryRow(ctx,
		`UPDATE engage_codes SET status = 'issued' WHERE id = $1 RETURNING code`,
		codeID).Scan(&code); err != nil {
		return "", err
	}
	return code, nil
}
