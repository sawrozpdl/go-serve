package fiscal

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms"
	"github.com/pewssh/cafe-mgmt/api/internal/version"
)

// CreditError is a refusal the caller should show the user (4xx).
type CreditError struct {
	Status int
	Code   string
	Msg    string
}

func (e *CreditError) Error() string { return e.Msg }

func refuse(status int, code, msg string) error {
	return &CreditError{Status: status, Code: code, Msg: msg}
}

// ReturnLine asks to return qty of an invoice line.
type ReturnLine struct {
	LineNo int    `json:"line_no"`
	Qty    string `json:"qty"`
}

// CreditParams describe a correction to an issued invoice.
type CreditParams struct {
	TenantID  uuid.UUID
	InvoiceID uuid.UUID
	UserID    uuid.UUID
	Kind      string // "sales_return" | "reversal"
	Reason    string
	// Lines to return (sales_return only); empty = everything not yet returned.
	Lines []ReturnLine
	// RefundMethod: "cash" | "online" | "credit".
	RefundMethod string
	RefundRef    string
}

// CreditNoteLine is one returned line.
type CreditNoteLine struct {
	LineNo        int    `json:"line_no"`
	InvoiceLineNo int    `json:"invoice_line_no"`
	Description   string `json:"description"`
	Qty           string `json:"qty"`
	UnitCents     int64  `json:"unit_price_cents"`
	AmountCents   int64  `json:"amount_cents"`
}

// CreditNote is an issued sales return or reverse entry.
type CreditNote struct {
	ID              uuid.UUID `json:"id"`
	InvoiceID       uuid.UUID `json:"invoice_id"`
	InvoiceNumber   string    `json:"invoice_number"`
	InvoiceFY       string    `json:"invoice_fiscal_year"`
	InvoiceBSDate   string    `json:"invoice_bs_date"`
	Kind            string    `json:"kind"`
	FiscalYear      string    `json:"fiscal_year"`
	Seq             int64     `json:"seq"`
	Number          string    `json:"number"`
	IssuedAt        time.Time `json:"issued_at"`
	BSDate          string    `json:"bs_date"`
	ADDate          string    `json:"ad_date"`
	Reason          string    `json:"reason"`
	SellerPAN       string    `json:"seller_pan"`
	SellerName      string    `json:"seller_name"`
	SellerAddress   string    `json:"seller_address"`
	BuyerName       string    `json:"buyer_name"`
	BuyerPAN        string    `json:"buyer_pan"`
	GrossCents      int64     `json:"gross_cents"`
	DiscountCents   int64     `json:"discount_cents"`
	TaxableCents    int64     `json:"taxable_cents"`
	NonTaxableCents int64     `json:"non_taxable_cents"`
	VATCents        int64     `json:"vat_cents"`
	TotalCents      int64     `json:"total_cents"`
	VatRate         string    `json:"vat_rate"`
	RefundMethod    string    `json:"refund_method"`
	IssuedByName    string    `json:"issued_by_name"`
	SoftwareVersion string    `json:"software_version"`
	QRPayload       string    `json:"qr_payload"`
	ContentHash     string    `json:"content_hash"`
	// ReopenedOrderID is set by the API when a reversal re-opens the bill
	// to settle it again (the link lives on the new order's notes).
	ReopenedOrderID *uuid.UUID       `json:"reopened_order_id,omitempty"`
	Lines           []CreditNoteLine `json:"lines"`
}

// Totals returns the note's IRD breakdown.
func (c CreditNote) Totals() InvoiceTotals {
	return InvoiceTotals{c.GrossCents, c.DiscountCents, c.TaxableCents, c.NonTaxableCents, c.VATCents, c.TotalCents}
}

type invLine struct {
	id          uuid.UUID
	no          int
	desc        string
	qty         *big.Rat
	qtyText     string
	unit        int64
	amount      int64
	returnedQty *big.Rat
}

