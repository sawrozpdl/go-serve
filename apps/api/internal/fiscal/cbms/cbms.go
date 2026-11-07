// Package cbms talks to IRD's Central Billing Monitoring System (CBMS) bill
// posting API ("CBMS Bill Posting API Guide", updated 2079-06-28):
//
//	POST {base}/api/bill        a sales invoice
//	POST {base}/api/billreturn  a sales return / credit note
//
// Both take JSON with the taxpayer's IRD credentials in the body and answer
// with a bare numeric code (200 success, 100 credentials, 101 duplicate bill /
// missing bill, 102 save error, 103 unknown error, 104 invalid model, 105 bill
// does not exist). The same host serves test and live traffic; the
// credentials decide which (IRD's public test login is Test_CBMS / test@321
// with seller PAN 999999999).
//
// This package is transport only — no database. The outbox and worker live in
// package fiscal. Implementations:
//
//	HTTPClient — the real API
//	Mock       — in-process, deterministic, scenario-driven (dev, CI, demos)
//	cbmstest   — an httptest fake of the real API for end-to-end tests
package cbms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Endpoint names a CBMS posting endpoint.
type Endpoint string

const (
	EndpointBill       Endpoint = "bill"
	EndpointBillReturn Endpoint = "billreturn"
)

// Response codes documented by IRD.
const (
	CodeSuccess        = 200
	CodeBadCredentials = 100
	CodeDuplicate      = 101 // on /bill: already exists; on /billreturn: referenced bill missing
	CodeSaveError      = 102
	CodeUnknownError   = 103
	CodeInvalidModel   = 104
	CodeBillNotFound   = 105 // /billreturn only
)

// Credentials are the taxpayer's IRD Taxpayer Portal login and PAN.
type Credentials struct {
	Username  string
	Password  string
	SellerPAN string
}

// Amount is a rupee amount serialised as a JSON number with exactly two
// decimals ("1130.00"), built from paisa so no float ever touches money.
type Amount int64

// MarshalJSON writes paisa as a decimal rupee number.
func (a Amount) MarshalJSON() ([]byte, error) {
	v := int64(a)
	neg := v < 0
	if neg {
		v = -v
	}
	s := fmt.Sprintf("%d.%02d", v/100, v%100)
	if neg {
		s = "-" + s
	}
	return []byte(s), nil
}

// UnmarshalJSON reads a decimal rupee number back into paisa (used by the
// fake server and the mock). Two decimals parse exactly after rounding.
func (a *Amount) UnmarshalJSON(b []byte) error {
	f, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
	if err != nil {
		return fmt.Errorf("cbms: bad amount %s", b)
	}
	*a = Amount(math.Round(f * 100))
	return nil
}

// Sales holds the amount fields shared by bills and returns. Fields the café
// never uses (excise, health service tax, education service fee, export) are
// sent as 0, because the model requires them.
type Sales struct {
	TotalSales       Amount `json:"total_sales"`
	TaxableSalesVAT  Amount `json:"taxable_sales_vat"`
	VAT              Amount `json:"vat"`
	ExcisableAmount  Amount `json:"excisable_amount"`
	Excise           Amount `json:"excise"`
	TaxableSalesHST  Amount `json:"taxable_sales_hst"`
	HST              Amount `json:"hst"`
	AmountForESF     Amount `json:"amount_for_esf"`
	ESF              Amount `json:"esf"`
	ExportSales      Amount `json:"export_sales"`
	TaxExemptedSales Amount `json:"tax_exempted_sales"`
}

// Check verifies total_sales = taxable + vat + exempt + export (+ the unused
// excise/HST/ESF lines), which CBMS expects to hold.
func (s Sales) Check() error {
	sum := s.TaxableSalesVAT + s.VAT + s.TaxExemptedSales + s.ExportSales +
		s.ExcisableAmount + s.Excise + s.TaxableSalesHST + s.HST + s.AmountForESF + s.ESF
	if s.TotalSales != sum {
		return fmt.Errorf("cbms: total_sales %d ≠ sum of parts %d", s.TotalSales, sum)
	}
	return nil
}

// Bill is the /api/bill model without credentials and real-time fields.
type Bill struct {
	BuyerPAN      string `json:"buyer_pan"`
	BuyerName     string `json:"buyer_name"`
	FiscalYear    string `json:"fiscal_year"`    // "2083.084"
	InvoiceNumber string `json:"invoice_number"` //
	InvoiceDate   string `json:"invoice_date"`   // BS "2083.07.21"
	Sales
}

// Return is the /api/billreturn model without credentials and real-time fields.
type Return struct {
	BuyerPAN         string `json:"buyer_pan"`
	BuyerName        string `json:"buyer_name"`
	FiscalYear       string `json:"fiscal_year"`
	RefInvoiceNumber string `json:"ref_invoice_number"`
	CreditNoteNumber string `json:"credit_note_number"`
	CreditNoteDate   string `json:"credit_note_date"` // BS "2083.07.21"
	ReasonForReturn  string `json:"reason_for_return"`
	Sales
}

// Envelope is what goes on the wire: credentials, the document fields, and
// the real-time flag. Built at send time; never stored.
type Envelope struct {
	Endpoint   Endpoint
	Creds      Credentials
	Document   json.RawMessage // a marshalled Bill or Return
	IsRealtime bool
	// DatetimeClient is the client clock at send, "2006-01-02T15:04:05" (NPT).
	DatetimeClient string
}

// MarshalJSON flattens credentials, document and flags into one object, the
// shape the API takes.
func (e Envelope) MarshalJSON() ([]byte, error) {
	m := map[string]any{}
	if err := json.Unmarshal(e.Document, &m); err != nil {
		return nil, fmt.Errorf("cbms: document: %w", err)
	}
	m["username"] = e.Creds.Username
	m["password"] = e.Creds.Password
	m["seller_pan"] = e.Creds.SellerPAN
	m["isrealtime"] = e.IsRealtime
	m["datetimeClient"] = e.DatetimeClient
	return json.Marshal(m)
}

// Result is CBMS's answer to one post.
type Result struct {
	Code int
	// Raw is the response body, trimmed, for the outbox's last_error.
	Raw string
}

// Synced reports whether the document is now on CBMS. A 101 on /bill means
// an earlier attempt (whose answer we lost) already stored it.
func (r Result) Synced(ep Endpoint) bool {
	return r.Code == CodeSuccess || (ep == EndpointBill && r.Code == CodeDuplicate)
}

// ErrTransport marks a failure to reach CBMS or read its answer (network,
// timeout, 5xx gateway). Such posts are retried; the content was never judged.
var ErrTransport = errors.New("cbms: transport failure")

// Client posts documents to CBMS.
type Client interface {
	Post(ctx context.Context, e Envelope) (Result, error)
	// Name identifies the implementation in logs ("live", "mock").
	Name() string
}
