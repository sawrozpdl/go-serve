package api

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// =========================================================================
// Wire types
// =========================================================================

type Tenant struct {
	ID               uuid.UUID `json:"id"`
	Slug             string    `json:"slug"`
	Name             string    `json:"name"`
	Branding         any       `json:"branding"`
	Preferences      any       `json:"preferences"`
	Plan             string    `json:"plan"`
	Status           string    `json:"status"`
	Timezone         string    `json:"timezone"`
	VatPct           string    `json:"vat_pct"`
	VatMode          string    `json:"vat_mode"`
	ServiceChargePct string    `json:"service_charge_pct"`
	CreatedAt        time.Time `json:"created_at"`
}

// =========================================================================
// GET /v1/tenant
// =========================================================================

func GetTenant(w http.ResponseWriter, r *http.Request) {
	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "tenant.get")
	t, _ := appctx.TenantFromContext(r.Context())
	tx := appctx.Tx(r.Context())

	var out Tenant
	var branding, preferences []byte
	if err := tx.QueryRow(r.Context(), `
		SELECT id, slug, name, branding, preferences, plan, status, timezone,
		       vat_pct::text, vat_mode, service_charge_pct::text, created_at
		FROM tenants WHERE id = $1
	`, t.ID).Scan(&out.ID, &out.Slug, &out.Name, &branding, &preferences,
		&out.Plan, &out.Status, &out.Timezone, &out.VatPct, &out.VatMode, &out.ServiceChargePct,
		&out.CreatedAt); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	_ = json.Unmarshal(branding, &out.Branding)
	_ = json.Unmarshal(preferences, &out.Preferences)
	writeJSON(w, http.StatusOK, out)
}

// =========================================================================
// PATCH /v1/tenant — owner-only
// =========================================================================

