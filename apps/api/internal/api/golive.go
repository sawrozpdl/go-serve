package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
)

// =========================================================================
// Go-live: a one-time opening-balances seed for a freshly created cafe.
//
// Every balance in this system is DERIVED from ledger rows (there are no
// stored balance columns), so "seed the opening money state" means insert the
// right opening ledger rows:
//
//   - drawer cash      -> open the first shift with opening_float_cents
//   - bank / online    -> opening payment_method rows on a synthetic order
//   - house-tab debts  -> a 'house_tab' charge per tab (= outstanding owed)
//   - owner equity      -> owner_ledger investments flagged is_opening=true
//                          (count for ROI, excluded from the live bank tile)
//   - owner cash held  -> owner_cash_entries withdrawals with no paired drop
//   - active tabs       -> open orders carrying their real (unpaid) items
//
// Guarded by a one-time wentLiveAt marker in tenants.preferences. Owner-only
// (finance:invest). Runs in the request transaction, so a failure anywhere
// rolls the whole seed back — a half-seeded cafe never persists.
// =========================================================================

// openingBalanceMarker tags the synthetic order that anchors opening asset and
// house-tab payments (payments.order_id is NOT NULL). The order is 'cancelled'
// so it stays out of sales history / revenue / floor lists; its payments still
// feed the balance roll-ups, which sum payments directly with no order join.
const openingBalanceMarker = "__OPENING_BALANCE__"

// errAlreadyLive is returned when the one-time seed has already run.
var errAlreadyLive = errors.New("tenant has already gone live")

// goLiveBadInput is a 400-class error (bad owner/tab/menu reference) surfaced
// to the caller as a clean message rather than a 500.
type goLiveBadInput struct{ msg string }

func (e goLiveBadInput) Error() string { return e.msg }

type GoLiveOwnerSpec struct {
	OwnerID         uuid.UUID `json:"owner_id"`
	InvestmentCents int64     `json:"investment_cents"`
	CashHeldCents   int64     `json:"cash_held_cents"`
}

type GoLiveHouseTabSpec struct {
	HouseTabID       uuid.UUID `json:"house_tab_id"`
	OutstandingCents int64     `json:"outstanding_cents"`
}

type GoLiveTabItem struct {
	MenuItemID uuid.UUID `json:"menu_item_id"`
	Qty        int       `json:"qty"`
}

type GoLiveCustomerTabSpec struct {
	ServiceTableID *uuid.UUID      `json:"service_table_id"`
	Notes          string          `json:"notes"`
	Items          []GoLiveTabItem `json:"items"`
}

type GoLiveSpec struct {
	DrawerCents  int64                   `json:"drawer_cents"`
	BankCents    int64                   `json:"bank_cents"`
	OnlineCents  int64                   `json:"online_cents"`
	Owners       []GoLiveOwnerSpec       `json:"owners"`
	HouseTabs    []GoLiveHouseTabSpec    `json:"house_tabs"`
	CustomerTabs []GoLiveCustomerTabSpec `json:"customer_tabs"`
}

// GET /v1/finance/go-live — reports whether this cafe has already gone live,
// so the wizard can hide itself once the one-time seed has run.
func GetGoLiveStatus(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	var wentLiveAt *time.Time
	if err := tx.QueryRow(r.Context(),
		`SELECT (preferences->>'wentLiveAt')::timestamptz FROM tenants WHERE id = $1`, t.ID,
	).Scan(&wentLiveAt); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"went_live_at": wentLiveAt})
}

