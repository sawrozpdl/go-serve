package fiscal

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
	"github.com/pewssh/cafe-mgmt/api/internal/version"
)

// IRD paperwork, pre-filled (procedure 2082 Annex 1, 2, 3, 7, 8; §7.2(ख)(च)).
// Each document is an HTML page the browser prints to PDF; the owner checks
// it, signs and stamps it. Wording follows the procedure's annexes; every page
// carries a footer asking the signer to check it against the current annex.

// Producer is the company that lists Go Serve with IRD (Annex 1).
type Producer struct {
	Company       string `json:"company"`
	CompanyNE     string `json:"company_ne"`
	PAN           string `json:"pan"`
	Address       string `json:"address"`
	AddressNE     string `json:"address_ne"`
	TaxOffice     string `json:"tax_office"`
	RegisteredOn  string `json:"registered_on"`
	Director      string `json:"director"`
	DirectorTitle string `json:"director_title"`
	Email         string `json:"email"`
	Phone         string `json:"phone"`
	Mobile        string `json:"mobile"`
	Website       string `json:"website"`
	EnlistedNo    string `json:"enlisted_no"`
	EnlistedOn    string `json:"enlisted_on"`
	SoftwareName  string `json:"software_name"`
}

// Datacenter is the hosting provider (Annex 7).
type Datacenter struct {
	Company      string `json:"company"`
	PAN          string `json:"pan"`
	Address      string `json:"address"`
	Phone        string `json:"phone"`
	Contact      string `json:"contact"`
	Location     string `json:"location"`
	ServerIP     string `json:"server_ip"`
	ServerType   string `json:"server_type"`
	HostingModel string `json:"hosting_model"` // VPS | Co-located | Bare metal
	Tier         string `json:"tier"`
	DRSite       string `json:"dr_site"`
	Database     string `json:"database"`
	SSL          string `json:"ssl"`
	Domain       string `json:"domain"`
}

// PlatformProfile is the producer + data centre.
type PlatformProfile struct {
	Producer   Producer   `json:"producer"`
	Datacenter Datacenter `json:"datacenter"`
}

// LoadPlatformProfile reads the producer and data-centre details (readable by
// any signed-in café through the SECURITY DEFINER ird_platform_profile()).
func LoadPlatformProfile(ctx context.Context, tx pgx.Tx) (PlatformProfile, error) {
	var p PlatformProfile
	var prod, dc []byte
	err := tx.QueryRow(ctx, `SELECT producer, datacenter FROM ird_platform_profile()`).Scan(&prod, &dc)
	if err == pgx.ErrNoRows {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	_ = json.Unmarshal(prod, &p.Producer)
	_ = json.Unmarshal(dc, &p.Datacenter)
	if p.Producer.SoftwareName == "" {
		p.Producer.SoftwareName = version.Product
	}
	return p, nil
}

// SavePlatformProfile writes it (platform admins only, by RLS).
func SavePlatformProfile(ctx context.Context, tx pgx.Tx, userID uuid.UUID, p PlatformProfile) error {
	prod, _ := json.Marshal(p.Producer)
	dc, _ := json.Marshal(p.Datacenter)
	tag, err := tx.Exec(ctx, `
		UPDATE platform_ird_profile SET producer = $1, datacenter = $2, updated_at = now(), updated_by = $3 WHERE id = 1
	`, prod, dc, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return refuse(403, "forbidden", "platform admins only")
	}
	return nil
}

// Branch is one billing outlet of the taxpayer (for Annex 3).
type Branch struct {
	Name       string
	OutletCode string
	Address    string
}

// DocData is what every template receives.
type DocData struct {
	Producer   Producer
	Datacenter Datacenter
	Taxpayer   Profile
	TradeName  string
	Branches   []Branch
	Software   string
	Version    string
	TodayBS    string
	TodayAD    string
	FiscalYear string
}

// DocumentKind describes one generator.
type DocumentKind struct {
	Kind    string `json:"kind"`
	Title   string `json:"title"`
	TitleNE string `json:"title_ne"`
	Who     string `json:"who"` // who signs / files it
}

// TaxpayerDocuments are generated per café (Settings → Tax & IRD → Documents).
var TaxpayerDocuments = []DocumentKind{
	{"portal_guide", "Taxpayer Portal: e-billing permission, step by step", "करदाता पोर्टल निर्देशिका", "Café (for its own use)"},
	{"annex3_application", "Annex 3 — Application for permission to issue electronic invoices", "अनुसूची ३ — विद्युतीय बीजक जारी गर्ने अनुमतिको निवेदन", "Café, to its tax office"},
	{"annex2_consent", "Annex 2 — Producer's consent letter", "अनुसूची २ — उत्पादकको सहमति पत्र", "Producer, to the café"},
	{"annex7_agreement", "Annex 7 — Three-party agreement (cloud server)", "अनुसूची ७ — त्रिपक्षीय सम्झौता", "Café, producer and data centre"},
	{"server_location_notice", "Server location notice (§7.2(ख))", "सर्भर रहेको स्थानको जानकारी", "Café, to IRD and its tax office"},
	{"temporary_server_request", "Temporary server request (§7.2(च))", "अस्थायी सर्भर प्रयोग अनुमतिको निवेदन", "Café, to its tax office"},
	{"annex8_closure", "Annex 8 — Application to close the e-billing permit", "अनुसूची ८ — अनुमति बन्द गर्ने निवेदन", "Café, to its tax office"},
}

// ProducerDocuments are generated once, in the super console.
var ProducerDocuments = []DocumentKind{
	{"annex1_listing", "Annex 1 — Software listing application values", "अनुसूची १ — सफ्टवेयर सूचीकरण निवेदन", "Producer, on the Taxpayer Portal"},
}

//go:embed doctemplates/*.html
var docFS embed.FS

var docTemplates = template.Must(template.New("").Funcs(template.FuncMap{
	"or": func(a, b string) string {
		if a != "" {
			return a
		}
		return b
	},
	// blankOr prints the value, or a dotted line to write on when it is empty.
	"blankOr": func(s string) template.HTML {
		if s == "" {
			return `<span class="blank"></span>`
		}
		return template.HTML(template.HTMLEscapeString(s))
	},
	"inc": func(i int) int { return i + 1 },
}).ParseFS(docFS, "doctemplates/*.html"))

// RenderDocument renders one document as a complete HTML page.
func RenderDocument(kind string, d DocData) ([]byte, error) {
	known := false
	for _, k := range append(append([]DocumentKind{}, TaxpayerDocuments...), ProducerDocuments...) {
		if k.Kind == kind {
			known = true
		}
	}
	if !known {
		return nil, refuse(404, "unknown_document", "no such document: "+kind)
	}
	var buf bytes.Buffer
	if err := docTemplates.ExecuteTemplate(&buf, kind+".html", d); err != nil {
		return nil, fmt.Errorf("fiscal: render %s: %w", kind, err)
	}
	return buf.Bytes(), nil
}

// NewDocData fills the common fields.
func NewDocData(pp PlatformProfile, prof Profile, tradeName string, branches []Branch) DocData {
	now := time.Now()
	bs, _ := bsdate.FromTime(now)
	return DocData{
		Producer: pp.Producer, Datacenter: pp.Datacenter, Taxpayer: prof, TradeName: tradeName, Branches: branches,
		Software: pp.Producer.SoftwareName, Version: version.Version,
		TodayBS: bs.String(), TodayAD: now.In(bsdate.Nepal).Format("2006-01-02"),
		FiscalYear: bsdate.FiscalYearOf(bs).String(),
	}
}
