package fiscal

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms"
	"github.com/pewssh/cafe-mgmt/api/internal/version"
)

// Buyer is the optional purchaser block captured at settle. A walk-in guest
// leaves it empty; a business guest gives its PAN to claim input VAT.
type Buyer struct {
	Name    string `json:"name"`
	PAN     string `json:"pan"`
	Address string `json:"address"`
}

// Normalize trims the fields and validates the PAN. It returns a
// human-readable problem, or "" when the buyer is acceptable.
func (b *Buyer) Normalize() string {
	b.Name = strings.TrimSpace(b.Name)
	b.Address = strings.TrimSpace(b.Address)
	b.PAN = strings.TrimSpace(b.PAN)
	if b.PAN != "" {
		pan, ok := NormalizePAN(b.PAN)
		if !ok {
			return "buyer PAN must be 9 digits"
		}
		b.PAN = pan
	}
	if len([]rune(b.Name)) > 200 || len([]rune(b.Address)) > 300 {
		return "buyer name or address is too long"
	}
	return ""
}

// InvoiceLine is one printed line.
type InvoiceLine struct {
	LineNo      int    `json:"line_no"`
	Description string `json:"description"`
	Qty         string `json:"qty"`
	UnitCents   int64  `json:"unit_price_cents"`
	AmountCents int64  `json:"amount_cents"`
}

// Invoice is an issued IRD invoice as stored.
type Invoice struct {
	ID              uuid.UUID     `json:"id"`
	OrderID         uuid.UUID     `json:"order_id"`
	Kind            string        `json:"kind"`
	FiscalYear      string        `json:"fiscal_year"`
	Seq             int64         `json:"seq"`
	Number          string        `json:"number"`
	IssuedAt        time.Time     `json:"issued_at"`
	BSDate          string        `json:"bs_date"`
	ADDate          string        `json:"ad_date"`
	SellerPAN       string        `json:"seller_pan"`
	SellerName      string        `json:"seller_name"`
	SellerNameNE    string        `json:"seller_name_ne"`
	SellerAddress   string        `json:"seller_address"`
	SellerPhone     string        `json:"seller_phone"`
	OutletCode      string        `json:"outlet_code"`
	BuyerName       string        `json:"buyer_name"`
	BuyerPAN        string        `json:"buyer_pan"`
	BuyerAddress    string        `json:"buyer_address"`
	GrossCents      int64         `json:"gross_cents"`
	DiscountCents   int64         `json:"discount_cents"`
	TaxableCents    int64         `json:"taxable_cents"`
	NonTaxableCents int64         `json:"non_taxable_cents"`
	VATCents        int64         `json:"vat_cents"`
	TotalCents      int64         `json:"total_cents"`
	VatRate         string        `json:"vat_rate"`
	PaymentMethod   string        `json:"payment_method"`
	TransactionID   string        `json:"transaction_id"`
	IssuedByName    string        `json:"issued_by_name"`
	SoftwareVersion string        `json:"software_version"`
	QRPayload       string        `json:"qr_payload"`
	ContentHash     string        `json:"content_hash"`
	Lines           []InvoiceLine `json:"lines"`
}

// Totals returns the invoice's IRD breakdown.
func (inv Invoice) Totals() InvoiceTotals {
	return InvoiceTotals{
		GrossCents: inv.GrossCents, DiscountCents: inv.DiscountCents, TaxableCents: inv.TaxableCents,
		NonTaxableCents: inv.NonTaxableCents, VATCents: inv.VATCents, TotalCents: inv.TotalCents,
	}
}

// IssueParams are the inputs to IssueInvoice beyond the transaction.
type IssueParams struct {
	TenantID uuid.UUID
	OrderID  uuid.UUID
	UserID   uuid.UUID
	Buyer    Buyer
	// QRVerifyBaseURL, when set, turns the QR into an IRD verification link.
	QRVerifyBaseURL string
}

// paymentLabel maps our payment methods onto the Annex 6 wording.
func paymentLabel(method string) string {
	switch method {
	case "cash":
		return "Cash"
	case "house_tab":
		return "Credit"
	default: // esewa, khalti, card, other (online, bank)
		return "Other"
	}
}

