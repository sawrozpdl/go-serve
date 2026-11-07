package super

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
)

// GET /v1/super/ird/profile — the producer + data-centre details every IRD
// document is filled from.
func GetIRDProfile(w http.ResponseWriter, r *http.Request) {
	p, err := fiscal.LoadPlatformProfile(r.Context(), appctx.Tx(r.Context()))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// PUT /v1/super/ird/profile
func UpdateIRDProfile(w http.ResponseWriter, r *http.Request) {
	var p fiscal.PlatformProfile
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&p); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if pan, ok := fiscal.NormalizePAN(p.Producer.PAN); p.Producer.PAN != "" && !ok {
		writeErr(w, http.StatusBadRequest, "invalid_pan", "producer PAN must be 9 digits")
		return
	} else if ok {
		p.Producer.PAN = pan
	}
	u, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	if err := fiscal.SavePlatformProfile(r.Context(), tx, u.ID, p); err != nil {
		var ce *fiscal.CreditError
		if errors.As(err, &ce) {
			writeErr(w, ce.Status, ce.Code, ce.Msg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	logPlatform(r, tx, audit.PlatformEntry{Action: "ird.profile_update", TargetID: "platform_ird_profile",
		Summary: "updated the IRD producer / data-centre profile"})
	GetIRDProfile(w, r)
}

// GET /v1/super/ird/documents/{kind} — producer documents (Annex 1).
func GetIRDProducerDocument(w http.ResponseWriter, r *http.Request) {
	kind := chi.URLParam(r, "kind")
	ok := false
	for _, k := range fiscal.ProducerDocuments {
		if k.Kind == kind {
			ok = true
		}
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no such producer document")
		return
	}
	pp, err := fiscal.LoadPlatformProfile(r.Context(), appctx.Tx(r.Context()))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	html, err := fiscal.RenderDocument(kind, fiscal.NewDocData(pp, fiscal.Profile{}, "", nil))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(html)
}
