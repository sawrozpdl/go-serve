package fiscal

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
)

// The IRD registers (procedure 2082 §6.3(क), §6.1(छ), Annex 5–6; 2074 §6(ङ)
// (ञ)). Every register is a Table, built by one SQL query over the immutable
// fiscal records, and rendered to JSON, CSV, Excel or XML by export.go.
// Money columns carry paisa; renderers format them as rupees.

// ColKind tells renderers how to format a column.
type ColKind string

const (
	ColText  ColKind = "text"
	ColMoney ColKind = "money" // int64 paisa
	ColInt   ColKind = "int"
	ColBool  ColKind = "bool"
)

// Column is one register column. Label is what IRD's format calls it.
type Column struct {
	Key   string  `json:"key"`
	Label string  `json:"label"`
	Kind  ColKind `json:"kind"`
}

// Table is a rendered register.
type Table struct {
	Kind    string      `json:"kind"`
	Title   string      `json:"title"`
	TitleNE string      `json:"title_ne,omitempty"`
	Header  [][2]string `json:"header"` // taxpayer name, PAN, period …
	Columns []Column    `json:"columns"`
	Rows    [][]any     `json:"rows"`
	// Totals per money column key (rendered as a final row).
	Totals map[string]int64 `json:"totals,omitempty"`
}

// Period is a fiscal year, optionally narrowed to one BS month.
type Period struct {
	FY    bsdate.FiscalYear
	Month int // 0 = the whole year; 1–12 = BS month (Baisakh = 1)
}

// Label renders "FY 2083/84" or "Kartik 2083 (FY 2083/84)".
func (p Period) Label() string {
	if p.Month == 0 {
		return "FY " + p.FY.String()
	}
	return fmt.Sprintf("%s %d (FY %s)", bsdate.MonthName(p.Month), p.year(), p.FY)
}

// year is the BS year a month of the fiscal year falls in.
func (p Period) year() int {
	if p.Month >= 4 {
		return p.FY.StartYear
	}
	return p.FY.StartYear + 1
}

// bsPrefix narrows a BS date column ("2083-07-21") to the month, or "" for
// the whole year.
func (p Period) bsPrefix() string {
	if p.Month == 0 {
		return ""
	}
	return fmt.Sprintf("%04d-%02d-", p.year(), p.Month)
}

// span is the [from, to) instant range of the period, in Nepal time.
func (p Period) span() (time.Time, time.Time, error) {
	var from, to bsdate.Date
	if p.Month == 0 {
		from = p.FY.First()
		last, err := p.FY.Last()
		if err != nil {
			return time.Time{}, time.Time{}, err
		}
		to = last
	} else {
		n, err := bsdate.DaysInMonth(p.year(), p.Month)
		if err != nil {
			return time.Time{}, time.Time{}, err
		}
		from = bsdate.Date{Year: p.year(), Month: p.Month, Day: 1}
		to = bsdate.Date{Year: p.year(), Month: p.Month, Day: n}
	}
	f, err := from.ToCivil()
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	t, err := to.ToCivil()
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	return f, t.AddDate(0, 0, 1), nil
}

// RegisterKind names one register.
type RegisterKind struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
}

// RegisterKinds lists the registers, in the order the UI shows them.
var RegisterKinds = []RegisterKind{
	{"materialized_view", "Standard View (Materialized View)"},
	{"sales_register", "Sales Register (Sales Book)"},
	{"sales_return_register", "Sales Return Register"},
	{"reverse_entry_register", "Reverse Entry Register (Cancelled Bills)"},
	{"purchase_register", "Purchase Register (Purchase Book)"},
	{"purchase_return_register", "Purchase Return Register"},
	{"vat_summary", "VAT Summary"},
	{"above_one_lakh", "Transactions above Rs 1 Lakh"},
	{"order_slips", "Order Slip (KOT) Log"},
	{"print_log", "Print Log"},
	{"cbms_status", "CBMS Reporting Status"},
	{"audit_trail", "Audit Trail (Activity Log)"},
}