func UpdateTenant(w http.ResponseWriter, r *http.Request) {
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		Name             *string `json:"name"`
		Timezone         *string `json:"timezone"`
		VatPct           *string `json:"vat_pct"`
		VatMode          *string `json:"vat_mode"`
		ServiceChargePct *string `json:"service_charge_pct"`
		Branding         *struct {
			BrandPrimary *string `json:"brandPrimary,omitempty"`
			BrandAccent  *string `json:"brandAccent,omitempty"`
			CafeName     *string `json:"cafeName,omitempty"`
			LogoURL      *string `json:"logoUrl,omitempty"`
			WordmarkURL  *string `json:"wordmarkUrl,omitempty"`
			Mood         *string `json:"mood,omitempty"`
			Tagline      *string `json:"tagline,omitempty"`
			AccentEmoji  *string `json:"accentEmoji,omitempty"`
			Typography   *string `json:"typography,omitempty"`
		} `json:"branding"`
		// Operational behavior flags. Each is optional — a missing key keeps
		// the existing value (jsonb || merge).
		Preferences *struct {
			AutoServeOnReady  *bool `json:"autoServeOnReady,omitempty"`
			AutoCleanTables   *bool `json:"autoCleanTables,omitempty"`
			CombinedSettle    *bool `json:"combinedSettle,omitempty"`
			StackItems        *bool `json:"stackItems,omitempty"`
			DiscountAutoApply *bool `json:"discountAutoApply,omitempty"`
			AutoRecordPayment *bool `json:"autoRecordPayment,omitempty"`
			RequireTxnRef     *bool `json:"requireTxnRef,omitempty"`
			DefaultDiscount   *struct {
				Mode   *string `json:"mode,omitempty"`
				Reason *string `json:"reason,omitempty"`
			} `json:"defaultDiscount,omitempty"`
			// OpeningHours is the cafe's weekly opening window, same shape as a
			// staff schedule: day "0"(Sun)–"6"(Sat) → {start,end} "HH:MM". The
			// client sends the whole object, so the jsonb merge replaces the key
			// wholesale (a removed day simply disappears).
			OpeningHours map[string]struct {
				Start string `json:"start"`
				End   string `json:"end"`
			} `json:"openingHours,omitempty"`
			// ComfortCoverage is the staffing level the timeline highlights below
			// — purely informational, nothing is enforced server-side.
			ComfortCoverage *int `json:"comfortCoverage,omitempty"`
			// Thermal-printer flags. The backend never prints (printing is a
			// browser window.print() on the till device); these are persisted
			// here only so the client can read them back via GET /v1/tenant.
			PrintingEnabled      *bool   `json:"printingEnabled,omitempty"`
			PrintKitchenTicket   *bool   `json:"printKitchenTicket,omitempty"`
			PrintCustomerReceipt *bool   `json:"printCustomerReceipt,omitempty"`
			ReceiptWidth         *string `json:"receiptWidth,omitempty"`
			ReceiptHeader        *string `json:"receiptHeader,omitempty"`
			ReceiptFooter        *string `json:"receiptFooter,omitempty"`
		} `json:"preferences"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	if body.VatMode != nil {
		switch *body.VatMode {
		case "none", "inclusive", "exclusive":
		default:
			writeErr(w, http.StatusBadRequest, "bad_request", "vat_mode must be one of 'none', 'inclusive', 'exclusive'")
			return
		}
	}

	log := appctx.Logger(r.Context())
	log.DebugContext(r.Context(), "tenant.update", "fields", fieldNames(body))

	tx := appctx.Tx(r.Context())

	// Branding is stored as a single jsonb. We MERGE incoming keys onto the
	// existing object so partial updates don't clobber unrelated keys.
	var brandingJSON []byte
	if body.Branding != nil {
		patch := map[string]any{}
		if body.Branding.BrandPrimary != nil {
			patch["brandPrimary"] = *body.Branding.BrandPrimary
		}
		if body.Branding.BrandAccent != nil {
			patch["brandAccent"] = *body.Branding.BrandAccent
		}
		if body.Branding.CafeName != nil {
			patch["cafeName"] = *body.Branding.CafeName
		}
		if body.Branding.LogoURL != nil {
			patch["logoUrl"] = *body.Branding.LogoURL
		}
		if body.Branding.WordmarkURL != nil {
			patch["wordmarkUrl"] = *body.Branding.WordmarkURL
		}
		if body.Branding.Mood != nil {
			patch["mood"] = *body.Branding.Mood
		}
		if body.Branding.Tagline != nil {
			patch["tagline"] = *body.Branding.Tagline
		}
		if body.Branding.AccentEmoji != nil {
			patch["accentEmoji"] = *body.Branding.AccentEmoji
		}
		if body.Branding.Typography != nil {
			patch["typography"] = *body.Branding.Typography
		}
		brandingJSON, _ = json.Marshal(patch)
	}

	var preferencesJSON []byte
	if body.Preferences != nil {
		patch := map[string]any{}
		if body.Preferences.AutoServeOnReady != nil {
			patch["autoServeOnReady"] = *body.Preferences.AutoServeOnReady
		}
		if body.Preferences.AutoCleanTables != nil {
			patch["autoCleanTables"] = *body.Preferences.AutoCleanTables
		}
		if body.Preferences.CombinedSettle != nil {
			patch["combinedSettle"] = *body.Preferences.CombinedSettle
		}
		if body.Preferences.StackItems != nil {
			patch["stackItems"] = *body.Preferences.StackItems
		}
		if body.Preferences.DiscountAutoApply != nil {
			patch["discountAutoApply"] = *body.Preferences.DiscountAutoApply
		}
		if body.Preferences.AutoRecordPayment != nil {
			patch["autoRecordPayment"] = *body.Preferences.AutoRecordPayment
		}
		if body.Preferences.RequireTxnRef != nil {
			patch["requireTxnRef"] = *body.Preferences.RequireTxnRef
		}
		if body.Preferences.DefaultDiscount != nil {
			dd := map[string]any{}
			if body.Preferences.DefaultDiscount.Mode != nil {
				dd["mode"] = *body.Preferences.DefaultDiscount.Mode
			}
			if body.Preferences.DefaultDiscount.Reason != nil {
				dd["reason"] = *body.Preferences.DefaultDiscount.Reason
			}
			patch["defaultDiscount"] = dd
		}
		if body.Preferences.OpeningHours != nil {
			for k, v := range body.Preferences.OpeningHours {
				if k < "0" || k > "6" || len(k) != 1 {
					writeErr(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("openingHours: invalid day key %q", k))
					return
				}
				if !hhmmRe.MatchString(v.Start) || !hhmmRe.MatchString(v.End) {
					writeErr(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("openingHours: day %s times must be HH:MM", k))
					return
				}
				if v.Start >= v.End {
					writeErr(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("openingHours: day %s start must be before end", k))
					return
				}
			}
			patch["openingHours"] = body.Preferences.OpeningHours
		}
		if body.Preferences.ComfortCoverage != nil {
			if *body.Preferences.ComfortCoverage < 0 {
				writeErr(w, http.StatusBadRequest, "bad_request", "comfortCoverage must be ≥ 0")
				return
			}
			patch["comfortCoverage"] = *body.Preferences.ComfortCoverage
		}
		if body.Preferences.PrintingEnabled != nil {
			patch["printingEnabled"] = *body.Preferences.PrintingEnabled
		}
		if body.Preferences.PrintKitchenTicket != nil {
			patch["printKitchenTicket"] = *body.Preferences.PrintKitchenTicket
		}
		if body.Preferences.PrintCustomerReceipt != nil {
			patch["printCustomerReceipt"] = *body.Preferences.PrintCustomerReceipt
		}
		if body.Preferences.ReceiptWidth != nil {
			if *body.Preferences.ReceiptWidth != "58" && *body.Preferences.ReceiptWidth != "80" {
				writeErr(w, http.StatusBadRequest, "bad_request", "receiptWidth must be \"58\" or \"80\"")
				return
			}
			patch["receiptWidth"] = *body.Preferences.ReceiptWidth
		}
		if body.Preferences.ReceiptHeader != nil {
			if len(*body.Preferences.ReceiptHeader) > 500 {
				writeErr(w, http.StatusBadRequest, "bad_request", "receiptHeader must be ≤ 500 characters")
				return
			}
			patch["receiptHeader"] = *body.Preferences.ReceiptHeader
		}
		if body.Preferences.ReceiptFooter != nil {
			if len(*body.Preferences.ReceiptFooter) > 500 {
				writeErr(w, http.StatusBadRequest, "bad_request", "receiptFooter must be ≤ 500 characters")
				return
			}
			patch["receiptFooter"] = *body.Preferences.ReceiptFooter
		}
		preferencesJSON, _ = json.Marshal(patch)
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE tenants
		SET name               = COALESCE($2, name),
		    timezone           = COALESCE($3, timezone),
		    vat_pct            = COALESCE($4::numeric, vat_pct),
		    service_charge_pct = COALESCE($5::numeric, service_charge_pct),
		    vat_mode           = COALESCE($8, vat_mode),
		    branding           = CASE
		      WHEN $6::jsonb IS NULL THEN branding
		      ELSE branding || $6::jsonb
		    END,
		    preferences        = CASE
		      WHEN $7::jsonb IS NULL THEN preferences
		      ELSE preferences || $7::jsonb
		    END
		WHERE id = $1
	`, t.ID, body.Name, body.Timezone, body.VatPct, body.ServiceChargePct,
		nullJSON(brandingJSON), nullJSON(preferencesJSON), body.VatMode); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	auditEvent(r.Context(), "tenant.updated", "tenant", t.ID.String(),
		map[string]any{"fields": fieldNames(body)})
	fields := fieldNames(body)
	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "update", Entity: "tenant", EntityID: &t.ID,
		Summary: fmt.Sprintf("updated workspace settings (%s)", strings.Join(fields, ", ")),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	GetTenant(w, r)
}

