package fiscal

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
)

// PurchaseBillInput is a supplier bill as the café enters it.
type PurchaseBillInput struct {
	SupplierName         string `json:"supplier_name"`
	SupplierPAN          string `json:"supplier_pan"`
	SupplierBillNo       string `json:"supplier_bill_no"`
	SupplierBillDateBS   string `json:"supplier_bill_date_bs"` // "2083-07-21"
	IsImport             bool   `json:"is_import"`
	CustomsDeclarationNo string `json:"customs_declaration_no"`
	IsCapital            bool   `json:"is_capital"`
	ExemptCents          int64  `json:"exempt_cents"`
	TaxableCents         int64  `json:"taxable_cents"`
	VATCents             int64  `json:"vat_cents"`
	// ConfirmVATMismatch accepts a VAT figure that is not 13% of the taxable
	// amount (a supplier's per-line rounding, say). Without it such a bill is
	// refused with the expected figure, never silently corrected.
	ConfirmVATMismatch bool `json:"confirm_vat_mismatch"`
}

// PurchaseBill is a recorded supplier bill.
type PurchaseBill struct {
	ID                   uuid.UUID `json:"id"`
	ExpenseID            uuid.UUID `json:"expense_id"`
	SupplierName         string    `json:"supplier_name"`
	SupplierPAN          string    `json:"supplier_pan"`
	SupplierBillNo       string    `json:"supplier_bill_no"`
	SupplierBillDateBS   string    `json:"supplier_bill_date_bs"`
	SupplierBillDate     string    `json:"supplier_bill_date"`
	FiscalYear           string    `json:"fiscal_year"`
	IsImport             bool      `json:"is_import"`
	CustomsDeclarationNo string    `json:"customs_declaration_no"`
	IsCapital            bool      `json:"is_capital"`
	TotalCents           int64     `json:"total_cents"`
	ExemptCents          int64     `json:"exempt_cents"`
	TaxableCents         int64     `json:"taxable_cents"`
	VATCents             int64     `json:"vat_cents"`
	ReturnedCents        int64     `json:"returned_cents"`
	CreatedAt            time.Time `json:"created_at"`
}

// vatTolerance is how far a supplier's VAT may stray from 13% of the taxable
// amount (in paisa) before the café must confirm it: Rs 1, covering per-line
// rounding on a long bill.
const vatTolerance = 100

