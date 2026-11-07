package api

import (
	"strings"
	"testing"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal"
)

func TestFiscalDocuments_AllRender(t *testing.T) {
	fx := newFiscalTenant(t, "vat")
	var pan string
	fx.adminScan([]any{&pan}, `SELECT pan FROM fiscal_profiles WHERE tenant_id = $1`, fx.Tenant)
	for _, d := range fiscal.TaxpayerDocuments {
		r := callHandler(t, fx, GetFiscalDocument, "GET", "/", nil, withParam("kind", d.Kind)).expectStatus(200)
		body := string(r.Body)
		if !strings.HasPrefix(body, "<!doctype html>") || !strings.Contains(body, "Go Serve") {
			t.Errorf("%s: not a full page", d.Kind)
		}
		if d.Kind != "portal_guide" && !strings.Contains(body, pan) {
			t.Errorf("%s: taxpayer PAN missing", d.Kind)
		}
		if strings.Contains(body, "&lt;span") {
			t.Errorf("%s: escaped placeholder markup", d.Kind)
		}
	}
	callHandler(t, fx, GetFiscalDocument, "GET", "/", nil, withParam("kind", "nope")).expectErr(404, "unknown_document")
}

func TestFiscalDocuments_NeedRegistration(t *testing.T) {
	fx := newTenant(t)
	callHandler(t, fx, GetFiscalDocument, "GET", "/", nil, withParam("kind", "annex3_application")).
		expectErr(409, "profile_required")
}