// BuildRegister builds one register for the café whose RLS scope tx carries.
func BuildRegister(ctx context.Context, tx pgx.Tx, kind string, p Period, prof Profile) (*Table, error) {
	var t *Table
	var err error
	switch kind {
	case "materialized_view":
		t, err = materializedView(ctx, tx, p)
	case "sales_register":
		t, err = salesRegister(ctx, tx, p)
	case "sales_return_register":
		t, err = creditRegister(ctx, tx, p, "sales_return")
	case "reverse_entry_register":
		t, err = creditRegister(ctx, tx, p, "reversal")
	case "purchase_register":
		t, err = purchaseRegister(ctx, tx, p)
	case "purchase_return_register":
		t, err = purchaseReturnRegister(ctx, tx, p)
	case "vat_summary":
		t, err = vatSummary(ctx, tx, p)
	case "above_one_lakh":
		t, err = aboveOneLakh(ctx, tx, p)
	case "order_slips":
		t, err = orderSlipLog(ctx, tx, p)
	case "print_log":
		t, err = printLogRegister(ctx, tx, p)
	case "cbms_status":
		t, err = cbmsStatusRegister(ctx, tx, p)
	case "audit_trail":
		t, err = auditTrail(ctx, tx, p)
	default:
		return nil, refuse(404, "unknown_register", "no such register: "+kind)
	}
	if err != nil {
		return nil, err
	}
	t.Kind = kind
	for _, k := range RegisterKinds {
		if k.Kind == kind && t.Title == "" {
			t.Title = k.Title
		}
	}
	t.Header = [][2]string{
		{"Taxpayer", prof.LegalName},
		{"PAN/VAT No", prof.PAN},
		{"Address", prof.Address},
		{"Period", p.Label()},
		{"Generated", time.Now().In(bsdate.Nepal).Format("2006-01-02 15:04") + " NPT"},
	}
	if t.Rows == nil {
		t.Rows = [][]any{}
	}
	return t, nil
}

// collect runs q and turns every row into []any, summing money columns.
func collect(ctx context.Context, tx pgx.Tx, t *Table, q string, args ...any) error {
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return err
		}
		if len(vals) != len(t.Columns) {
			return fmt.Errorf("fiscal: register %s: %d values for %d columns", t.Kind, len(vals), len(t.Columns))
		}
		for i, c := range t.Columns {
			if c.Kind == ColMoney {
				if t.Totals == nil {
					t.Totals = map[string]int64{}
				}
				if v, ok := vals[i].(int64); ok {
					t.Totals[c.Key] += v
				}
			}
			if ts, ok := vals[i].(time.Time); ok {
				vals[i] = ts.In(bsdate.Nepal).Format("2006-01-02 15:04:05")
			}
		}
		t.Rows = append(t.Rows, vals)
	}
	return rows.Err()
}

func cols(spec ...string) []Column {
	// spec entries: "key|Label|kind"
	out := make([]Column, 0, len(spec))
	for _, s := range spec {
		p := strings.SplitN(s, "|", 3)
		out = append(out, Column{Key: p[0], Label: p[1], Kind: ColKind(p[2])})
	}
	return out
}

func materializedView(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	t := &Table{TitleNE: "मानक दृश्य", Columns: cols(
		"fiscal_year|Fiscal Year|text", "bill_no|Bill_no|text", "customer_name|Customer_name|text",
		"customer_pan|Customer_pan|text", "bill_date|Bill_Date|text", "amount|Amount|money",
		"discount|Discount|money", "taxable|Taxable_Amount|money", "tax|Tax_Amount|money",
		"total|Total_Amount|money", "sync|Sync_with_IRD|bool", "printed|IS_Bill_Printed|bool",
		"active|Is_bill_Active|bool", "printed_time|Printed_Time|text", "entered_by|Entered_By|text",
		"printed_by|Printed_by|text", "realtime|Is_realtime|bool", "payment|Payment_Method|text",
		"vat_refund|VAT_Refund_Amount|money", "txn|Transaction_Id|text",
	)}
	return t, collect(ctx, tx, t, `
		SELECT v."Fiscal_Year", v."Bill_no", v."Customer_name", v."Customer_pan", v."Bill_Date",
		       i.gross_cents, i.discount_cents, i.taxable_cents + i.non_taxable_cents, i.vat_cents, i.total_cents,
		       v."Sync_with_IRD", v."IS_Bill_Printed", v."Is_bill_Active", v."Printed_Time",
		       v."Entered_By", COALESCE(v."Printed_by", ''), v."Is_realtime", v."Payment_Method",
		       0::bigint, COALESCE(v."Transaction_Id", '')
		FROM ird_materialized_view v JOIN invoices i ON i.id = v.invoice_id
		WHERE v."Fiscal_Year" = $1 AND ($2 = '' OR v."Bill_Date" LIKE $2 || '%')
		ORDER BY v.seq`, p.FY.String(), p.bsPrefix())
}

