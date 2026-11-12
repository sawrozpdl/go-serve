package fiscal

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms"
)

// afterCommit defers fn until the request transaction commits; outside a
// request it runs fn at once (a kick is harmless: the worker just finds the
// row on its next pass if the transaction has not committed yet).
var afterCommit = appctx.AfterCommit

// cbmsFiscalYear converts our "2083/84" to the CBMS "2083.084".
func cbmsFiscalYear(fy string) string {
	f, err := bsdate.ParseFiscalYear(fy)
	if err != nil {
		return fy
	}
	return f.CBMS()
}

// cbmsDate converts our BS "2083-07-21" to the CBMS "2083.07.21".
func cbmsDate(bs string) string { return strings.ReplaceAll(bs, "-", ".") }

// BillPayload maps an issued invoice onto the CBMS /api/bill model.
//
// VAT café: taxable + VAT = total. PAN-only café: the whole sale goes in
// tax_exempted_sales — it is outside VAT (open question Q2 asks IRD to
// confirm the field for PAN-only sellers).
func BillPayload(inv *Invoice) cbms.Bill {
	return cbms.Bill{
		BuyerPAN:      inv.BuyerPAN,
		BuyerName:     inv.BuyerName,
		FiscalYear:    cbmsFiscalYear(inv.FiscalYear),
		InvoiceNumber: inv.Number,
		InvoiceDate:   cbmsDate(inv.BSDate),
		Sales: cbms.Sales{
			TotalSales:       cbms.Amount(inv.TotalCents),
			TaxableSalesVAT:  cbms.Amount(inv.TaxableCents),
			VAT:              cbms.Amount(inv.VATCents),
			TaxExemptedSales: cbms.Amount(inv.NonTaxableCents),
		},
	}
}

// enqueueCBMS writes the outbox row for a document inside the issuing
// transaction and asks the worker to post it as soon as that commits.
func enqueueCBMS(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, docType string, docID uuid.UUID,
	ep cbms.Endpoint, issuedAt time.Time, doc any) error {
	raw, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO cbms_submissions (tenant_id, doc_type, doc_id, endpoint, issued_at, payload)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, tenantID, docType, docID, string(ep), issuedAt, raw); err != nil {
		return err
	}
	if k := settings.Kick; k != nil {
		afterCommit(ctx, k)
	}
	return nil
}

// Submission is a document's CBMS reporting status, for the UI.
type Submission struct {
	Status      string     `json:"status"`
	Attempts    int        `json:"attempts"`
	LastCode    *int       `json:"last_code,omitempty"`
	LastError   string     `json:"last_error,omitempty"`
	SyncedAt    *time.Time `json:"synced_at,omitempty"`
	SyncedVia   string     `json:"synced_via,omitempty"`
	IsRealtime  *bool      `json:"is_realtime,omitempty"`
	NextAttempt *time.Time `json:"next_attempt_at,omitempty"`
}

// LoadSubmission returns the CBMS status of a document (nil if none, e.g. an
// invoice issued before CBMS existed in this build).
func LoadSubmission(ctx context.Context, tx pgx.Tx, docType string, docID uuid.UUID) (*Submission, error) {
	s := &Submission{}
	var via *string
	var next time.Time
	err := tx.QueryRow(ctx, `
		SELECT status, attempts, last_code, last_error, synced_at, synced_via, is_realtime, next_attempt_at
		FROM cbms_submissions WHERE doc_type = $1 AND doc_id = $2
	`, docType, docID).Scan(&s.Status, &s.Attempts, &s.LastCode, &s.LastError, &s.SyncedAt, &via, &s.IsRealtime, &next)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if via != nil {
		s.SyncedVia = *via
	}
	if s.Status == "pending" {
		s.NextAttempt = &next
	}
	return s, nil
}