func requireVATFiscal(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	p, err := LoadProfile(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if !p.FiscalMode() || p.Registration != RegVAT {
		return refuse(409, "not_vat_fiscal", "the purchase register is for a VAT café in IRD fiscal mode")
	}
	return nil
}

// RecordPurchaseBill attaches supplier-bill detail to an expense (one per
// expense). All validation precedes the insert; the database re-checks that
// the total equals the expense and refuses a duplicate supplier bill.
func RecordPurchaseBill(ctx context.Context, tx pgx.Tx, tenantID, userID, expenseID uuid.UUID, in PurchaseBillInput) (*PurchaseBill, error) {
	if err := requireVATFiscal(ctx, tx, tenantID); err != nil {
		return nil, err
	}
	in.SupplierName = strings.TrimSpace(in.SupplierName)
	in.SupplierBillNo = strings.TrimSpace(in.SupplierBillNo)
	in.CustomsDeclarationNo = strings.TrimSpace(in.CustomsDeclarationNo)
	if in.SupplierName == "" || in.SupplierBillNo == "" {
		return nil, refuse(400, "supplier_required", "enter the supplier's name and bill number")
	}
	if strings.TrimSpace(in.SupplierPAN) != "" {
		pan, ok := NormalizePAN(in.SupplierPAN)
		if !ok {
			return nil, refuse(400, "invalid_pan", "supplier PAN must be 9 digits")
		}
		in.SupplierPAN = pan
	} else {
		in.SupplierPAN = ""
	}
	date, err := bsdate.Parse(strings.TrimSpace(in.SupplierBillDateBS))
	if err != nil {
		return nil, refuse(400, "invalid_date", "supplier bill date must be a BS date, e.g. 2083-07-21")
	}
	ad, _ := date.ToCivil()
	if in.ExemptCents < 0 || in.TaxableCents < 0 || in.VATCents < 0 {
		return nil, refuse(400, "invalid_amount", "amounts cannot be negative")
	}
	if in.IsImport && in.CustomsDeclarationNo == "" {
		return nil, refuse(400, "declaration_required", "an import needs its customs declaration (प्रज्ञापनपत्र) number")
	}
	if in.SupplierPAN == "" && in.VATCents > 0 {
		return nil, refuse(400, "vat_needs_pan", "VAT can only be claimed on a bill from a VAT-registered supplier (enter its PAN)")
	}
	expected := (in.TaxableCents*1300*2 + 10000) / 20000
	if d := in.VATCents - expected; (d > vatTolerance || d < -vatTolerance) && !in.ConfirmVATMismatch {
		return nil, refuse(409, "vat_mismatch",
			fmt.Sprintf("VAT %s is not 13%% of the taxable %s (expected about %s) — check the bill, or confirm it as printed",
				Money(in.VATCents), Money(in.TaxableCents), Money(expected)))
	}
	var amount int64
	var deleted *time.Time
	err = tx.QueryRow(ctx, `SELECT amount_cents, deleted_at FROM expenses WHERE id = $1`, expenseID).Scan(&amount, &deleted)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && deleted != nil) {
		return nil, refuse(404, "not_found", "expense not found")
	}
	if err != nil {
		return nil, err
	}
	total := in.ExemptCents + in.TaxableCents + in.VATCents
	if total != amount {
		return nil, refuse(409, "total_mismatch",
			fmt.Sprintf("exempt + taxable + VAT = %s, but the expense is %s", Money(total), Money(amount)))
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM purchase_bills WHERE expense_id = $1)`, expenseID).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, refuse(409, "already_recorded", "this expense already has its supplier bill recorded")
	}
	fy := bsdate.FiscalYearOf(date)
	if in.SupplierPAN != "" {
		var dup bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM purchase_bills
			               WHERE supplier_pan = $1 AND supplier_bill_no = $2 AND fiscal_year = $3)
		`, in.SupplierPAN, in.SupplierBillNo, fy.String()).Scan(&dup); err != nil {
			return nil, err
		}
		if dup {
			return nil, refuse(409, "duplicate_bill",
				fmt.Sprintf("bill %s from PAN %s is already in the FY %s purchase register", in.SupplierBillNo, in.SupplierPAN, fy))
		}
	}

	b := &PurchaseBill{
		ExpenseID: expenseID, SupplierName: in.SupplierName, SupplierPAN: in.SupplierPAN,
		SupplierBillNo: in.SupplierBillNo, SupplierBillDateBS: date.String(), SupplierBillDate: ad.Format("2006-01-02"),
		FiscalYear: fy.String(), IsImport: in.IsImport, CustomsDeclarationNo: in.CustomsDeclarationNo,
		IsCapital: in.IsCapital, TotalCents: total, ExemptCents: in.ExemptCents, TaxableCents: in.TaxableCents,
		VATCents: in.VATCents,
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO purchase_bills (tenant_id, expense_id, supplier_name, supplier_pan, supplier_bill_no,
		  supplier_bill_date_bs, supplier_bill_date, fiscal_year, is_import, customs_declaration_no, is_capital,
		  total_cents, exempt_cents, taxable_cents, vat_cents, recorded_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		RETURNING id, created_at
	`, tenantID, expenseID, b.SupplierName, b.SupplierPAN, b.SupplierBillNo, b.SupplierBillDateBS, b.SupplierBillDate,
		b.FiscalYear, b.IsImport, b.CustomsDeclarationNo, b.IsCapital, b.TotalCents, b.ExemptCents, b.TaxableCents,
		b.VATCents, userID).Scan(&b.ID, &b.CreatedAt); err != nil {
		return nil, fmt.Errorf("fiscal: insert purchase bill: %w", err)
	}
	return b, nil
}

// PurchaseReturnInput is a return of goods to a supplier.
type PurchaseReturnInput struct {
	SupplierNoteNo string `json:"supplier_note_no"`
	Reason         string `json:"reason"`
	ExemptCents    int64  `json:"exempt_cents"`
	TaxableCents   int64  `json:"taxable_cents"`
	VATCents       int64  `json:"vat_cents"`
}

// PurchaseReturn is a recorded purchase return.
type PurchaseReturn struct {
	ID             uuid.UUID `json:"id"`
	PurchaseBillID uuid.UUID `json:"purchase_bill_id"`
	FiscalYear     string    `json:"fiscal_year"`
	Number         string    `json:"number"`
	ReturnDateBS   string    `json:"return_date_bs"`
	SupplierNoteNo string    `json:"supplier_note_no"`
	Reason         string    `json:"reason"`
	TotalCents     int64     `json:"total_cents"`
	ExemptCents    int64     `json:"exempt_cents"`
	TaxableCents   int64     `json:"taxable_cents"`
	VATCents       int64     `json:"vat_cents"`
}

// RecordPurchaseReturn records goods sent back to a supplier against one of
// its bills, numbered PR-n in the current fiscal year. It records the
// register entry only; money the supplier refunds is recorded by the café
// as it arrives, like any other money in.
func RecordPurchaseReturn(ctx context.Context, tx pgx.Tx, tenantID, userID, billID uuid.UUID, in PurchaseReturnInput) (*PurchaseReturn, error) {
	if err := requireVATFiscal(ctx, tx, tenantID); err != nil {
		return nil, err
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" {
		return nil, refuse(400, "reason_required", "give the reason for the return")
	}
	if in.ExemptCents < 0 || in.TaxableCents < 0 || in.VATCents < 0 || in.ExemptCents+in.TaxableCents+in.VATCents <= 0 {
		return nil, refuse(400, "invalid_amount", "enter the returned amounts")
	}
	var b struct{ ex, tx, vat, rex, rtx, rvat int64 }
	err := tx.QueryRow(ctx, `
		SELECT pb.exempt_cents, pb.taxable_cents, pb.vat_cents,
		       COALESCE(sum(pr.exempt_cents),0), COALESCE(sum(pr.taxable_cents),0), COALESCE(sum(pr.vat_cents),0)
		FROM purchase_bills pb LEFT JOIN purchase_returns pr ON pr.purchase_bill_id = pb.id
		WHERE pb.id = $1 GROUP BY pb.id
	`, billID).Scan(&b.ex, &b.tx, &b.vat, &b.rex, &b.rtx, &b.rvat)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, refuse(404, "not_found", "supplier bill not found")
	}
	if err != nil {
		return nil, err
	}
	if b.rex+in.ExemptCents > b.ex || b.rtx+in.TaxableCents > b.tx || b.rvat+in.VATCents > b.vat {
		return nil, refuse(409, "over_return", "the return is more than is left on the supplier bill")
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return nil, err
	}
	today, err := bsdate.FromTime(now)
	if err != nil {
		return nil, err
	}
	fy := bsdate.FiscalYearOf(today)
	seq, err := NextNumber(ctx, tx, tenantID, DocPurchaseReturn, fy)
	if err != nil {
		return nil, err
	}
	r := &PurchaseReturn{
		PurchaseBillID: billID, FiscalYear: fy.String(), Number: FormatNumber("", "PR", seq),
		ReturnDateBS: today.String(), SupplierNoteNo: strings.TrimSpace(in.SupplierNoteNo), Reason: in.Reason,
		TotalCents: in.ExemptCents + in.TaxableCents + in.VATCents, ExemptCents: in.ExemptCents,
		TaxableCents: in.TaxableCents, VATCents: in.VATCents,
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO purchase_returns (tenant_id, purchase_bill_id, fiscal_year, seq, number, return_date_bs, return_date,
		  supplier_note_no, reason, total_cents, exempt_cents, taxable_cents, vat_cents, recorded_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id
	`, tenantID, billID, r.FiscalYear, seq, r.Number, r.ReturnDateBS, now.In(bsdate.Nepal).Format("2006-01-02"),
		r.SupplierNoteNo, r.Reason, r.TotalCents, r.ExemptCents, r.TaxableCents, r.VATCents, userID).Scan(&r.ID); err != nil {
		return nil, fmt.Errorf("fiscal: insert purchase return: %w", err)
	}
	return r, nil
}