func salesRegister(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	t := &Table{TitleNE: "बिक्री खाता", Columns: cols(
		"date|Date (BS)|text", "bill_no|Bill No|text", "buyer|Buyer's Name|text", "buyer_pan|Buyer's PAN|text",
		"total|Total Sales|money", "non_taxable|Non-taxable / Exempt Sales|money", "export|Export Sales|money",
		"discount|Discount|money", "taxable|Taxable Sales Amount|money", "tax|Tax (VAT)|money",
	)}
	return t, collect(ctx, tx, t, `
		SELECT bs_date, number, buyer_name, buyer_pan, total_cents, non_taxable_cents, 0::bigint,
		       discount_cents, taxable_cents, vat_cents
		FROM invoices
		WHERE fiscal_year = $1 AND ($2 = '' OR bs_date LIKE $2 || '%')
		ORDER BY seq`, p.FY.String(), p.bsPrefix())
}

func creditRegister(ctx context.Context, tx pgx.Tx, p Period, kind string) (*Table, error) {
	t := &Table{Columns: cols(
		"date|Date (BS)|text", "number|Number|text", "ref_bill|Ref. Bill No|text", "ref_date|Ref. Bill Date|text",
		"buyer|Buyer's Name|text", "buyer_pan|Buyer's PAN|text", "total|Total|money",
		"non_taxable|Non-taxable|money", "discount|Discount|money", "taxable|Taxable Amount|money",
		"tax|Tax (VAT)|money", "refund|Refund|text", "reason|Reason|text",
	)}
	if kind == "sales_return" {
		t.TitleNE = "बिक्री फिर्ता खाता"
	} else {
		t.TitleNE = "उल्टो प्रविष्टि खाता"
	}
	return t, collect(ctx, tx, t, `
		SELECT c.bs_date, c.number, i.number, i.bs_date, c.buyer_name, c.buyer_pan, c.total_cents,
		       c.non_taxable_cents, c.discount_cents, c.taxable_cents, c.vat_cents, c.refund_method, c.reason
		FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id
		WHERE c.kind = $3 AND c.fiscal_year = $1 AND ($2 = '' OR c.bs_date LIKE $2 || '%')
		ORDER BY c.seq`, p.FY.String(), p.bsPrefix(), kind)
}

func purchaseRegister(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	t := &Table{TitleNE: "खरिद खाता", Columns: cols(
		"date|Date (BS)|text", "bill_no|Bill / Declaration No|text", "supplier|Supplier's Name|text",
		"supplier_pan|Supplier's PAN|text", "total|Total Purchase|money", "exempt|Exempt Purchase / Import|money",
		"taxable|Taxable Purchase (non-capital)|money", "tax|Tax|money",
		"import_taxable|Taxable Import (non-capital)|money", "import_tax|Import Tax|money",
		"capital_taxable|Capital Purchase / Import|money", "capital_tax|Capital Tax|money",
	)}
	return t, collect(ctx, tx, t, `
		SELECT supplier_bill_date_bs,
		       CASE WHEN is_import THEN customs_declaration_no ELSE supplier_bill_no END,
		       supplier_name, supplier_pan, total_cents, exempt_cents,
		       CASE WHEN NOT is_capital AND NOT is_import THEN taxable_cents ELSE 0 END,
		       CASE WHEN NOT is_capital AND NOT is_import THEN vat_cents ELSE 0 END,
		       CASE WHEN NOT is_capital AND is_import THEN taxable_cents ELSE 0 END,
		       CASE WHEN NOT is_capital AND is_import THEN vat_cents ELSE 0 END,
		       CASE WHEN is_capital THEN taxable_cents ELSE 0 END,
		       CASE WHEN is_capital THEN vat_cents ELSE 0 END
		FROM purchase_bills
		WHERE fiscal_year = $1 AND ($2 = '' OR supplier_bill_date_bs LIKE $2 || '%')
		ORDER BY supplier_bill_date, created_at`, p.FY.String(), p.bsPrefix())
}