// =========================================================================
// POST /v1/tenant/logo — multipart "file" form field
// =========================================================================

const maxLogoBytes = 2 * 1024 * 1024 // 2MB

var allowedLogoTypes = map[string]string{
	"image/png":     ".png",
	"image/jpeg":    ".jpg",
	"image/svg+xml": ".svg",
	"image/webp":    ".webp",
}

func UploadLogo(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())

		if err := r.ParseMultipartForm(maxLogoBytes + 1024); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "multipart parse: "+err.Error())
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "file field missing")
			return
		}
		defer file.Close()

		if header.Size > maxLogoBytes {
			writeErr(w, http.StatusRequestEntityTooLarge, "too_large",
				"logo must be ≤ 2 MB")
			return
		}

		head := make([]byte, 512)
		n, _ := io.ReadFull(file, head)
		contentType := http.DetectContentType(head[:n])
		// SVG sniffs as text/xml; trust the form Content-Type for that case.
		formType := header.Header.Get("Content-Type")
		if strings.HasPrefix(formType, "image/svg") {
			contentType = "image/svg+xml"
		}
		ext, ok := allowedLogoTypes[contentType]
		if !ok {
			writeErr(w, http.StatusUnsupportedMediaType, "bad_type",
				"only PNG, JPEG, SVG, or WEBP allowed")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "tenant.upload_logo",
			"content_type", contentType, "size", header.Size)

		rnd := make([]byte, 6)
		_, _ = rand.Read(rnd)
		key := t.Slug + "/logo-" + hex.EncodeToString(rnd) + ext

		// Re-attach the bytes consumed for sniffing so the store sees the full payload.
		body := io.MultiReader(bytes.NewReader(head[:n]), file)

		url, err := store.Put(r.Context(), key, body, storage.PutOpts{
			ContentType:  contentType,
			CacheControl: "public, max-age=31536000, immutable",
			Public:       true, // branding asset, fetched directly by browsers
		})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		// Persist on the branding jsonb.
		tx := appctx.Tx(r.Context())
		if _, err := tx.Exec(r.Context(), `
			UPDATE tenants
			SET branding = branding || jsonb_build_object('logoUrl', $2::text)
			WHERE id = $1
		`, t.ID, url); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		auditEvent(r.Context(), "tenant.logo_uploaded", "tenant", t.ID.String(),
			map[string]any{"url": url})
		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "tenant", EntityID: &t.ID,
			Summary: fmt.Sprintf("uploaded a new logo (%s, %d bytes)", contentType, header.Size),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{"logo_url": url})
	}
}