// LoadPurchaseBillForExpense returns an expense's supplier bill, or nil.
func LoadPurchaseBillForExpense(ctx context.Context, tx pgx.Tx, expenseID uuid.UUID) (*PurchaseBill, error) {
	b := &PurchaseBill{}
	var ad time.Time
	err := tx.QueryRow(ctx, `
		SELECT pb.id, pb.expense_id, pb.supplier_name, pb.supplier_pan, pb.supplier_bill_no, pb.supplier_bill_date_bs,
		       pb.supplier_bill_date, pb.fiscal_year, pb.is_import, pb.customs_declaration_no, pb.is_capital,
		       pb.total_cents, pb.exempt_cents, pb.taxable_cents, pb.vat_cents,
		       COALESCE((SELECT sum(total_cents) FROM purchase_returns WHERE purchase_bill_id = pb.id), 0), pb.created_at
		FROM purchase_bills pb WHERE pb.expense_id = $1
	`, expenseID).Scan(&b.ID, &b.ExpenseID, &b.SupplierName, &b.SupplierPAN, &b.SupplierBillNo, &b.SupplierBillDateBS,
		&ad, &b.FiscalYear, &b.IsImport, &b.CustomsDeclarationNo, &b.IsCapital, &b.TotalCents, &b.ExemptCents,
		&b.TaxableCents, &b.VATCents, &b.ReturnedCents, &b.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b.SupplierBillDate = ad.Format("2006-01-02")
	return b, nil
}
