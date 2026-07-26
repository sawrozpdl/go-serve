package api

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
)

// buildShiftSummary loads every datum needed for the shift-end email while
// the RLS-scoped transaction is still active. The caller is expected to have
// already updated the shift row (so the totals we read reflect the close).
//
// Recipients: every active owner/manager email for the tenant. Empty when no
// such member exists — the caller should skip sending in that case.
func buildShiftSummary(
	ctx context.Context,
	shiftID uuid.UUID,
	tenantID uuid.UUID,
	tenantName, tenantSlug, tz string,
	openedAt, closedAt time.Time,
	notes string,
	openingFloat, closingCount, expected, variance int64,
	flow shiftCashFlow,
) (mail.ShiftSummary, error) {
	tx := appctx.Tx(ctx)
	out := mail.ShiftSummary{
		TenantName:   tenantName,
		TenantSlug:   tenantSlug,
		Timezone:     tz,
		OpenedAt:     openedAt,
		ClosedAt:     closedAt,
		OpeningFloat: openingFloat,
		ClosingCount: closingCount,
		ExpectedCash: expected,
		Variance:     variance,
		// CashIn is order payments only; credit settled in cash is its own
		// line so the drawer block adds up on the page.
		CashIn:             flow.CashPayments,
		CreditSettledCash:  flow.CashTabSettlements,
		CreditSettledOther: flow.OnlineTabSettlements,
		DropsIn:            flow.DropsIn,
		DropsOut:           flow.DropsOut,
		Notes:              notes,
	}

	// Recipients — every active owner/manager for the tenant. Suspended +
	// pending members do not get shift mail.
	//
	// Roles live in tenant_member_roles -> roles (migration 0019 moved them off
	// tenant_members). This query still read tm.role, a column that no longer
	// exists, so it errored for EVERY tenant — and because CloseShift builds the
	// summary inside a savepoint and only logs a warning on failure, shift-close
	// emails simply stopped going out silently. buildShiftSummary had no tests,
	// so nothing caught it.
	rows, err := tx.Query(ctx, `
		SELECT u.email::text
		FROM tenant_members tm
		JOIN users u ON u.id = tm.user_id
		WHERE tm.tenant_id = $1
		  AND tm.status = 'active'
		  AND EXISTS (
		    SELECT 1 FROM tenant_member_roles tmr
		    JOIN roles r ON r.id = tmr.role_id
		    WHERE tmr.tenant_id = tm.tenant_id
		      AND tmr.user_id = tm.user_id
		      AND r.key IN ('owner', 'manager')
		  )
		  AND u.email IS NOT NULL AND u.email <> ''
		ORDER BY u.email
	`, tenantID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			rows.Close()
			return out, err
		}
		out.Recipients = append(out.Recipients, e)
	}
	rows.Close()

	// Opener + closer emails (for the footer line).
	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(uo.email::text, ''), COALESCE(uc.email::text, '')
		FROM shifts s
		LEFT JOIN users uo ON uo.id = s.opened_by_user_id
		LEFT JOIN users uc ON uc.id = s.closed_by_user_id
		WHERE s.id = $1
	`, shiftID).Scan(&out.OpenedByEmail, &out.ClosedByEmail)

	// THE SHIFT'S ORDER POPULATION: orders closed inside [opened_at, closed_at).
	//
	// Half-open, like every other window in the codebase, so an order can never
	// land in two shifts. (An order closed in the gap between one shift closing
	// and the next opening belongs to no shift summary — CloseOrder deliberately
	// does not require an open shift. That gap already existed; the boundary
	// instant is simply part of it now instead of being special-cased.)
	//
	// Every aggregate below windows on this SAME population. Mixing populations
	// is what produced a negative "Received": sales were windowed on closed_at
	// while on-tab was windowed on payments.shift_id, so a tab charge recorded in
	// one shift for an order closed in the next made one shift report more
	// collected than it billed and the other report less than nothing.
	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(total_cents), 0)::bigint,
		       COALESCE(SUM(tax_cents), 0)::bigint,
		       COALESCE(SUM(service_charge_cents), 0)::bigint,
		       COUNT(*)::int
		FROM orders
		WHERE status = 'closed'
		  AND closed_at >= $1 AND closed_at < $2
	`, openedAt, closedAt).Scan(&out.SalesCents, &out.TaxCents, &out.ServiceCents, &out.OrderCount)

	// Of those sales, how much was charged to a house tab (credit) vs actually
	// collected. Same population as the sales query above, so Received can never
	// exceed billed sales or go negative.
	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(p.amount_cents), 0)::bigint
		FROM payments p
		JOIN orders o ON o.id = p.order_id
		WHERE p.method = 'house_tab'
		  AND o.status = 'closed'
		  AND o.closed_at >= $1 AND o.closed_at < $2
	`, openedAt, closedAt).Scan(&out.OnTabCents)
	out.ReceivedCents = out.SalesCents - out.OnTabCents

	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM order_adjustments oa
		JOIN orders o ON o.id = oa.order_id
		WHERE oa.type = 'discount'
		  AND o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at < $2
	`, openedAt, closedAt).Scan(&out.DiscountCents)

	// Voids that happened during the shift. Joined to orders so a cancelled
	// order's lines don't inflate the count — cancelling already voids the whole
	// order, and counting both would report the same event twice.
	_ = tx.QueryRow(ctx, `
		SELECT COUNT(*)::int
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		WHERE oi.voided_at IS NOT NULL
		  AND oi.voided_at >= $1 AND oi.voided_at < $2
		  AND o.status <> 'cancelled'
	`, openedAt, closedAt).Scan(&out.VoidCount)

	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM expenses
		WHERE deleted_at IS NULL
		  AND paid_at >= $1 AND paid_at < $2
	`, openedAt, closedAt).Scan(&out.ExpensesCents)

	// Payments grouped by method (just for this shift).
	pmRows, err := tx.Query(ctx, `
		SELECT method::text, COALESCE(SUM(amount_cents),0)::bigint, COUNT(*)::int
		FROM payments
		WHERE shift_id = $1
		GROUP BY method
		ORDER BY method
	`, shiftID)
	if err == nil {
		for pmRows.Next() {
			var m mail.MethodTotal
			if err := pmRows.Scan(&m.Method, &m.Amount, &m.Count); err == nil {
				out.PaymentMethods = append(out.PaymentMethods, m)
			}
		}
		pmRows.Close()
	}

	// Top 5 sellers within the shift window, by MENU ITEM SALES (price × qty).
	// That is a different basis from the Sales figure above (billed totals), so
	// the email labels it as menu item sales — the two are not meant to tie.
	tsRows, err := tx.Query(ctx, `
		SELECT mi.name,
		       SUM(oi.qty)::int,
		       SUM(oi.qty * oi.unit_price_cents)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		WHERE o.status = 'closed'
		  AND o.closed_at >= $1 AND o.closed_at < $2
		  AND oi.voided_at IS NULL
		GROUP BY mi.id, mi.name
		HAVING SUM(oi.qty) > 0
		ORDER BY SUM(oi.qty * oi.unit_price_cents) DESC
		LIMIT 5
	`, openedAt, closedAt)
	if err == nil {
		for tsRows.Next() {
			var s mail.TopSeller
			if err := tsRows.Scan(&s.Name, &s.Qty, &s.RevenueCents); err == nil {
				out.TopSellers = append(out.TopSellers, s)
			}
		}
		tsRows.Close()
	}

	// Brand color — pull primary amber from the tenant branding jsonb if
	// present. Falls back to the default amber in the email template.
	var brandColor string
	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(branding->>'primaryHex', '')
		FROM tenants WHERE id = $1
	`, tenantID).Scan(&brandColor)
	out.BrandColor = brandColor

	return out, nil
}
