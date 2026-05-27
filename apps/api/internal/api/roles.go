package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/audit"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// =========================================================================
// /v1/permissions — dump the manifest so the FE can render the editor
// =========================================================================

type permissionsResponse struct {
	Version     int                `json:"version"`
	Resources   []rbac.Resource    `json:"resources"`
	Permissions []rbac.Permission  `json:"permissions"`
	SystemRoles []rbac.SystemRole  `json:"system_roles"`
}

// ListPermissionManifest returns the full RBAC manifest so the team-admin
// UI can render the permission editor without re-deriving anything.
func ListPermissionManifest(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, permissionsResponse{
		Version:     rbac.M.Version,
		Resources:   rbac.M.Resources,
		Permissions: rbac.M.Permissions,
		SystemRoles: rbac.M.SystemRoles,
	})
}

// =========================================================================
// /v1/roles — CRUD on tenant-scoped roles
// =========================================================================

type roleWire struct {
	ID          uuid.UUID `json:"id"`
	Key         string    `json:"key"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	IsSystem    bool      `json:"is_system"`
	Locked      bool      `json:"locked"`
	Permissions []string  `json:"permissions"`
	MemberCount int       `json:"member_count"`
}

func roleToWire(r rbac.Role) roleWire {
	return roleWire{
		ID:          r.ID,
		Key:         r.Key,
		Name:        r.Name,
		Description: r.Description,
		IsSystem:    r.IsSystem,
		Locked:      r.IsSystem && r.Key == "owner",
		Permissions: r.Permissions,
		MemberCount: r.MemberCount,
	}
}

// ListRoles — GET /v1/roles
func ListRoles(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		tx := appctx.Tx(r.Context())
		roles, err := repo.List(r.Context(), tx, t.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out := make([]roleWire, 0, len(roles))
		for _, role := range roles {
			out = append(out, roleToWire(role))
		}
		writeJSON(w, http.StatusOK, map[string]any{"roles": out})
	}
}

// GetRole — GET /v1/roles/{id}
func GetRole(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid role id")
			return
		}
		tx := appctx.Tx(r.Context())
		role, err := repo.Get(r.Context(), tx, t.ID, id)
		if errors.Is(err, rbac.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "role not found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, roleToWire(role))
	}
}

type roleCreateBody struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

// CreateRole — POST /v1/roles
func CreateRole(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		var body roleCreateBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		body.Key = strings.TrimSpace(strings.ToLower(body.Key))
		body.Name = strings.TrimSpace(body.Name)
		body.Description = strings.TrimSpace(body.Description)
		if body.Key == "" || body.Name == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "key and name required")
			return
		}
		// Block re-using a system-role key.
		for _, sr := range rbac.M.SystemRoles {
			if body.Key == sr.Key {
				writeErr(w, http.StatusConflict, "key_reserved", "this role key is reserved for the system role")
				return
			}
		}
		tx := appctx.Tx(r.Context())
		role, err := repo.Create(r.Context(), tx, t.ID, body.Key, body.Name, body.Description, body.Permissions)
		if err != nil {
			if strings.Contains(err.Error(), "duplicate key") {
				writeErr(w, http.StatusConflict, "key_taken", "a role with this key already exists")
				return
			}
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		_ = audit.Log(r.Context(), tx, audit.Entry{
			Action: "create", Entity: "role", EntityID: &role.ID,
			Summary: "created role " + role.Name,
		})
		writeJSON(w, http.StatusCreated, roleToWire(role))
	}
}

type roleUpdateBody struct {
	Name        *string   `json:"name"`
	Description *string   `json:"description"`
	Permissions *[]string `json:"permissions"`
}

// UpdateRole — PATCH /v1/roles/{id}
// The system 'owner' row is immutable. The DB trigger is the ultimate
// guard; this handler also rejects the request early so the error is a
// clean 403 rather than a 500 from a trigger exception.
func UpdateRole(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid role id")
			return
		}
		var body roleUpdateBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if body.Name != nil {
			trimmed := strings.TrimSpace(*body.Name)
			if trimmed == "" {
				writeErr(w, http.StatusBadRequest, "bad_request", "name cannot be empty")
				return
			}
			body.Name = &trimmed
		}
		tx := appctx.Tx(r.Context())
		role, err := repo.Update(r.Context(), tx, t.ID, id, body.Name, body.Description, body.Permissions)
		if errors.Is(err, rbac.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "role not found")
			return
		}
		if errors.Is(err, rbac.ErrOwnerImmutable) {
			writeErr(w, http.StatusForbidden, "owner_immutable", "the owner role cannot be modified")
			return
		}
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		_ = audit.Log(r.Context(), tx, audit.Entry{
			Action: "update", Entity: "role", EntityID: &role.ID,
			Summary: "updated role " + role.Name,
		})
		writeJSON(w, http.StatusOK, roleToWire(role))
	}
}

// DeleteRole — DELETE /v1/roles/{id}
func DeleteRole(repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, _ := appctx.TenantFromContext(r.Context())
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid role id")
			return
		}
		tx := appctx.Tx(r.Context())
		role, err := repo.Get(r.Context(), tx, t.ID, id)
		if errors.Is(err, rbac.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "role not found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if err := repo.Delete(r.Context(), tx, t.ID, id); err != nil {
			switch {
			case errors.Is(err, rbac.ErrOwnerImmutable):
				writeErr(w, http.StatusForbidden, "owner_immutable", "the owner role cannot be deleted")
			case errors.Is(err, rbac.ErrRoleHasMembers):
				writeErr(w, http.StatusConflict, "role_in_use", "remove this role from all members before deleting it")
			default:
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			}
			return
		}
		_ = audit.Log(r.Context(), tx, audit.Entry{
			Action: "delete", Entity: "role", EntityID: &id,
			Summary: "deleted role " + role.Name,
		})
		w.WriteHeader(http.StatusNoContent)
	}
}