func purchaseReturnRegister(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	t := &Table{TitleNE: "खरिद फिर्ता खाता", Columns: cols(
		"date|Date (BS)|text", "number|Number|text", "supplier_bill|Supplier Bill No|text",
		"supplier|Supplier's Name|text", "supplier_pan|Supplier's PAN|text", "note|Supplier Note No|text",
		"total|Total|money", "exempt|Exempt|money", "taxable|Taxable|money", "tax|Tax|money", "reason|Reason|text",
	)}
	return t, collect(ctx, tx, t, `
		SELECT r.return_date_bs, r.number, b.supplier_bill_no, b.supplier_name, b.supplier_pan, r.supplier_note_no,
		       r.total_cents, r.exempt_cents, r.taxable_cents, r.vat_cents, r.reason
		FROM purchase_returns r JOIN purchase_bills b ON b.id = r.purchase_bill_id
		WHERE r.fiscal_year = $1 AND ($2 = '' OR r.return_date_bs LIKE $2 || '%')
		ORDER BY r.seq`, p.FY.String(), p.bsPrefix())
}

func vatSummary(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	t := &Table{TitleNE: "मूल्य अभिवृद्धि कर सारांश", Columns: cols(
		"month|Month (BS)|text", "sales_taxable|Taxable Sales|money", "output_vat|Output VAT|money",
		"return_vat|VAT on Sales Returns|money", "purchase_taxable|Taxable Purchases|money",
		"input_vat|Input VAT|money", "preturn_vat|VAT on Purchase Returns|money", "net_vat|Net VAT Payable|money",
	)}
	// The 12 months of the fiscal year in order: Shrawan … Asar.
	months := []int{4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3}
	if p.Month != 0 {
		months = []int{p.Month}
	}
	for _, m := range months {
		mp := Period{FY: p.FY, Month: m}
		pre := mp.bsPrefix()
		var st, ov, rv, pt, iv, prv int64
		if err := tx.QueryRow(ctx, `
			SELECT
			  COALESCE((SELECT sum(taxable_cents) FROM invoices WHERE fiscal_year = $1 AND bs_date LIKE $2 || '%'), 0)::bigint,
			  COALESCE((SELECT sum(vat_cents) FROM invoices WHERE fiscal_year = $1 AND bs_date LIKE $2 || '%'), 0)::bigint,
			  COALESCE((SELECT sum(vat_cents) FROM credit_notes WHERE fiscal_year = $1 AND bs_date LIKE $2 || '%'), 0)::bigint,
			  COALESCE((SELECT sum(taxable_cents) FROM purchase_bills WHERE fiscal_year = $1 AND supplier_bill_date_bs LIKE $2 || '%'), 0)::bigint,
			  COALESCE((SELECT sum(vat_cents) FROM purchase_bills WHERE fiscal_year = $1 AND supplier_bill_date_bs LIKE $2 || '%'), 0)::bigint,
			  COALESCE((SELECT sum(vat_cents) FROM purchase_returns WHERE fiscal_year = $1 AND return_date_bs LIKE $2 || '%'), 0)::bigint
		`, p.FY.String(), pre).Scan(&st, &ov, &rv, &pt, &iv, &prv); err != nil {
			return nil, err
		}
		net := (ov - rv) - (iv - prv)
		row := []any{fmt.Sprintf("%s %d", bsdate.MonthName(m), mp.year()), st, ov, rv, pt, iv, prv, net}
		if t.Totals == nil {
			t.Totals = map[string]int64{}
		}
		for i, c := range t.Columns {
			if c.Kind == ColMoney {
				t.Totals[c.Key] += row[i].(int64)
			}
		}
		t.Rows = append(t.Rows, row)
	}
	return t, nil
}

// aboveOneLakhCents is the Rs 1,00,000 threshold of IRD's party-wise annex.
const aboveOneLakhCents = 100_000_00

func aboveOneLakh(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	t := &Table{Columns: cols(
		"pan|PAN|text", "name|Name|text", "type|Sales / Purchase|text",
		"taxable|Taxable Amount|money", "exempt|Non-taxable / Exempt|money", "vat|VAT|money", "total|Total|money",
	)}
	return t, collect(ctx, tx, t, `
		WITH sales AS (
		  SELECT buyer_pan AS pan, max(buyer_name) AS name, 'Sales'::text AS type,
		         sum(taxable_cents)::bigint AS taxable, sum(non_taxable_cents)::bigint AS exempt,
		         sum(vat_cents)::bigint AS vat, sum(total_cents)::bigint AS total
		  FROM invoices WHERE fiscal_year = $1 AND buyer_pan <> '' AND ($2 = '' OR bs_date LIKE $2 || '%')
		  GROUP BY buyer_pan
		), purchases AS (
		  SELECT supplier_pan, max(supplier_name), 'Purchase'::text,
		         sum(taxable_cents)::bigint, sum(exempt_cents)::bigint, sum(vat_cents)::bigint, sum(total_cents)::bigint
		  FROM purchase_bills WHERE fiscal_year = $1 AND supplier_pan <> '' AND ($2 = '' OR supplier_bill_date_bs LIKE $2 || '%')
		  GROUP BY supplier_pan
		)
		SELECT * FROM (SELECT * FROM sales UNION ALL SELECT * FROM purchases) x
		WHERE total > $3
		ORDER BY type DESC, total DESC`, p.FY.String(), p.bsPrefix(), int64(aboveOneLakhCents))
}

