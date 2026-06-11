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
	openingFloat, closingCount, expected, variance, cashIn, dropsIn, dropsOut int64,
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
		CashIn:       cashIn,
		DropsIn:      dropsIn,
		DropsOut:     dropsOut,
		Notes:        notes,
	}

	// Recipients — every active owner/manager for the tenant. Suspended +
	// pending members do not get shift mail.
	rows, err := tx.Query(ctx, `
		SELECT u.email::text
		FROM tenant_members tm
		JOIN users u ON u.id = tm.user_id
		WHERE tm.tenant_id = $1
		  AND tm.status = 'active'
		  AND tm.role = ANY(ARRAY['owner','manager']::tenant_role[])
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

	// Sales aggregates for orders CLOSED inside this shift window. We
	// approximate "this shift" as closed_at between opened_at and closed_at;
	// that's correct in practice because the schema enforces one open shift
	// per tenant, so no orders can close outside the active shift's window.
	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(total_cents), 0)::bigint,
		       COALESCE(SUM(tax_cents), 0)::bigint,
		       COALESCE(SUM(service_charge_cents), 0)::bigint,
		       COUNT(*)::int
		FROM orders
		WHERE status = 'closed'
		  AND closed_at >= $1 AND closed_at <= $2
	`, openedAt, closedAt).Scan(&out.SalesCents, &out.TaxCents, &out.ServiceCents, &out.OrderCount)

	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM order_adjustments oa
		JOIN orders o ON o.id = oa.order_id
		WHERE oa.type = 'discount'
		  AND o.status = 'closed' AND o.closed_at >= $1 AND o.closed_at <= $2
	`, openedAt, closedAt).Scan(&out.DiscountCents)

	_ = tx.QueryRow(ctx, `
		SELECT COUNT(*)::int
		FROM order_items oi
		WHERE oi.voided_at IS NOT NULL
		  AND oi.voided_at >= $1 AND oi.voided_at <= $2
	`, openedAt, closedAt).Scan(&out.VoidCount)

	_ = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_cents), 0)::bigint
		FROM expenses
		WHERE deleted_at IS NULL
		  AND paid_at >= $1 AND paid_at <= $2
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

	// Top 5 sellers within the shift window.
	tsRows, err := tx.Query(ctx, `
		SELECT mi.name,
		       SUM(oi.qty)::int,
		       SUM(oi.qty * oi.unit_price_cents)::bigint
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		JOIN menu_items mi ON mi.id = oi.menu_item_id
		WHERE o.status = 'closed'
		  AND o.closed_at >= $1 AND o.closed_at <= $2
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
