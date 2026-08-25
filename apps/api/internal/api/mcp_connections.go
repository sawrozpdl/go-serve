package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/mcp"
)

// =========================================================================
// /v1/mcp/connections — the owner's side of the AI connector.
//
// Creating one hands a third-party service standing read access to this café's
// data, so the UX obligations are unusually heavy for a CRUD endpoint:
//
//   * the secret is shown ONCE, on creation, and is unrecoverable afterwards
//   * the URL is returned whole, because "paste this" is the entire setup step
//   * finance is never granted implicitly
//   * revoking is one call and takes effect on the next request
//   * last_used_at is listed, so a forgotten connector is visible
// =========================================================================

// connectionTTL is how long a new connection lasts unless renewed.
//
// Bounded rather than forever: a connector nobody remembers is a credential
// nobody is watching. A year is long enough not to be an annoyance and short
// enough that an abandoned one lapses on its own.
const connectionTTL = 365 * 24 * time.Hour

// maxConnectionsPerTenant keeps the list legible and bounds the blast radius of
// a compromised login.
const maxConnectionsPerTenant = 10

type mcpConnectionDTO struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`
	Scopes []string `json:"scopes"`
	// Actor is whose permissions the connector borrows. Shown because it is the
	// real answer to "what can this thing see" — the scopes only narrow it.
	Actor      string  `json:"actor"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
	ExpiresAt  *string `json:"expires_at"`
}

// ListMCPConnections — GET /v1/mcp/connections.
func ListMCPConnections(w http.ResponseWriter, r *http.Request) {
	tx := appctx.Tx(r.Context())
	rows, err := tx.Query(r.Context(), `
		SELECT c.id, c.label, c.scopes, COALESCE(u.email::text, u.name, 'unknown'),
		       c.created_at, c.last_used_at, c.expires_at
		FROM mcp_connections c
		LEFT JOIN users u ON u.id = c.user_id
		WHERE c.revoked_at IS NULL
		ORDER BY c.created_at DESC
	`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	defer rows.Close()

	out := []mcpConnectionDTO{}
	for rows.Next() {
		var (
			d                 mcpConnectionDTO
			created           time.Time
			lastUsed, expires *time.Time
		)
		if err := rows.Scan(&d.ID, &d.Label, &d.Scopes, &d.Actor,
			&created, &lastUsed, &expires); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		d.CreatedAt = created.Format(time.RFC3339)
		d.LastUsedAt = rfc3339OrNil(lastUsed)
		d.ExpiresAt = rfc3339OrNil(expires)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": out})
}

func rfc3339OrNil(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(time.RFC3339)
	return &s
}

// allowedScopes is the set a caller may ask for, and the reason each is separate.
var allowedScopes = map[string]bool{
	mcp.ScopeReadSales:     true,
	mcp.ScopeReadInventory: true,
	// read_finance is grantable but never implied: it sends the café's cash
	// position to a third-party model provider.
	mcp.ScopeReadFinance:   true,
	mcp.ScopeWriteFollowUp: true,
}

// CreateMCPConnection — POST /v1/mcp/connections.
//
// Returns the secret and the full URL exactly once.
func CreateMCPConnection(baseURL string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Label  string   `json:"label"`
			Scopes []string `json:"scopes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		label := strings.TrimSpace(body.Label)
		if label == "" {
			writeErr(w, http.StatusBadRequest, "label_required",
				"give the connection a name, so you can tell three of them apart later")
			return
		}
		if len(label) > 60 {
			label = label[:60]
		}

		// read_sales is always included: a connector that can read nothing is
		// not a connector, and leaving it implicit is how somebody creates a
		// silently useless one.
		scopes := []string{mcp.ScopeReadSales}
		for _, s := range body.Scopes {
			if !allowedScopes[s] {
				writeErr(w, http.StatusBadRequest, "bad_scope", "unknown permission: "+s)
				return
			}
			if s != mcp.ScopeReadSales {
				scopes = append(scopes, s)
			}
		}

		tx := appctx.Tx(r.Context())
		u, _ := appctx.UserFromContext(r.Context())

		var live int
		if err := tx.QueryRow(r.Context(),
			`SELECT count(*) FROM mcp_connections WHERE revoked_at IS NULL`).Scan(&live); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if live >= maxConnectionsPerTenant {
			writeErr(w, http.StatusConflict, "too_many_connections",
				fmt.Sprintf("this café already has %d connections; revoke one first", live))
			return
		}

		// 256 bits from crypto/rand. This value is the credential — it is
		// returned once and only its hash is kept.
		buf := make([]byte, mcp.TokenBytes)
		if _, err := rand.Read(buf); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		secret := hex.EncodeToString(buf)

		var id uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO mcp_connections
			  (tenant_id, label, token_hash, user_id, scopes, expires_at, created_by_user_id)
			VALUES (current_tenant_id(), $1, $2, $3, $4, now() + $5::interval, $3)
			RETURNING id
		`, label, mcp.HashToken(secret), u.ID, scopes,
			fmt.Sprintf("%d hours", int(connectionTTL.Hours()))).Scan(&id); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		if err := audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "mcp_connection", EntityID: &id,
			// The scopes go in the summary because "granted an AI assistant
			// access to the finances" is the part worth finding later.
			Summary: fmt.Sprintf("created AI connector %q with %s", label, strings.Join(scopes, ", ")),
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{
			"id":     id,
			"label":  label,
			"scopes": scopes,
			// Shown once. There is no endpoint that returns it again.
			"url": connectorBase(baseURL, r) + "/mcp/c/" + secret,
			"note": "Copy this URL now — it is not shown again. Add it to your AI assistant " +
				"as a connector with no authentication. Anyone with this URL can read what " +
				"you granted, so treat it like a password.",
		})
	}
}

// RevokeMCPConnection — DELETE /v1/mcp/connections/{id}.
//
// Revokes rather than deletes: "who connected what, and when" is worth keeping,
// and the row is what an audit of a leaked URL would start from.
func RevokeMCPConnection(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid connection id")
		return
	}
	tx := appctx.Tx(r.Context())

	var label string
	err = tx.QueryRow(r.Context(), `
		UPDATE mcp_connections SET revoked_at = now()
		WHERE id = $1 AND revoked_at IS NULL
		RETURNING label`, id).Scan(&label)
	if errors.Is(err, pgx.ErrNoRows) {
		// Already revoked, another café's, or never existed — all "not found"
		// from here.
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if err := audit.Log(r.Context(), tx, audit.Entry{
		Action: "delete", Entity: "mcp_connection", EntityID: &id,
		Summary: fmt.Sprintf("revoked AI connector %q", label),
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// connectorBase resolves the absolute base for the URL the owner pastes into
// their assistant.
//
// PUBLIC_API_URL is the right answer and should be set in prod. But the whole
// value of this endpoint is "copy this and paste it in", and a RELATIVE url is
// not merely imperfect — it is unusable, and unusable in a way the owner cannot
// diagnose. So an unset config falls back to the request's own scheme and host,
// which behind Cloudflare is exactly right anyway.
//
// X-Forwarded-Proto is honoured because the origin is reached over plain HTTP
// (infra/aws/README.md: TLS terminates at the Cloudflare edge), so r.TLS is nil
// on a request the user made over https.
func connectorBase(configured string, r *http.Request) string {
	if configured != "" {
		return strings.TrimRight(configured, "/")
	}
	scheme := "http"
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	} else if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
