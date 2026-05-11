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
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

// =========================================================================
// Wire types
// =========================================================================

type Tenant struct {
	ID                uuid.UUID `json:"id"`
	Slug              string    `json:"slug"`
	Name              string    `json:"name"`
	Branding          any       `json:"branding"`
	Plan              string    `json:"plan"`
	Status            string    `json:"status"`
	Timezone          string    `json:"timezone"`
	VatPct            string    `json:"vat_pct"`
	ServiceChargePct  string    `json:"service_charge_pct"`
	CreatedAt         time.Time `json:"created_at"`
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
	var branding []byte
	if err := tx.QueryRow(r.Context(), `
		SELECT id, slug, name, branding, plan, status, timezone,
		       vat_pct::text, service_charge_pct::text, created_at
		FROM tenants WHERE id = $1
	`, t.ID).Scan(&out.ID, &out.Slug, &out.Name, &branding, &out.Plan, &out.Status,
		&out.Timezone, &out.VatPct, &out.ServiceChargePct, &out.CreatedAt); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	_ = json.Unmarshal(branding, &out.Branding)
	writeJSON(w, http.StatusOK, out)
}

// =========================================================================
// PATCH /v1/tenant — owner-only
// =========================================================================

func UpdateTenant(w http.ResponseWriter, r *http.Request) {
	if !auth.HasRole(r, "owner") {
		writeErr(w, http.StatusForbidden, "owner_only", "only owners can edit tenant settings")
		return
	}
	t, _ := appctx.TenantFromContext(r.Context())

	var body struct {
		Name             *string `json:"name"`
		Timezone         *string `json:"timezone"`
		VatPct           *string `json:"vat_pct"`
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
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
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

	if _, err := tx.Exec(r.Context(), `
		UPDATE tenants
		SET name               = COALESCE($2, name),
		    timezone           = COALESCE($3, timezone),
		    vat_pct            = COALESCE($4::numeric, vat_pct),
		    service_charge_pct = COALESCE($5::numeric, service_charge_pct),
		    branding           = CASE
		      WHEN $6::jsonb IS NULL THEN branding
		      ELSE branding || $6::jsonb
		    END
		WHERE id = $1
	`, t.ID, body.Name, body.Timezone, body.VatPct, body.ServiceChargePct,
		nullJSON(brandingJSON)); err != nil {
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
		if !auth.HasRole(r, "owner") {
			writeErr(w, http.StatusForbidden, "owner_only", "only owners can upload a logo")
			return
		}
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
