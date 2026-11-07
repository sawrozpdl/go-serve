package api

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
)

// =========================================================================
// IRD registers: Standard View, sales / purchase books and their returns,
// VAT summary, party-wise > Rs 1 lakh, KOT log, print log, CBMS status and
// the audit trail — as JSON for the screen or CSV / Excel / XML downloads.
// =========================================================================

// GET /v1/fiscal/registers — fiscal:read
func ListRegisters(w http.ResponseWriter, r *http.Request) {
	now, _ := bsdate.FromTime(time.Now())
	writeJSON(w, http.StatusOK, map[string]any{
		"registers":           fiscal.RegisterKinds,
		"current_fiscal_year": bsdate.FiscalYearOf(now).String(),
		"current_month":       now.Month,
	})
}

func parsePeriod(r *http.Request) (fiscal.Period, string) {
	now, _ := bsdate.FromTime(time.Now())
	p := fiscal.Period{FY: bsdate.FiscalYearOf(now)}
	if s := r.URL.Query().Get("fy"); s != "" {
		fy, err := bsdate.ParseFiscalYear(s)
		if err != nil {
			return p, "fy must look like 2083/84"
		}
		p.FY = fy
	}
	if s := r.URL.Query().Get("month"); s != "" && s != "0" {
		m, err := strconv.Atoi(s)
		if err != nil || m < 1 || m > 12 {
			return p, "month must be 1–12 (Baisakh = 1)"
		}
		p.Month = m
	}
	return p, ""
}

// GET /v1/fiscal/registers/{kind}?fy=2083/84&month=7&format=json|csv|xlsx|xml — fiscal:read
func GetRegister(w http.ResponseWriter, r *http.Request) {
	kind := chi.URLParam(r, "kind")
	p, msg := parsePeriod(r)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, "bad_request", msg)
		return
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "json"
	}
	t, _ := appctx.TenantFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	prof, err := fiscal.LoadProfile(r.Context(), tx, t.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	table, err := fiscal.BuildRegister(r.Context(), tx, kind, p, prof)
	if err != nil {
		writeFiscalErr(w, err)
		return
	}
	if format == "json" {
		writeJSON(w, http.StatusOK, table)
		return
	}

	var ct, ext string
	var write func(http.ResponseWriter) error
	switch format {
	case "csv":
		ct, ext = "text/csv; charset=utf-8", "csv"
		write = func(w http.ResponseWriter) error { return fiscal.WriteCSV(w, table) }
	case "xlsx":
		ct, ext = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"
		write = func(w http.ResponseWriter) error { return fiscal.WriteXLSX(w, table) }
	case "xml":
		ct, ext = "application/xml; charset=utf-8", "xml"
		write = func(w http.ResponseWriter) error { return fiscal.WriteXML(w, table) }
	default:
		writeErr(w, http.StatusBadRequest, "bad_request", "format must be json, csv, xlsx or xml")
		return
	}
	// Exports are on the record (2074 §6(ञ): the audit trail covers them).
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "export", Entity: "register",
		Summary: fmt.Sprintf("exported %s, %s (%s, %d rows)", table.Title, p.Label(), ext, len(table.Rows)),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", `attachment; filename="`+fiscal.ExportFilename(kind, p, ext)+`"`)
	if err := write(w); err != nil {
		appctx.Logger(r.Context()).ErrorContext(r.Context(), "fiscal.register_export_failed", "err", err.Error())
	}
}

// AuditChainResult is the outcome of walking the tenant's hash chain.
type AuditChainResult struct {
	OK          bool       `json:"ok"`
	RowsChecked int64      `json:"rows_checked"`
	FirstBadSeq *int64     `json:"first_bad_seq,omitempty"`
	FirstBadID  *uuid.UUID `json:"first_bad_id,omitempty"`
}

// GET /v1/fiscal/audit-chain — fiscal:read
func VerifyAuditChain(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	var out AuditChainResult
	if err := appctx.Tx(r.Context()).QueryRow(r.Context(), `SELECT * FROM audit_chain_verify($1)`, t.ID).
		Scan(&out.OK, &out.RowsChecked, &out.FirstBadSeq, &out.FirstBadID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GET /v1/fiscal/export?fy=2083/84 — fiscal:manage
//
// The café's full records archive (zip): every fiscal and operational table
// as CSV, the year's IRD registers as Excel, and a SHA-256 manifest.
func ExportFiscalRecords(w http.ResponseWriter, r *http.Request) {
	p, msg := parsePeriod(r)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, "bad_request", msg)
		return
	}
	t, _ := appctx.TenantFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	prof, err := fiscal.LoadProfile(r.Context(), tx, t.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "export", Entity: "records",
		Summary: fmt.Sprintf("downloaded the full records archive (registers FY %s)", p.FY),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	name := fmt.Sprintf("%s-records-%s.zip", t.Slug, time.Now().In(bsdate.Nepal).Format("20060102-1504"))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	if err := fiscal.WriteRecordsArchive(r.Context(), tx, w, prof, p.FY); err != nil {
		appctx.Logger(r.Context()).ErrorContext(r.Context(), "fiscal.records_export_failed", "err", err.Error())
	}
}
