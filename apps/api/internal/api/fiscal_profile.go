package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
)

// =========================================================================
// Fiscal profile — a café's IRD registration and the one-way fiscal switch.
// Migration 0089 holds the invariants; these handlers explain them.
// =========================================================================

// FiscalProfileDTO is the owner-facing profile. The CBMS password is never
// returned — only whether one is stored.
type FiscalProfileDTO struct {
	RegistrationType string           `json:"registration_type"`
	PAN              string           `json:"pan"`
	LegalName        string           `json:"legal_name"`
	LegalNameNE      string           `json:"legal_name_ne"`
	Address          string           `json:"address"`
	Phone            string           `json:"phone"`
	Email            string           `json:"email"`
	TaxOffice        string           `json:"tax_office"`
	PermitNo         string           `json:"permit_no"`
	OutletCode       string           `json:"outlet_code"`
	FiscalMode       bool             `json:"fiscal_mode"`
	FiscalModeAt     *time.Time       `json:"fiscal_mode_enabled_at"`
	CBMSEnabled      bool             `json:"cbms_enabled"`
	CBMSUsername     string           `json:"cbms_username"`
	CBMSPasswordSet  bool             `json:"cbms_password_set"`
	Readiness        []fiscal.Problem `json:"readiness"`
}

func toFiscalProfileDTO(p fiscal.Profile, ready []fiscal.Problem) FiscalProfileDTO {
	if ready == nil {
		ready = []fiscal.Problem{}
	}
	return FiscalProfileDTO{
		RegistrationType: string(p.Registration),
		PAN:              p.PAN,
		LegalName:        p.LegalName,
		LegalNameNE:      p.LegalNameNE,
		Address:          p.Address,
		Phone:            p.Phone,
		Email:            p.Email,
		TaxOffice:        p.TaxOffice,
		PermitNo:         p.PermitNo,
		OutletCode:       p.OutletCode,
		FiscalMode:       p.FiscalMode(),
		FiscalModeAt:     p.FiscalModeAt,
		CBMSEnabled:      p.CBMSEnabled,
		CBMSUsername:     p.CBMSUsername,
		CBMSPasswordSet:  p.CBMSPasswordSet,
		Readiness:        ready,
	}
}

