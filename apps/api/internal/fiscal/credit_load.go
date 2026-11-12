package fiscal

import (
	"context"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const creditNoteCols = `
	c.id, c.invoice_id, i.number, i.fiscal_year, i.bs_date, c.kind, c.fiscal_year, c.seq, c.number, c.issued_at,
	c.bs_date, c.ad_date, c.reason, c.seller_pan, c.seller_name, c.seller_address, c.buyer_name, c.buyer_pan,
	c.gross_cents, c.discount_cents, c.taxable_cents, c.non_taxable_cents, c.vat_cents, c.total_cents, i.vat_rate::text,
	c.refund_method, c.issued_by_name, c.software_version, c.qr_payload, c.content_hash`

func scanCreditNote(row pgx.Row) (*CreditNote, error) {
	c := &CreditNote{}
	var ad time.Time
	err := row.Scan(&c.ID, &c.InvoiceID, &c.InvoiceNumber, &c.InvoiceFY, &c.InvoiceBSDate, &c.Kind, &c.FiscalYear,
		&c.Seq, &c.Number, &c.IssuedAt, &c.BSDate, &ad, &c.Reason, &c.SellerPAN, &c.SellerName, &c.SellerAddress,
		&c.BuyerName, &c.BuyerPAN, &c.GrossCents, &c.DiscountCents, &c.TaxableCents, &c.NonTaxableCents,
		&c.VATCents, &c.TotalCents, &c.VatRate, &c.RefundMethod, &c.IssuedByName, &c.SoftwareVersion,
		&c.QRPayload, &c.ContentHash)
	if err != nil {
		return nil, err
	}
	c.ADDate = ad.Format("2006-01-02")
	return c, nil
}

func loadCreditLines(ctx context.Context, tx pgx.Tx, c *CreditNote) error {
	rows, err := tx.Query(ctx, `
		SELECT cl.line_no, il.line_no, cl.description, cl.qty::text, cl.unit_price_cents, cl.amount_cents
		FROM credit_note_lines cl JOIN invoice_lines il ON il.id = cl.invoice_line_id
		WHERE cl.credit_note_id = $1 ORDER BY cl.line_no
	`, c.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	c.Lines = []CreditNoteLine{}
	for rows.Next() {
		var l CreditNoteLine
		if err := rows.Scan(&l.LineNo, &l.InvoiceLineNo, &l.Description, &l.Qty, &l.UnitCents, &l.AmountCents); err != nil {
			return err
		}
		c.Lines = append(c.Lines, l)
	}
	return rows.Err()
}

// LoadCreditNote reads one credit note with its lines.
func LoadCreditNote(ctx context.Context, tx pgx.Tx, id uuid.UUID) (*CreditNote, error) {
	c, err := scanCreditNote(tx.QueryRow(ctx, `SELECT `+creditNoteCols+`
		FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id WHERE c.id = $1`, id))
	if err != nil {
		return nil, err
	}
	return c, loadCreditLines(ctx, tx, c)
}

// LoadCreditNotesForInvoice lists an invoice's credit notes, oldest first.
func LoadCreditNotesForInvoice(ctx context.Context, tx pgx.Tx, invoiceID uuid.UUID) ([]*CreditNote, error) {
	rows, err := tx.Query(ctx, `SELECT `+creditNoteCols+`
		FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id
		WHERE c.invoice_id = $1 ORDER BY c.issued_at, c.seq`, invoiceID)
	if err != nil {
		return nil, err
	}
	var out []*CreditNote
	for rows.Next() {
		c, err := scanCreditNote(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range out {
		if err := loadCreditLines(ctx, tx, c); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// CreditNotePrintLabel: the original, then "Copy of Original (n)".
func CreditNotePrintLabel(kind string, copyNo int) PrintLabel {
	l := PrintLabel{CopyNo: copyNo, Title: "CREDIT NOTE", TitleNE: "क्रेडिट नोट"}
	if kind == "reversal" {
		l.Title, l.TitleNE = "REVERSE ENTRY", "उल्टो प्रविष्टि"
	}
	if copyNo == 1 {
		l.CopyLabel = "ORIGINAL"
	} else {
		l.CopyLabel = "Copy of Original (" + strconv.Itoa(copyNo-1) + ")"
	}
	return l
}
