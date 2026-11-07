// Package fiscal implements Nepal IRD electronic invoicing for a café: its tax
// profile, gap-free invoice numbering, immutable invoice snapshots, CBMS
// posting and the IRD registers. See docs/ird/COMPLIANCE.md for the clause by
// clause map from the Electronic Billing Procedure 2082 / 2074 to this code.
//
// The package holds domain logic only. HTTP handlers live in internal/api like
// every other handler and call in here with the request transaction.
package fiscal

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Settings are process-wide fiscal settings, installed once at startup.
type Settings struct {
	QRVerifyBaseURL string
}

var settings Settings

// Configure installs the process-wide settings (cmd/server/main.go).
func Configure(s Settings) { settings = s }

// Registration is how a café is registered with IRD.
type Registration string

const (
	RegNone Registration = "none" // not registered; no fiscal documents
	RegPAN  Registration = "pan"  // income-tax (PAN) only: "Invoice", no VAT
	RegVAT  Registration = "vat"  // VAT registered: "Tax Invoice", 13% VAT
)

// Valid reports whether r is a known registration type.
func (r Registration) Valid() bool {
	return r == RegNone || r == RegPAN || r == RegVAT
}

// VATRatePct is the statutory VAT rate the database insists on for a VAT café
// in fiscal mode (fiscal_tax_settings_violation, migration 0089).
const VATRatePct = "13"

// Profile is a café's fiscal_profiles row. A tenant without a row has the zero
// profile (RegNone, fiscal mode off).
type Profile struct {
	TenantID        uuid.UUID
	Registration    Registration
	PAN             string
	LegalName       string
	LegalNameNE     string
	Address         string
	Phone           string
	Email           string
	TaxOffice       string
	PermitNo        string
	OutletCode      string
	FiscalModeAt    *time.Time
	FiscalModeBy    *uuid.UUID
	CBMSEnabled     bool
	CBMSUsername    string
	CBMSPasswordSet bool
	CBMSPasswordEnc []byte
	CBMSKeyID       string
	UpdatedAt       *time.Time
	persisted       bool
}

// FiscalMode reports whether the café issues IRD invoices.
func (p Profile) FiscalMode() bool { return p.FiscalModeAt != nil }

// Persisted reports whether the profile row exists.
func (p Profile) Persisted() bool { return p.persisted }

// LoadProfile reads the tenant's profile inside tx (RLS-scoped to the tenant).
// A missing row is not an error: it yields the zero profile.
func LoadProfile(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (Profile, error) {
	p := Profile{TenantID: tenantID, Registration: RegNone}
	var reg string
	var pan *string
	var updated time.Time
	err := tx.QueryRow(ctx, `
		SELECT registration_type, pan, legal_name, legal_name_ne, address, phone, email,
		       tax_office, permit_no, outlet_code, fiscal_mode_enabled_at, fiscal_mode_enabled_by,
		       cbms_enabled, cbms_username, cbms_password_enc, cbms_key_id, updated_at
		FROM fiscal_profiles WHERE tenant_id = $1
	`, tenantID).Scan(&reg, &pan, &p.LegalName, &p.LegalNameNE, &p.Address, &p.Phone, &p.Email,
		&p.TaxOffice, &p.PermitNo, &p.OutletCode, &p.FiscalModeAt, &p.FiscalModeBy,
		&p.CBMSEnabled, &p.CBMSUsername, &p.CBMSPasswordEnc, &p.CBMSKeyID, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, nil
	}
	if err != nil {
		return Profile{}, err
	}
	p.Registration = Registration(reg)
	if pan != nil {
		p.PAN = *pan
	}
	p.CBMSPasswordSet = len(p.CBMSPasswordEnc) > 0
	p.UpdatedAt = &updated
	p.persisted = true
	return p, nil
}

var (
	panRe    = regexp.MustCompile(`^[0-9]{9}$`)
	outletRe = regexp.MustCompile(`^[A-Z0-9]{0,6}$`)
)

// NormalizePAN strips the spaces and dashes people type into a PAN and
// reports whether the result is a 9-digit PAN.
func NormalizePAN(s string) (string, bool) {
	s = strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(s))
	return s, panRe.MatchString(s)
}

// NormalizeOutletCode upper-cases an outlet code and reports whether it is
// 0–6 characters of A–Z / 0–9.
func NormalizeOutletCode(s string) (string, bool) {
	s = strings.ToUpper(strings.TrimSpace(s))
	return s, outletRe.MatchString(s)
}

// Problem is one reason a café cannot (yet) switch on fiscal mode. Code is
// stable for the UI; Message is shown as-is.
type Problem struct {
	Code    string `json:"code"`
	Field   string `json:"field,omitempty"`
	Message string `json:"message"`
}

// Readiness lists what stands between the café and fiscal mode. Tax-setting
// problems come from the same SQL function the database triggers use, so the
// wizard and the backstop can never disagree.
func Readiness(ctx context.Context, tx pgx.Tx, p Profile) ([]Problem, error) {
	var out []Problem
	if p.Registration == RegNone {
		out = append(out, Problem{Code: "registration_required", Field: "registration_type",
			Message: "Choose PAN or VAT registration."})
	}
	if _, ok := NormalizePAN(p.PAN); p.Registration != RegNone && !ok {
		out = append(out, Problem{Code: "pan_required", Field: "pan",
			Message: "Enter the café's 9-digit PAN."})
	}
	if strings.TrimSpace(p.LegalName) == "" {
		out = append(out, Problem{Code: "legal_name_required", Field: "legal_name",
			Message: "Enter the name the café is registered under; it is printed on every invoice."})
	}
	if strings.TrimSpace(p.Address) == "" {
		out = append(out, Problem{Code: "address_required", Field: "address",
			Message: "Enter the registered address; it is printed on every invoice."})
	}
	if p.Registration != RegNone {
		var msg *string
		if err := tx.QueryRow(ctx, `
			SELECT fiscal_tax_settings_violation($1, service_charge_pct, vat_mode, vat_pct)
			FROM tenants WHERE id = $2
		`, string(p.Registration), p.TenantID).Scan(&msg); err != nil {
			return nil, err
		}
		if msg != nil {
			out = append(out, Problem{Code: "tax_settings", Field: "tax_settings", Message: *msg + "."})
		}
	}
	return out, nil
}