// IssueInvoice issues the IRD invoice for an order that CloseOrder has just
// stamped closed, inside the same transaction. It returns (nil, nil) when the
// café is not in fiscal mode — the only caller-visible difference between a
// fiscal and a non-fiscal café's settle.
//
// Must run AFTER the order row is stamped (the invoices_issue_guard trigger
// checks the totals agree) and AFTER every validation that can 4xx: the
// number is consumed here, and TxMiddleware commits 4xx responses.
func IssueInvoice(ctx context.Context, tx pgx.Tx, p IssueParams) (*Invoice, error) {
	prof, err := LoadProfile(ctx, tx, p.TenantID)
	if err != nil {
		return nil, err
	}
	if !prof.FiscalMode() {
		return nil, nil
	}

	var o OrderTotals
	var status string
	var staffMeal bool
	if err := tx.QueryRow(ctx, `
		SELECT o.status::text, o.is_staff_meal, o.subtotal_cents, o.discount_cents, o.service_charge_cents,
		       o.tax_cents, o.total_cents, t.vat_mode, t.vat_pct::text
		FROM orders o JOIN tenants t ON t.id = o.tenant_id
		WHERE o.id = $1
	`, p.OrderID).Scan(&status, &staffMeal, &o.SubtotalCents, &o.DiscountCents, &o.ServiceChargeCents,
		&o.TaxCents, &o.TotalCents, &o.VatMode, &o.VatPct); err != nil {
		return nil, fmt.Errorf("fiscal: load order: %w", err)
	}
	if staffMeal || status != "closed" {
		// A staff meal is not a sale (zero value, own status). See question Q8.
		return nil, nil
	}

	totals, err := ComputeInvoiceTotals(prof.Registration, o)
	if err != nil {
		return nil, err
	}

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return nil, err
	}
	bs, err := bsdate.FromTime(now)
	if err != nil {
		return nil, err
	}
	fy := bsdate.FiscalYearOf(bs)
	seq, err := NextNumber(ctx, tx, p.TenantID, DocInvoice, fy)
	if err != nil {
		return nil, err
	}

	inv := &Invoice{
		OrderID:         p.OrderID,
		FiscalYear:      fy.String(),
		Seq:             seq,
		Number:          FormatNumber(prof.OutletCode, "", seq),
		IssuedAt:        now,
		BSDate:          bs.String(),
		ADDate:          now.In(bsdate.Nepal).Format("2006-01-02"),
		SellerPAN:       prof.PAN,
		SellerName:      prof.LegalName,
		SellerNameNE:    prof.LegalNameNE,
		SellerAddress:   prof.Address,
		SellerPhone:     prof.Phone,
		OutletCode:      prof.OutletCode,
		BuyerName:       p.Buyer.Name,
		BuyerPAN:        p.Buyer.PAN,
		BuyerAddress:    p.Buyer.Address,
		GrossCents:      totals.GrossCents,
		DiscountCents:   totals.DiscountCents,
		TaxableCents:    totals.TaxableCents,
		NonTaxableCents: totals.NonTaxableCents,
		VATCents:        totals.VATCents,
		TotalCents:      totals.TotalCents,
		VatRate:         "0.00",
		SoftwareVersion: version.String(),
	}
	if prof.Registration == RegVAT {
		inv.Kind = "tax_invoice"
		inv.VatRate = o.VatPct
	} else {
		inv.Kind = "invoice"
	}

	// Payment method(s) and electronic references.
	rows, err := tx.Query(ctx, `
		SELECT method::text, COALESCE(reference_no, '') FROM payments
		WHERE order_id = $1 ORDER BY recorded_at, id
	`, p.OrderID)
	if err != nil {
		return nil, err
	}
	labels := map[string]bool{}
	var refs []string
	for rows.Next() {
		var m, ref string
		if err := rows.Scan(&m, &ref); err != nil {
			rows.Close()
			return nil, err
		}
		labels[paymentLabel(m)] = true
		if ref = strings.TrimSpace(ref); ref != "" && m != "cash" {
			refs = append(refs, ref)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var ls []string
	for _, l := range []string{"Cash", "Cheque", "Credit", "Other"} {
		if labels[l] {
			ls = append(ls, l)
		}
	}
	if len(ls) == 0 {
		ls = []string{"Cash"} // a fully discounted bill: nothing was paid
	}
	inv.PaymentMethod = strings.Join(ls, ", ")
	inv.TransactionID = strings.Join(refs, "; ")

	if err := tx.QueryRow(ctx, `SELECT COALESCE(NULLIF(name, ''), email) FROM users WHERE id = $1`, p.UserID).
		Scan(&inv.IssuedByName); err != nil {
		return nil, fmt.Errorf("fiscal: load issuer: %w", err)
	}

	// Lines, with add-on names folded into the description (their price is
	// already folded into the unit price, 0062).
	lrows, err := tx.Query(ctx, `
		SELECT oi.id, oi.menu_item_name,
		       COALESCE((SELECT string_agg(m.name, ', ' ORDER BY m.created_at, m.id)
		                 FROM order_item_modifiers m WHERE m.order_item_id = oi.id), ''),
		       oi.qty::text, oi.unit_price_cents, round(oi.qty * oi.unit_price_cents)::bigint
		FROM order_items oi
		WHERE oi.order_id = $1 AND oi.voided_at IS NULL
		ORDER BY oi.created_at, oi.id
	`, p.OrderID)
	if err != nil {
		return nil, err
	}
	var itemIDs []uuid.UUID
	for lrows.Next() {
		var id uuid.UUID
		var name, addons string
		var l InvoiceLine
		if err := lrows.Scan(&id, &name, &addons, &l.Qty, &l.UnitCents, &l.AmountCents); err != nil {
			lrows.Close()
			return nil, err
		}
		l.Description = name
		if addons != "" {
			l.Description = name + " (" + addons + ")"
		}
		l.LineNo = len(inv.Lines) + 1
		inv.Lines = append(inv.Lines, l)
		itemIDs = append(itemIDs, id)
	}
	lrows.Close()
	if err := lrows.Err(); err != nil {
		return nil, err
	}
	if len(inv.Lines) == 0 {
		return nil, fmt.Errorf("fiscal: order %s has no lines to invoice", p.OrderID)
	}

	inv.QRPayload = BuildQRPayload(QRFields{
		SellerPAN: inv.SellerPAN, Number: inv.Number, FiscalYear: inv.FiscalYear, BSDate: inv.BSDate,
		BuyerPAN: inv.BuyerPAN, TotalCents: inv.TotalCents, Taxable: inv.TaxableCents, VATCents: inv.VATCents,
	}, firstNonEmpty(p.QRVerifyBaseURL, settings.QRVerifyBaseURL))
	inv.ContentHash = ContentHash(inv.hashInput(p.TenantID))

	if err := tx.QueryRow(ctx, `
		INSERT INTO invoices (
		  tenant_id, order_id, kind, fiscal_year, seq, number, issued_at, bs_date, ad_date,
		  seller_pan, seller_name, seller_name_ne, seller_address, seller_phone, outlet_code,
		  buyer_name, buyer_pan, buyer_address,
		  gross_cents, discount_cents, taxable_cents, non_taxable_cents, vat_cents, total_cents, vat_rate,
		  payment_method, transaction_id, issued_by, issued_by_name, software_version, qr_payload, content_hash)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::numeric,
		        $26,$27,$28,$29,$30,$31,$32)
		RETURNING id
	`, p.TenantID, p.OrderID, inv.Kind, inv.FiscalYear, inv.Seq, inv.Number, inv.IssuedAt, inv.BSDate, inv.ADDate,
		inv.SellerPAN, inv.SellerName, inv.SellerNameNE, inv.SellerAddress, inv.SellerPhone, inv.OutletCode,
		inv.BuyerName, inv.BuyerPAN, inv.BuyerAddress,
		inv.GrossCents, inv.DiscountCents, inv.TaxableCents, inv.NonTaxableCents, inv.VATCents, inv.TotalCents, inv.VatRate,
		inv.PaymentMethod, inv.TransactionID, p.UserID, inv.IssuedByName, inv.SoftwareVersion, inv.QRPayload, inv.ContentHash,
	).Scan(&inv.ID); err != nil {
		return nil, fmt.Errorf("fiscal: insert invoice: %w", err)
	}

	batch := &pgx.Batch{}
	for i, l := range inv.Lines {
		batch.Queue(`
			INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, order_item_id, description, qty, unit_price_cents, amount_cents)
			VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8)
		`, p.TenantID, inv.ID, l.LineNo, itemIDs[i], l.Description, l.Qty, l.UnitCents, l.AmountCents)
	}
	if err := tx.SendBatch(ctx, batch).Close(); err != nil {
		return nil, fmt.Errorf("fiscal: insert invoice lines: %w", err)
	}
	// Outbox row in the same transaction: the invoice and its CBMS report
	// commit together or not at all (§6.4(क), §7.2(ङ)).
	if err := enqueueCBMS(ctx, tx, p.TenantID, "invoice", inv.ID, cbms.EndpointBill, inv.IssuedAt, BillPayload(inv)); err != nil {
		return nil, fmt.Errorf("fiscal: queue CBMS: %w", err)
	}
	return inv, nil
}

func (inv *Invoice) hashInput(tenantID uuid.UUID) HashInput {
	hl := make([]HashLine, len(inv.Lines))
	for i, l := range inv.Lines {
		hl[i] = HashLine{Description: l.Description, Qty: l.Qty, UnitCents: l.UnitCents, AmountCents: l.AmountCents}
	}
	return HashInput{
		TenantID: tenantID.String(), OrderID: inv.OrderID.String(), Kind: inv.Kind,
		FiscalYear: inv.FiscalYear, Number: inv.Number, IssuedAt: inv.IssuedAt, BSDate: inv.BSDate,
		SellerPAN: inv.SellerPAN, SellerName: inv.SellerName, BuyerName: inv.BuyerName, BuyerPAN: inv.BuyerPAN,
		Totals: inv.Totals(), VatRate: inv.VatRate, Payment: inv.PaymentMethod, IssuedBy: inv.IssuedByName,
		Lines: hl,
	}
}

// VerifyHash recomputes the content hash of a stored invoice and reports
// whether it still matches.
func (inv *Invoice) VerifyHash(tenantID uuid.UUID) bool {
	return ContentHash(inv.hashInput(tenantID)) == inv.ContentHash
}

// LoadInvoice reads an issued invoice and its lines by id or by order id
// (exactly one must be non-nil).
func LoadInvoice(ctx context.Context, tx pgx.Tx, id, orderID *uuid.UUID) (*Invoice, error) {
	where, arg := "id = $1", any(nil)
	switch {
	case id != nil:
		arg = *id
	case orderID != nil:
		where, arg = "order_id = $1", *orderID
	default:
		return nil, fmt.Errorf("fiscal: LoadInvoice needs an id")
	}
	inv := &Invoice{}
	var ad time.Time
	err := tx.QueryRow(ctx, `
		SELECT id, order_id, kind, fiscal_year, seq, number, issued_at, bs_date, ad_date,
		       seller_pan, seller_name, seller_name_ne, seller_address, seller_phone, outlet_code,
		       buyer_name, buyer_pan, buyer_address,
		       gross_cents, discount_cents, taxable_cents, non_taxable_cents, vat_cents, total_cents, vat_rate::text,
		       payment_method, transaction_id, issued_by_name, software_version, qr_payload, content_hash
		FROM invoices WHERE `+where, arg).Scan(
		&inv.ID, &inv.OrderID, &inv.Kind, &inv.FiscalYear, &inv.Seq, &inv.Number, &inv.IssuedAt, &inv.BSDate, &ad,
		&inv.SellerPAN, &inv.SellerName, &inv.SellerNameNE, &inv.SellerAddress, &inv.SellerPhone, &inv.OutletCode,
		&inv.BuyerName, &inv.BuyerPAN, &inv.BuyerAddress,
		&inv.GrossCents, &inv.DiscountCents, &inv.TaxableCents, &inv.NonTaxableCents, &inv.VATCents, &inv.TotalCents, &inv.VatRate,
		&inv.PaymentMethod, &inv.TransactionID, &inv.IssuedByName, &inv.SoftwareVersion, &inv.QRPayload, &inv.ContentHash)
	if err != nil {
		return nil, err
	}
	inv.ADDate = ad.Format("2006-01-02")
	rows, err := tx.Query(ctx, `
		SELECT line_no, description, qty::text, unit_price_cents, amount_cents
		FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no
	`, inv.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var l InvoiceLine
		if err := rows.Scan(&l.LineNo, &l.Description, &l.Qty, &l.UnitCents, &l.AmountCents); err != nil {
			return nil, err
		}
		inv.Lines = append(inv.Lines, l)
	}
	return inv, rows.Err()
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