func parseQty(s string) (*big.Rat, bool) {
	r, ok := new(big.Rat).SetString(strings.TrimSpace(s))
	if !ok || r.Sign() <= 0 {
		return nil, false
	}
	// numeric(6,2): at most two decimals.
	hund := new(big.Rat).Mul(r, big.NewRat(100, 1))
	if !hund.IsInt() {
		return nil, false
	}
	return r, true
}

func ratText(r *big.Rat) string { return r.FloatString(2) }

// roundAmount = round(qty × unit), half away from zero (Postgres round()).
func roundAmount(qty *big.Rat, unit int64) int64 {
	v := new(big.Rat).Mul(qty, big.NewRat(unit, 1))
	n, d := v.Num(), v.Denom()
	q, m := new(big.Int).QuoRem(n, d, new(big.Int))
	if new(big.Int).Mul(m, big.NewInt(2)).Cmp(d) >= 0 {
		q.Add(q, big.NewInt(1))
	}
	return q.Int64()
}

// IssueCreditNote issues a sales return or reverse entry in tx: numbered,
// immutable, with its lines, its refund (cash out of the open shift's drawer,
// online, or off a house tab) and its CBMS /billreturn outbox row.
//
// Every refusal happens before the first write (TxMiddleware commits 4xx).
func IssueCreditNote(ctx context.Context, tx pgx.Tx, p CreditParams) (*CreditNote, error) {
	p.Reason = strings.TrimSpace(p.Reason)
	if p.Kind != "sales_return" && p.Kind != "reversal" {
		return nil, refuse(400, "bad_kind", `kind must be "sales_return" or "reversal"`)
	}
	if p.Reason == "" || len([]rune(p.Reason)) > 300 {
		return nil, refuse(400, "reason_required", "give the reason for the correction (it is printed and reported to IRD)")
	}
	switch p.RefundMethod {
	case "cash", "online", "credit":
	default:
		return nil, refuse(400, "bad_refund_method", `refund method must be "cash", "online" or "credit"`)
	}

	prof, err := LoadProfile(ctx, tx, p.TenantID)
	if err != nil {
		return nil, err
	}
	if !prof.FiscalMode() {
		return nil, refuse(409, "not_fiscal", "this café is not in IRD fiscal mode")
	}
	inv, err := LoadInvoice(ctx, tx, &p.InvoiceID, nil)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, refuse(404, "not_found", "invoice not found")
	}
	if err != nil {
		return nil, err
	}

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return nil, err
	}
	today, err := bsdate.FromTime(now)
	if err != nil {
		return nil, err
	}
	if p.Kind == "reversal" && today.String() != inv.BSDate {
		return nil, refuse(409, "reversal_window",
			"a reverse entry is for cancelling a bill the same day it was issued ("+inv.BSDate+") — use a sales return")
	}

	// Lines and what was already returned of each.
	rows, err := tx.Query(ctx, `
		SELECT il.id, il.line_no, il.description, il.qty::text, il.unit_price_cents, il.amount_cents,
		       COALESCE((SELECT sum(cl.qty) FROM credit_note_lines cl WHERE cl.invoice_line_id = il.id), 0)::text
		FROM invoice_lines il WHERE il.invoice_id = $1 ORDER BY il.line_no
	`, inv.ID)
	if err != nil {
		return nil, err
	}
	var lines []*invLine
	byNo := map[int]*invLine{}
	var linesAmount int64
	for rows.Next() {
		l := &invLine{}
		var ret string
		if err := rows.Scan(&l.id, &l.no, &l.desc, &l.qtyText, &l.unit, &l.amount, &ret); err != nil {
			rows.Close()
			return nil, err
		}
		l.qty, _ = new(big.Rat).SetString(l.qtyText)
		l.returnedQty, _ = new(big.Rat).SetString(ret)
		lines = append(lines, l)
		byNo[l.no] = l
		linesAmount += l.amount
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// What this note returns.
	type pick struct {
		line *invLine
		qty  *big.Rat
	}
	var picks []pick
	if p.Kind == "reversal" || len(p.Lines) == 0 {
		for _, l := range lines {
			left := new(big.Rat).Sub(l.qty, l.returnedQty)
			if left.Sign() > 0 {
				picks = append(picks, pick{l, left})
			}
		}
	} else {
		seen := map[int]bool{}
		for _, rl := range p.Lines {
			l := byNo[rl.LineNo]
			if l == nil || seen[rl.LineNo] {
				return nil, refuse(400, "bad_line", fmt.Sprintf("line %d is not on this bill (or listed twice)", rl.LineNo))
			}
			seen[rl.LineNo] = true
			q, ok := parseQty(rl.Qty)
			if !ok {
				return nil, refuse(400, "bad_qty", fmt.Sprintf("line %d: quantity must be positive, at most two decimals", rl.LineNo))
			}
			left := new(big.Rat).Sub(l.qty, l.returnedQty)
			if q.Cmp(left) > 0 {
				return nil, refuse(409, "over_return", fmt.Sprintf("line %d: only %s left to return", rl.LineNo, ratText(left)))
			}
			picks = append(picks, pick{l, q})
		}
	}
	if len(picks) == 0 {
		return nil, refuse(409, "fully_credited", "everything on this bill has already been returned")
	}

	// Completes = after this note nothing is left on any line.
	completes := true
	var returned int64
	for _, l := range lines {
		left := new(big.Rat).Sub(l.qty, l.returnedQty)
		var q *big.Rat
		for _, pk := range picks {
			if pk.line == l {
				q = pk.qty
			}
		}
		if q == nil {
			if left.Sign() > 0 {
				completes = false
			}
			continue
		}
		if q.Cmp(left) < 0 {
			completes = false
		}
		if q.Cmp(l.qty) == 0 {
			returned += l.amount // whole line: its exact printed amount
		} else {
			returned += roundAmount(q, l.unit)
		}
	}

	var prev InvoiceTotals
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(sum(gross_cents),0), COALESCE(sum(discount_cents),0), COALESCE(sum(taxable_cents),0),
		       COALESCE(sum(non_taxable_cents),0), COALESCE(sum(vat_cents),0), COALESCE(sum(total_cents),0)
		FROM credit_notes WHERE invoice_id = $1
	`, inv.ID).Scan(&prev.GrossCents, &prev.DiscountCents, &prev.TaxableCents, &prev.NonTaxableCents,
		&prev.VATCents, &prev.TotalCents); err != nil {
		return nil, err
	}
	reg := RegPAN
	if inv.Kind == "tax_invoice" {
		reg = RegVAT
	}
	totals, err := ComputeCreditTotals(CreditInput{
		Kind: p.Kind, Invoice: inv.Totals(), VatRate: inv.VatRate, Reg: reg,
		ReturnedAmount: returned, LinesAmount: linesAmount, Previous: prev, Completes: completes,
	})
	if err != nil {
		return nil, refuse(409, "bad_amount", err.Error())
	}

	// Refund preconditions (still before any write).
	var shiftID, houseTabID *uuid.UUID
	switch p.RefundMethod {
	case "cash":
		var id uuid.UUID
		err := tx.QueryRow(ctx, `SELECT id FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, refuse(409, "shift_required", "open a shift first — cash refunds come out of the drawer")
		}
		if err != nil {
			return nil, err
		}
		shiftID = &id
	case "credit":
		var id uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT house_tab_id FROM payments
			WHERE order_id = $1 AND method = 'house_tab' AND house_tab_id IS NOT NULL
			ORDER BY recorded_at LIMIT 1
		`, inv.OrderID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, refuse(409, "not_on_credit", "this bill was not charged to a credit account — refund cash or online")
		}
		if err != nil {
			return nil, err
		}
		var owed int64
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE((SELECT sum(amount_cents) FROM payments WHERE house_tab_id = $1 AND method = 'house_tab'), 0)
			     - COALESCE((SELECT sum(amount_cents) FROM house_tab_settlements WHERE house_tab_id = $1 AND reversed_at IS NULL), 0)
		`, id).Scan(&owed); err != nil {
			return nil, err
		}
		if totals.TotalCents > owed {
			return nil, refuse(409, "exceeds_credit_balance",
				"the credit account only owes "+Money(owed)+" — refund the rest as cash or online")
		}
		houseTabID = &id
	}

	// ---- writes ----
	fy := bsdate.FiscalYearOf(today)
	doc, prefix := DocCreditNote, "CN"
	if p.Kind == "reversal" {
		doc, prefix = DocReversal, "RE"
	}
	seq, err := NextNumber(ctx, tx, p.TenantID, doc, fy)
	if err != nil {
		return nil, err
	}
	cn := &CreditNote{
		InvoiceID: inv.ID, InvoiceNumber: inv.Number, InvoiceFY: inv.FiscalYear, InvoiceBSDate: inv.BSDate,
		Kind: p.Kind, FiscalYear: fy.String(), Seq: seq, Number: FormatNumber(prof.OutletCode, prefix, seq),
		IssuedAt: now, BSDate: today.String(), ADDate: now.In(bsdate.Nepal).Format("2006-01-02"), Reason: p.Reason,
		SellerPAN: inv.SellerPAN, SellerName: inv.SellerName, SellerAddress: inv.SellerAddress,
		BuyerName: inv.BuyerName, BuyerPAN: inv.BuyerPAN,
		GrossCents: totals.GrossCents, DiscountCents: totals.DiscountCents, TaxableCents: totals.TaxableCents,
		NonTaxableCents: totals.NonTaxableCents, VATCents: totals.VATCents, TotalCents: totals.TotalCents,
		VatRate: inv.VatRate, RefundMethod: p.RefundMethod, SoftwareVersion: version.String(),
	}
	if err := tx.QueryRow(ctx, `SELECT COALESCE(NULLIF(name, ''), email) FROM users WHERE id = $1`, p.UserID).
		Scan(&cn.IssuedByName); err != nil {
		return nil, err
	}
	hashLines := make([]HashLine, 0, len(picks))
	for i, pk := range picks {
		amt := pk.line.amount
		if pk.qty.Cmp(pk.line.qty) != 0 {
			amt = roundAmount(pk.qty, pk.line.unit)
		}
		cl := CreditNoteLine{LineNo: i + 1, InvoiceLineNo: pk.line.no, Description: pk.line.desc,
			Qty: ratText(pk.qty), UnitCents: pk.line.unit, AmountCents: amt}
		cn.Lines = append(cn.Lines, cl)
		hashLines = append(hashLines, HashLine{Description: cl.Description, Qty: cl.Qty, UnitCents: cl.UnitCents, AmountCents: cl.AmountCents})
	}
	cn.QRPayload = BuildQRPayload(QRFields{
		SellerPAN: cn.SellerPAN, Number: cn.Number, FiscalYear: cn.FiscalYear, BSDate: cn.BSDate,
		BuyerPAN: cn.BuyerPAN, TotalCents: cn.TotalCents, Taxable: cn.TaxableCents, VATCents: cn.VATCents,
	}, settings.QRVerifyBaseURL)
	cn.ContentHash = ContentHash(HashInput{
		TenantID: p.TenantID.String(), OrderID: inv.ID.String(), Kind: cn.Kind, FiscalYear: cn.FiscalYear,
		Number: cn.Number, IssuedAt: cn.IssuedAt, BSDate: cn.BSDate, SellerPAN: cn.SellerPAN, SellerName: cn.SellerName,
		BuyerName: cn.BuyerName, BuyerPAN: cn.BuyerPAN, Totals: cn.Totals(), VatRate: cn.VatRate,
		Payment: cn.RefundMethod + "|" + cn.Reason, IssuedBy: cn.IssuedByName, Lines: hashLines,
	})

	if err := tx.QueryRow(ctx, `
		INSERT INTO credit_notes (tenant_id, invoice_id, kind, fiscal_year, seq, number, issued_at, bs_date, ad_date, reason,
		  seller_pan, seller_name, seller_address, buyer_name, buyer_pan,
		  gross_cents, discount_cents, taxable_cents, non_taxable_cents, vat_cents, total_cents,
		  refund_method, issued_by, issued_by_name, software_version, qr_payload, content_hash)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
		RETURNING id
	`, p.TenantID, inv.ID, cn.Kind, cn.FiscalYear, cn.Seq, cn.Number, cn.IssuedAt, cn.BSDate, cn.ADDate, cn.Reason,
		cn.SellerPAN, cn.SellerName, cn.SellerAddress, cn.BuyerName, cn.BuyerPAN,
		cn.GrossCents, cn.DiscountCents, cn.TaxableCents, cn.NonTaxableCents, cn.VATCents, cn.TotalCents,
		cn.RefundMethod, p.UserID, cn.IssuedByName, cn.SoftwareVersion, cn.QRPayload, cn.ContentHash,
	).Scan(&cn.ID); err != nil {
		return nil, fmt.Errorf("fiscal: insert credit note: %w", err)
	}
	for i, pk := range picks {
		cl := cn.Lines[i]
		if _, err := tx.Exec(ctx, `
			INSERT INTO credit_note_lines (tenant_id, credit_note_id, invoice_line_id, line_no, description, qty, unit_price_cents, amount_cents)
			VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8)
		`, p.TenantID, cn.ID, pk.line.id, cl.LineNo, cl.Description, cl.Qty, cl.UnitCents, cl.AmountCents); err != nil {
			return nil, fmt.Errorf("fiscal: insert credit note line: %w", err)
		}
	}

	// The money back.
	label := map[string]string{"sales_return": "Sales return", "reversal": "Reverse entry"}[cn.Kind]
	var cashDropID, settlementID *uuid.UUID
	switch p.RefundMethod {
	case "cash":
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO cash_drops (tenant_id, shift_id, direction, kind, amount_cents, reason, notes, recorded_by_user_id)
			VALUES ($1, $2, 'out', 'other', $3, $4, $5, $6) RETURNING id
		`, p.TenantID, *shiftID, cn.TotalCents, "Refund · "+label+" "+cn.Number,
			"Bill "+inv.Number+" FY "+inv.FiscalYear+": "+cn.Reason, p.UserID).Scan(&id); err != nil {
			return nil, fmt.Errorf("fiscal: cash refund: %w", err)
		}
		cashDropID = &id
	case "credit":
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO house_tab_settlements (tenant_id, house_tab_id, amount_cents, kind, payment_method, write_off_reason, notes, recorded_by_user_id)
			VALUES ($1, $2, $3, 'write_off', NULL, $4, $5, $6) RETURNING id
		`, p.TenantID, *houseTabID, cn.TotalCents, label+" "+cn.Number+" of bill "+inv.Number, cn.Reason, p.UserID).Scan(&id); err != nil {
			return nil, fmt.Errorf("fiscal: credit refund: %w", err)
		}
		settlementID = &id
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO refunds (tenant_id, credit_note_id, method, amount_cents, shift_id, cash_drop_id, house_tab_settlement_id, reference_no, recorded_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, p.TenantID, cn.ID, p.RefundMethod, cn.TotalCents, shiftID, cashDropID, settlementID, strings.TrimSpace(p.RefundRef), p.UserID); err != nil {
		return nil, fmt.Errorf("fiscal: refund: %w", err)
	}

	// CBMS: returns reference the bill in ITS fiscal year, where CBMS stored it.
	if err := enqueueCBMS(ctx, tx, p.TenantID, "credit_note", cn.ID, cbms.EndpointBillReturn, cn.IssuedAt, cbms.Return{
		BuyerPAN: cn.BuyerPAN, BuyerName: cn.BuyerName, FiscalYear: cbmsFiscalYear(inv.FiscalYear),
		RefInvoiceNumber: inv.Number, CreditNoteNumber: cn.Number, CreditNoteDate: cbmsDate(cn.BSDate),
		ReasonForReturn: cn.Reason,
		Sales: cbms.Sales{
			TotalSales: cbms.Amount(cn.TotalCents), TaxableSalesVAT: cbms.Amount(cn.TaxableCents),
			VAT: cbms.Amount(cn.VATCents), TaxExemptedSales: cbms.Amount(cn.NonTaxableCents),
		},
	}); err != nil {
		return nil, fmt.Errorf("fiscal: queue CBMS return: %w", err)
	}
	return cn, nil
}
