package fiscal

import (
	"context"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
)

// DocType names a fiscal number series (fiscal_sequences.doc_type).
type DocType string

const (
	DocInvoice        DocType = "invoice"
	DocCreditNote     DocType = "credit_note"
	DocReversal       DocType = "reversal"
	DocOrderSlip      DocType = "order_slip"
	DocPurchaseReturn DocType = "purchase_return"
)

// NextNumber consumes the next number of a series inside tx and returns it.
//
// Gap-free by construction: the row is locked FOR UPDATE and incremented in
// the caller's transaction, so the number is spent only if that transaction
// commits. Concurrent issuers queue on the row lock; the very first issue of
// a fiscal year races only on the INSERT, which ON CONFLICT DO NOTHING
// resolves (the loser blocks on the unique index until the winner commits,
// then reads its row). The database trigger refuses any other movement.
func NextNumber(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, doc DocType, fy bsdate.FiscalYear) (int64, error) {
	if _, err := tx.Exec(ctx, `
		INSERT INTO fiscal_sequences (tenant_id, doc_type, fiscal_year)
		VALUES ($1, $2, $3)
		ON CONFLICT (tenant_id, doc_type, fiscal_year) DO NOTHING
	`, tenantID, string(doc), fy.String()); err != nil {
		return 0, err
	}
	var n int64
	if err := tx.QueryRow(ctx, `
		SELECT next_value FROM fiscal_sequences
		WHERE tenant_id = $1 AND doc_type = $2 AND fiscal_year = $3
		FOR UPDATE
	`, tenantID, string(doc), fy.String()).Scan(&n); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE fiscal_sequences SET next_value = next_value + 1
		WHERE tenant_id = $1 AND doc_type = $2 AND fiscal_year = $3
	`, tenantID, string(doc), fy.String()); err != nil {
		return 0, err
	}
	return n, nil
}

// FormatNumber renders a document number: the bare sequence, prefixed with
// the outlet code and a dash when the café has one ("KTM-42"), and with a
// document prefix for non-invoice series ("CN-3", "KTM-RE-1", "KOT-17").
// The fiscal year is printed beside the number, not inside it.
func FormatNumber(outlet, docPrefix string, seq int64) string {
	s := strconv.FormatInt(seq, 10)
	if docPrefix != "" {
		s = docPrefix + "-" + s
	}
	if outlet != "" {
		s = outlet + "-" + s
	}
	return s
}