func orderSlipLog(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	t := &Table{Columns: cols(
		"date|Date (BS)|text", "number|Slip No|text", "sent_at|Sent At|text", "sent_by|Sent By|text",
		"items|Items|text", "bill|Bill No|text",
	)}
	return t, collect(ctx, tx, t, `
		SELECT s.bs_date, s.number, s.sent_at, s.sent_by_name,
		       (SELECT string_agg((l->>'qty') || ' x ' || (l->>'name'), ', ') FROM jsonb_array_elements(s.lines) l),
		       COALESCE(i.number, '')
		FROM order_slips s LEFT JOIN invoices i ON i.order_id = s.order_id
		WHERE s.fiscal_year = $1 AND ($2 = '' OR s.bs_date LIKE $2 || '%')
		ORDER BY s.seq`, p.FY.String(), p.bsPrefix())
}

func printLogRegister(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	from, to, err := p.span()
	if err != nil {
		return nil, err
	}
	t := &Table{Columns: cols(
		"printed_at|Printed At|text", "doc|Document|text", "number|Number|text", "copy|Copy No|int",
		"label|Label|text", "by|Printed By|text", "device|Device|text",
	)}
	return t, collect(ctx, tx, t, `
		SELECT p.printed_at, p.doc_type, COALESCE(i.number, c.number, ''), p.copy_no, p.label, p.printed_by_name, p.device
		FROM print_log p
		LEFT JOIN invoices i ON p.doc_type = 'invoice' AND i.id = p.doc_id
		LEFT JOIN credit_notes c ON p.doc_type = 'credit_note' AND c.id = p.doc_id
		WHERE p.printed_at >= $1 AND p.printed_at < $2
		ORDER BY p.printed_at`, from, to)
}

func cbmsStatusRegister(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	from, to, err := p.span()
	if err != nil {
		return nil, err
	}
	t := &Table{Columns: cols(
		"issued_at|Issued At|text", "doc|Document|text", "number|Number|text", "status|Status|text",
		"via|Reported Via|text", "realtime|Real-time|bool", "attempts|Attempts|int", "error|Last Error|text",
	)}
	return t, collect(ctx, tx, t, `
		SELECT s.issued_at, s.doc_type, COALESCE(i.number, c.number, ''), s.status, COALESCE(s.synced_via, ''),
		       COALESCE(s.is_realtime, false), s.attempts, s.last_error
		FROM cbms_submissions s
		LEFT JOIN invoices i ON s.doc_type = 'invoice' AND i.id = s.doc_id
		LEFT JOIN credit_notes c ON s.doc_type = 'credit_note' AND c.id = s.doc_id
		WHERE s.issued_at >= $1 AND s.issued_at < $2
		ORDER BY s.issued_at`, from, to)
}

func auditTrail(ctx context.Context, tx pgx.Tx, p Period) (*Table, error) {
	from, to, err := p.span()
	if err != nil {
		return nil, err
	}
	t := &Table{TitleNE: "प्रयोगकर्ता क्रियाकलाप विवरण", Columns: cols(
		"at|Date & Time|text", "user|User|text", "action|Action|text", "entity|Record|text",
		"summary|Details|text", "ip|IP|text", "seq|Chain No|int", "hash|Hash|text",
	)}
	return t, collect(ctx, tx, t, `
		SELECT created_at, COALESCE(actor_name, actor_email, ''), action, entity, summary,
		       COALESCE(host(ip), ''), COALESCE(chain_seq, 0), COALESCE(left(hash, 16), '')
		FROM audit_log
		WHERE created_at >= $1 AND created_at < $2
		ORDER BY created_at, chain_seq NULLS FIRST`, from, to)
}
