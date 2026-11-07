package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
)

// =========================================================================
// IRD purchase register (0094): supplier bills on expenses, and returns.
// =========================================================================

func writeFiscalErr(w http.ResponseWriter, err error) {
	var ce *fiscal.CreditError
	if errors.As(err, &ce) {
		writeErr(w, ce.Status, ce.Code, ce.Msg)
		return
	}
	writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
}

// GET /v1/expenses/{id}/purchase-bill — expense:read
func GetPurchaseBill(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid expense id")
		return
	}
	b, err := fiscal.LoadPurchaseBillForExpense(r.Context(), appctx.Tx(r.Context()), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if b == nil {
		writeErr(w, http.StatusNotFound, "not_found", "no supplier bill recorded for this expense")
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// POST /v1/expenses/{id}/purchase-bill — expense:create
func CreatePurchaseBill(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid expense id")
		return
	}
	var in fiscal.PurchaseBillInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	t, _ := appctx.TenantFromContext(r.Context())
	u, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	b, err := fiscal.RecordPurchaseBill(r.Context(), tx, t.ID, u.ID, id, in)
	if err != nil {
		writeFiscalErr(w, err)
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "purchase_bill", EntityID: &b.ID,
		Summary: fmt.Sprintf("recorded supplier bill %s from %s (%s, VAT %s)",
			b.SupplierBillNo, b.SupplierName, audit.Money(b.TotalCents), audit.Money(b.VATCents)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, b)
}

// POST /v1/purchase-bills/{id}/returns — expense:create
func CreatePurchaseReturn(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid purchase bill id")
		return
	}
	var in fiscal.PurchaseReturnInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	t, _ := appctx.TenantFromContext(r.Context())
	u, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	pr, err := fiscal.RecordPurchaseReturn(r.Context(), tx, t.ID, u.ID, id, in)
	if err != nil {
		writeFiscalErr(w, err)
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "create", Entity: "purchase_return", EntityID: &pr.ID,
		Summary: fmt.Sprintf("recorded purchase return %s (%s): %s", pr.Number, audit.Money(pr.TotalCents), pr.Reason),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, pr)
}
