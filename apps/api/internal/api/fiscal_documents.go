package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
)

// GET /v1/fiscal/documents — fiscal:manage
func ListFiscalDocuments(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"documents": fiscal.TaxpayerDocuments})
}

// GET /v1/fiscal/documents/{kind} — fiscal:manage
//
// A pre-filled IRD form or letter as an HTML page for the browser to print to
// PDF. Producer and data-centre details come from the super console.
func GetFiscalDocument(w http.ResponseWriter, r *http.Request) {
	kind := chi.URLParam(r, "kind")
	t, _ := appctx.TenantFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	prof, err := fiscal.LoadProfile(r.Context(), tx, t.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if prof.Registration == fiscal.RegNone {
		writeErr(w, http.StatusConflict, "profile_required", "save the café's PAN or VAT registration first")
		return
	}
	pp, err := fiscal.LoadPlatformProfile(r.Context(), tx)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	// One billing outlet per café (a branch is its own café with its own
	// documents; branches on one PAN carry distinct outlet codes).
	branches := []fiscal.Branch{{Name: t.Name, OutletCode: prof.OutletCode, Address: prof.Address}}
	html, err := fiscal.RenderDocument(kind, fiscal.NewDocData(pp, prof, t.Name, branches))
	if err != nil {
		writeFiscalErr(w, err)
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "export", Entity: "fiscal_document", Summary: "generated IRD document " + kind,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(html)
}
