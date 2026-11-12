package fiscal

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PrintLabel is what one print of a document must say.
type PrintLabel struct {
	CopyNo int `json:"copy_no"`
	// Title is the document title in English and Nepali, e.g.
	// "TAX INVOICE" / "कर बीजक".
	Title   string `json:"title"`
	TitleNE string `json:"title_ne"`
	// CopyLabel is the copy marking printed under the title: "ORIGINAL",
	// "SECOND COPY" or "Copy of Original (n)".
	CopyLabel string `json:"copy_label"`
}

// Text renders the label as one line for the print log.
func (l PrintLabel) Text() string { return l.Title + " · " + l.CopyLabel }

// InvoicePrintLabel decides the title and copy marking of the copyNo-th print
// of an invoice.
//
// VAT café (tax invoice), per 2074 Annex 3 and the IRD office handout, which
// follow VAT Rules 2053 rule 17(2) (the buyer's copy alone carries the tax
// invoice title; the second is the seller's record):
//
//	1 → TAX INVOICE / कर बीजक, ORIGINAL
//	2 → INVOICE / बीजक, SECOND COPY
//	n → TAX INVOICE / कर बीजक, Copy of Original (n−2)
//
// PAN-only café (invoice):
//
//	1 → INVOICE / बीजक, ORIGINAL
//	n → INVOICE / बीजक, Copy of Original (n−1)
//
// Open question Q3 asks IRD to confirm the sequence for thermal receipts.
func InvoicePrintLabel(kind string, copyNo int) PrintLabel {
	l := PrintLabel{CopyNo: copyNo}
	if kind == "tax_invoice" {
		switch {
		case copyNo == 1:
			l.Title, l.TitleNE, l.CopyLabel = "TAX INVOICE", "कर बीजक", "ORIGINAL"
		case copyNo == 2:
			l.Title, l.TitleNE, l.CopyLabel = "INVOICE", "बीजक", "SECOND COPY"
		default:
			l.Title, l.TitleNE = "TAX INVOICE", "कर बीजक"
			l.CopyLabel = "Copy of Original (" + strconv.Itoa(copyNo-2) + ")"
		}
		return l
	}
	l.Title, l.TitleNE = "INVOICE", "बीजक"
	if copyNo == 1 {
		l.CopyLabel = "ORIGINAL"
	} else {
		l.CopyLabel = "Copy of Original (" + strconv.Itoa(copyNo-1) + ")"
	}
	return l
}

// PrintRecord is one row of print_log.
type PrintRecord struct {
	CopyNo        int       `json:"copy_no"`
	Label         string    `json:"label"`
	PrintedByName string    `json:"printed_by_name"`
	Device        string    `json:"device,omitempty"`
	PrintedAt     time.Time `json:"printed_at"`
}

// RecordPrint takes the next copy number of a document, logs the print and
// returns the number. The per-document advisory lock serialises concurrent
// prints (the app role cannot SELECT … FOR UPDATE an immutable table), and
// UNIQUE (doc_type, doc_id, copy_no) is the backstop.
func RecordPrint(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, docType string, docID, userID uuid.UUID,
	label func(copyNo int) PrintLabel, device string) (PrintLabel, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, docType+":"+docID.String()); err != nil {
		return PrintLabel{}, err
	}
	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM print_log WHERE doc_type = $1 AND doc_id = $2
	`, docType, docID).Scan(&n); err != nil {
		return PrintLabel{}, err
	}
	l := label(n + 1)
	var name string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(NULLIF(name, ''), email) FROM users WHERE id = $1`, userID).Scan(&name); err != nil {
		return PrintLabel{}, fmt.Errorf("fiscal: load printer user: %w", err)
	}
	device = strings.TrimSpace(device)
	if len(device) > 80 {
		device = device[:80]
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO print_log (tenant_id, doc_type, doc_id, copy_no, label, printed_by, printed_by_name, device)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, tenantID, docType, docID, l.CopyNo, l.Text(), userID, name, device); err != nil {
		return PrintLabel{}, err
	}
	return l, nil
}

// PrintHistory lists the prints of a document, oldest first.
func PrintHistory(ctx context.Context, tx pgx.Tx, docType string, docID uuid.UUID) ([]PrintRecord, error) {
	rows, err := tx.Query(ctx, `
		SELECT copy_no, label, printed_by_name, device, printed_at
		FROM print_log WHERE doc_type = $1 AND doc_id = $2 ORDER BY copy_no
	`, docType, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PrintRecord{}
	for rows.Next() {
		var p PrintRecord
		if err := rows.Scan(&p.CopyNo, &p.Label, &p.PrintedByName, &p.Device, &p.PrintedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