// POST /v1/finance/go-live — runs the one-time opening-balances seed.
func GoLive(hub *realtime.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		user, _ := appctx.UserFromContext(r.Context())

		var spec GoLiveSpec
		if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
			return
		}
		if spec.DrawerCents < 0 || spec.BankCents < 0 || spec.OnlineCents < 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "amounts must be >= 0")
			return
		}

		tx := appctx.Tx(r.Context())
		if err := seedGoLive(r.Context(), tx, t.ID, user.ID, spec); err != nil {
			var bad goLiveBadInput
			switch {
			case errors.Is(err, errAlreadyLive):
				writeErr(w, http.StatusConflict, "already_live", "this cafe has already gone live")
			case errors.As(err, &bad):
				writeErr(w, http.StatusBadRequest, "bad_request", bad.msg)
			default:
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			}
			return
		}

		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic: realtime.TopicFinance, Action: "finance.went_live",
		})
		hub.BroadcastAfterCommit(r.Context(), t.ID, realtime.Event{
			Topic: realtime.TopicOrders, Action: "orders.changed",
		})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// seedGoLive performs the whole seed inside the caller's transaction. It is the
// testable core (the integration harness drives it directly).
func seedGoLive(ctx context.Context, tx pgx.Tx, tenantID, userID uuid.UUID, spec GoLiveSpec) error {
	// 1. One-time guard.
	var already *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT (preferences->>'wentLiveAt')::timestamptz FROM tenants WHERE id = $1`, tenantID,
	).Scan(&already); err != nil {
		return err
	}
	if already != nil {
		return errAlreadyLive
	}

	// 2. Drawer — open the first shift carrying the physical float. computeDrawer
	//    reads opening_float_cents while a shift is open.
	if _, err := tx.Exec(ctx, `
		INSERT INTO shifts (tenant_id, opened_by_user_id, opening_float_cents, notes)
		VALUES ($1, $2, $3, 'Go-live opening float')
	`, tenantID, userID, spec.DrawerCents); err != nil {
		return fmt.Errorf("open shift: %w", err)
	}

	// 3. Synthetic opening order — anchors the non-cash asset + house-tab
	//    payments. Created only if there's something to anchor.
	needOrder := spec.BankCents > 0 || spec.OnlineCents > 0
	for _, h := range spec.HouseTabs {
		if h.OutstandingCents > 0 {
			needOrder = true
		}
	}
	var openingOrderID uuid.UUID
	if needOrder {
		if err := tx.QueryRow(ctx, `
			INSERT INTO orders (tenant_id, opened_by_user_id, status, notes)
			VALUES ($1, $2, 'cancelled'::order_status, $3)
			RETURNING id
		`, tenantID, userID, openingBalanceMarker).Scan(&openingOrderID); err != nil {
			return fmt.Errorf("opening order: %w", err)
		}
	}

	// Opening payments carry no shift_id, so they never inflate a shift's sales
	// summary; the drawer is seeded via the float, never via a cash payment.
	addPayment := func(method string, amount int64, houseTabID *uuid.UUID) error {
		if amount <= 0 {
			return nil
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO payments (tenant_id, order_id, method, amount_cents, recorded_by_user_id, house_tab_id)
			VALUES ($1, $2, $3::payment_method, $4, $5, $6)
		`, tenantID, openingOrderID, method, amount, userID, houseTabID)
		return err
	}

	// 4 & 5. Bank + online opening assets.
	if err := addPayment("bank", spec.BankCents, nil); err != nil {
		return fmt.Errorf("bank opening: %w", err)
	}
	if err := addPayment("online", spec.OnlineCents, nil); err != nil {
		return fmt.Errorf("online opening: %w", err)
	}

	// 6. House-tab opening balances — a 'house_tab' charge = outstanding owed.
	for _, h := range spec.HouseTabs {
		if h.OutstandingCents <= 0 {
			continue
		}
		var ok bool
		if err := tx.QueryRow(ctx, `
			SELECT true FROM house_tabs
			WHERE id = $1 AND deleted_at IS NULL AND is_active = true
		`, h.HouseTabID).Scan(&ok); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return goLiveBadInput{fmt.Sprintf("house tab %s not found or inactive", h.HouseTabID)}
			}
			return err
		}
		id := h.HouseTabID
		if err := addPayment("house_tab", h.OutstandingCents, &id); err != nil {
			return fmt.Errorf("house tab opening: %w", err)
		}
	}

	// 7 & 8. Per-owner equity (flagged is_opening) + cash already in hand.
	for _, o := range spec.Owners {
		if o.InvestmentCents <= 0 && o.CashHeldCents <= 0 {
			continue
		}
		var ownerOK bool
		if err := tx.QueryRow(ctx,
			`SELECT true FROM cafe_owners WHERE id = $1`, o.OwnerID,
		).Scan(&ownerOK); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return goLiveBadInput{fmt.Sprintf("owner %s not found", o.OwnerID)}
			}
			return err
		}
		if o.InvestmentCents > 0 {
			if _, err := tx.Exec(ctx, `
				INSERT INTO owner_ledger
				  (tenant_id, owner_id, kind, amount_cents, notes, is_opening, created_by_user_id)
				VALUES ($1, $2, 'investment'::owner_ledger_kind, $3, 'Opening capital (go-live)', true, $4)
			`, tenantID, o.OwnerID, o.InvestmentCents, userID); err != nil {
				return fmt.Errorf("owner investment: %w", err)
			}
		}
		if o.CashHeldCents > 0 {
			// A withdrawal with no paired cash_drop/shift = cash the owner held
			// before go-live; adds to their holding without touching the drawer.
			if _, err := tx.Exec(ctx, `
				INSERT INTO owner_cash_entries
				  (tenant_id, owner_id, kind, amount_cents, notes, recorded_by_user_id)
				VALUES ($1, $2, 'withdrawal'::owner_cash_kind, $3, 'Opening cash on hand (go-live)', $4)
			`, tenantID, o.OwnerID, o.CashHeldCents, userID); err != nil {
				return fmt.Errorf("owner cash: %w", err)
			}
		}
	}

	// 9. Active customer tabs — open orders carrying their real items. Items are
	//    marked 'served' so they don't surface as fresh kitchen tickets; the tab
	//    balance (computed live from these items) is what's still owed.
	for _, tab := range spec.CustomerTabs {
		if len(tab.Items) == 0 {
			continue
		}
		var tabOrderID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO orders (tenant_id, service_table_id, opened_by_user_id, notes)
			VALUES ($1, $2, $3, $4)
			RETURNING id
		`, tenantID, tab.ServiceTableID, userID, tab.Notes).Scan(&tabOrderID); err != nil {
			if isUniqueViolation(err) {
				return goLiveBadInput{"two opening tabs share one table — give each open tab a distinct table (or none)"}
			}
			return fmt.Errorf("customer tab: %w", err)
		}
		for _, it := range tab.Items {
			qty := it.Qty
			if qty <= 0 {
				qty = 1
			}
			var price int64
			var cost *int64
			if err := tx.QueryRow(ctx, `
				SELECT price_cents, cost_cents FROM menu_items
				WHERE id = $1 AND deleted_at IS NULL AND is_active = true
			`, it.MenuItemID).Scan(&price, &cost); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return goLiveBadInput{fmt.Sprintf("menu item %s not found or inactive", it.MenuItemID)}
				}
				return err
			}
			var unitCost int64
			if cost != nil {
				unitCost = *cost
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO order_items
				  (tenant_id, order_id, menu_item_id, qty, unit_price_cents, unit_cost_cents,
				   kitchen_status, sent_to_kitchen_at, ready_at, served_at)
				VALUES ($1, $2, $3, $4, $5, $6, 'served'::kitchen_status, now(), now(), now())
			`, tenantID, tabOrderID, it.MenuItemID, qty, price, unitCost); err != nil {
				return fmt.Errorf("customer tab item: %w", err)
			}
		}
	}

	// 10. Stamp the one-time marker.
	if _, err := tx.Exec(ctx, `
		UPDATE tenants
		SET preferences = preferences || jsonb_build_object('wentLiveAt', now(), 'goLiveVersion', 1)
		WHERE id = $1
	`, tenantID); err != nil {
		return fmt.Errorf("mark went-live: %w", err)
	}

	// 11. Audit.
	if err := audit.Log(ctx, tx, audit.Entry{
		Action: "create", Entity: "tenant", Summary: "seeded opening balances (go-live)",
	}); err != nil {
		return err
	}
	return nil
}