// =========================================================================
// POST /v1/menu/images — multipart "file" form field
//
// Generic image upload for the menu catalog (category banners + item photos).
// Returns the stored object URL; the caller then persists it onto the
// category/item via the normal create/update endpoints. Decoupled from any
// row so it works in the "new item" flow too (no id exists yet).
// =========================================================================

const maxMenuImageBytes = 5 * 1024 * 1024 // 5MB — room for a real photo

func UploadMenuImage(store storage.Storage) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := appctx.TenantFromContext(r.Context())
		if !ok {
			writeErr(w, http.StatusBadRequest, "tenant_required", "")
			return
		}

		if err := r.ParseMultipartForm(maxMenuImageBytes + 1024); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "multipart parse: "+err.Error())
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "file field missing")
			return
		}
		defer file.Close()

		if header.Size > maxMenuImageBytes {
			writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "image must be ≤ 5 MB")
			return
		}

		head := make([]byte, 512)
		n, _ := io.ReadFull(file, head)
		contentType := http.DetectContentType(head[:n])
		formType := header.Header.Get("Content-Type")
		if strings.HasPrefix(formType, "image/svg") {
			contentType = "image/svg+xml"
		}
		ext, ok := allowedLogoTypes[contentType]
		if !ok {
			writeErr(w, http.StatusUnsupportedMediaType, "bad_type",
				"only PNG, JPEG, SVG, or WEBP allowed")
			return
		}

		log := appctx.Logger(r.Context())
		log.DebugContext(r.Context(), "menu.upload_image",
			"content_type", contentType, "size", header.Size)

		rnd := make([]byte, 8)
		_, _ = rand.Read(rnd)
		key := t.Slug + "/menu/" + hex.EncodeToString(rnd) + ext

		body := io.MultiReader(bytes.NewReader(head[:n]), file)
		url, err := store.Put(r.Context(), key, body, storage.PutOpts{
			ContentType:  contentType,
			CacheControl: "public, max-age=31536000, immutable",
			Public:       true, // shown on the public QR menu
		})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{"url": url})
	}
}

// =========================================================================
// helpers
// =========================================================================

func nullJSON(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}

func fieldNames(b any) []string {
	out := []string{}
	v, err := json.Marshal(b)
	if err != nil {
		return out
	}
	var m map[string]any
	if err := json.Unmarshal(v, &m); err != nil {
		return out
	}
	for k, val := range m {
		if val != nil {
			out = append(out, k)
		}
	}
	return out
}

// silence unused-import warning when bcrypt isn't used here directly
var _ = errors.Is
var _ = pgx.ErrNoRows
