package api

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// =========================================================================
// ENGAGE — reward redemption at the till (0065)
// =========================================================================

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
