package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
)

// =========================================================================
// Issued IRD invoices: read and print. Issuing happens inside CloseOrder.
// =========================================================================

// InvoiceView is an invoice plus its print history.
type InvoiceView struct {
	Invoice *fiscal.Invoice      `json:"invoice"`
	Prints  []fiscal.PrintRecord `json:"prints"`
}

func loadInvoiceView(w http.ResponseWriter, r *http.Request, id, orderID *uuid.UUID) (*InvoiceView, bool) {
	tx := appctx.Tx(r.Context())
	inv, err := fiscal.LoadInvoice(r.Context(), tx, id, orderID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "no IRD invoice for this bill")
		return nil, false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return nil, false
	}
	prints, err := fiscal.PrintHistory(r.Context(), tx, "invoice", inv.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return nil, false
	}
	return &InvoiceView{Invoice: inv, Prints: prints}, true
}

// GET /v1/orders/{id}/invoice — fiscal:print
func GetOrderInvoice(w http.ResponseWriter, r *http.Request) {
	orderID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid order id")
		return
	}
	if v, ok := loadInvoiceView(w, r, nil, &orderID); ok {
		writeJSON(w, http.StatusOK, v)
	}
}

// GET /v1/invoices/{id} — fiscal:print
func GetInvoice(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid invoice id")
		return
	}
	if v, ok := loadInvoiceView(w, r, &id, nil); ok {
		writeJSON(w, http.StatusOK, v)
	}
}

// PrintResponse is what a client renders: the frozen invoice and the label
// this particular print must carry.
type PrintResponse struct {
	fiscal.PrintLabel
	Invoice *fiscal.Invoice `json:"invoice"`
}

// POST /v1/invoices/{id}/print — fiscal:print
//
// Body (optional): {"device": "Counter tablet"}. Records the print and returns
// its label: ORIGINAL first, then the seller's SECOND COPY, then "Copy of
// Original (n)" (fiscal.InvoicePrintLabel). Clients must print exactly the
// label returned — never decide it themselves — or two devices could both
// print an "original".
func PrintInvoice(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid invoice id")
		return
	}
	var body struct {
		Device string `json:"device"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
	}
	t, _ := appctx.TenantFromContext(r.Context())
	u, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	inv, err := fiscal.LoadInvoice(r.Context(), tx, &id, nil)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	label, err := fiscal.RecordPrint(r.Context(), tx, t.ID, "invoice", inv.ID, u.ID,
		func(n int) fiscal.PrintLabel { return fiscal.InvoicePrintLabel(inv.Kind, n) }, body.Device)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "print", Entity: "invoice", EntityID: &inv.ID,
		Summary: fmt.Sprintf("printed invoice %s FY %s (%s)", inv.Number, inv.FiscalYear, label.CopyLabel),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, PrintResponse{PrintLabel: label, Invoice: inv})
}