// GET /v1/fiscal/profile — fiscal:manage
func GetFiscalProfile(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	tx := appctx.Tx(r.Context())
	p, err := fiscal.LoadProfile(r.Context(), tx, t.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	var ready []fiscal.Problem
	if !p.FiscalMode() {
		if ready, err = fiscal.Readiness(r.Context(), tx, p); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, toFiscalProfileDTO(p, ready))
}

// PATCH /v1/fiscal/profile — fiscal:manage
//
// Every field is optional. Once fiscal mode is on, registration_type, pan and
// outlet_code are frozen (the database refuses; we refuse first, in words).
func UpdateFiscalProfile(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	var body struct {
		RegistrationType *string `json:"registration_type"`
		PAN              *string `json:"pan"`
		LegalName        *string `json:"legal_name"`
		LegalNameNE      *string `json:"legal_name_ne"`
		Address          *string `json:"address"`
		Phone            *string `json:"phone"`
		Email            *string `json:"email"`
		TaxOffice        *string `json:"tax_office"`
		PermitNo         *string `json:"permit_no"`
		OutletCode       *string `json:"outlet_code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}

	cur, err := fiscal.LoadProfile(r.Context(), tx, t.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	next := cur

	if body.RegistrationType != nil {
		reg := fiscal.Registration(strings.TrimSpace(*body.RegistrationType))
		if !reg.Valid() {
			writeErr(w, http.StatusBadRequest, "bad_request", `registration_type must be "none", "pan" or "vat"`)
			return
		}
		next.Registration = reg
	}
	if body.PAN != nil {
		pan := strings.TrimSpace(*body.PAN)
		if pan != "" {
			var ok bool
			if pan, ok = fiscal.NormalizePAN(pan); !ok {
				writeErr(w, http.StatusBadRequest, "invalid_pan", "PAN must be 9 digits")
				return
			}
		}
		next.PAN = pan
	}
	if body.OutletCode != nil {
		code, ok := fiscal.NormalizeOutletCode(*body.OutletCode)
		if !ok {
			writeErr(w, http.StatusBadRequest, "invalid_outlet_code",
				"outlet code must be up to 6 letters or digits")
			return
		}
		next.OutletCode = code
	}
	for _, f := range []struct {
		in  *string
		out *string
		max int
	}{
		{body.LegalName, &next.LegalName, 200},
		{body.LegalNameNE, &next.LegalNameNE, 200},
		{body.Address, &next.Address, 300},
		{body.Phone, &next.Phone, 40},
		{body.Email, &next.Email, 200},
		{body.TaxOffice, &next.TaxOffice, 200},
		{body.PermitNo, &next.PermitNo, 60},
	} {
		if f.in == nil {
			continue
		}
		v := strings.TrimSpace(*f.in)
		if len([]rune(v)) > f.max {
			writeErr(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("a field is longer than %d characters", f.max))
			return
		}
		*f.out = v
	}
	if next.Registration != fiscal.RegNone && next.PAN == "" {
		writeErr(w, http.StatusBadRequest, "pan_required", "a PAN or VAT registration needs the 9-digit PAN")
		return
	}
	if cur.FiscalMode() && (next.Registration != cur.Registration || next.PAN != cur.PAN || next.OutletCode != cur.OutletCode) {
		writeErr(w, http.StatusConflict, "fiscal_identity_frozen",
			"registration type, PAN and outlet code cannot change once IRD fiscal mode is on")
		return
	}

	var panArg any
	if next.PAN != "" {
		panArg = next.PAN
	}
	_, err = tx.Exec(r.Context(), `
		INSERT INTO fiscal_profiles (tenant_id, registration_type, pan, legal_name, legal_name_ne,
		                             address, phone, email, tax_office, permit_no, outlet_code)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (tenant_id) DO UPDATE SET
		  registration_type = EXCLUDED.registration_type,
		  pan               = EXCLUDED.pan,
		  legal_name        = EXCLUDED.legal_name,
		  legal_name_ne     = EXCLUDED.legal_name_ne,
		  address           = EXCLUDED.address,
		  phone             = EXCLUDED.phone,
		  email             = EXCLUDED.email,
		  tax_office        = EXCLUDED.tax_office,
		  permit_no         = EXCLUDED.permit_no,
		  outlet_code       = EXCLUDED.outlet_code
	`, t.ID, string(next.Registration), panArg, next.LegalName, next.LegalNameNE,
		next.Address, next.Phone, next.Email, next.TaxOffice, next.PermitNo, next.OutletCode)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "fiscal_profiles_pan_outlet_uniq" {
			writeErr(w, http.StatusConflict, "pan_outlet_taken",
				"another branch already bills under this PAN with this outlet code — give each branch its own outlet code")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "fiscal_profile", EntityID: &t.ID,
		Summary: fmt.Sprintf("updated tax profile (%s)", strings.Join(fieldNames(body), ", ")),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	GetFiscalProfile(w, r)
}

// POST /v1/fiscal/enable — fiscal:manage
//
// Body: {"confirm_pan": "<the PAN again>"}. Re-typing the PAN is the
// confirmation: this switch is one-way, and from here every settle issues a
// numbered IRD invoice that can never be edited or deleted.
func EnableFiscalMode(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())
	u, _ := appctx.UserFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	var body struct {
		ConfirmPAN string `json:"confirm_pan"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}

	// Lock the row so two owners clicking at once cannot both "enable".
	if _, err := tx.Exec(r.Context(),
		`SELECT 1 FROM fiscal_profiles WHERE tenant_id = $1 FOR UPDATE`, t.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	p, err := fiscal.LoadProfile(r.Context(), tx, t.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if p.FiscalMode() {
		writeErr(w, http.StatusConflict, "already_enabled", "IRD fiscal mode is already on")
		return
	}
	ready, err := fiscal.Readiness(r.Context(), tx, p)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if len(ready) > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code":      "not_ready",
			"message":   ready[0].Message,
			"readiness": ready,
		})
		return
	}
	if confirm, _ := fiscal.NormalizePAN(body.ConfirmPAN); confirm != p.PAN {
		writeErr(w, http.StatusBadRequest, "confirm_mismatch", "type the café's PAN to confirm")
		return
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE fiscal_profiles
		SET fiscal_mode_enabled_at = now(), fiscal_mode_enabled_by = $2
		WHERE tenant_id = $1 AND fiscal_mode_enabled_at IS NULL
	`, t.ID, u.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	// audit.Log consults the billing state loaded at the start of the request,
	// which predates the switch — write this one row directly so the moment
	// fiscal mode began is always on record.
	if err := audit.LogAlways(r.Context(), tx, audit.Entry{
		Action: "enable", Entity: "fiscal_profile", EntityID: &t.ID,
		Summary: fmt.Sprintf("switched on IRD fiscal mode (%s %s)", strings.ToUpper(string(p.Registration)), p.PAN),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	GetFiscalProfile(w, r)
}
