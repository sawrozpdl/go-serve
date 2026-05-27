// Package rbac is the runtime side of the role-based access control
// system. The permission catalogue is hardcoded — it lives in the shared
// JSON manifest at packages/rbac/permissions.json which both Go and
// TypeScript consume. Roles + grants live in the DB; the manifest only
// defines the permission keys that grants can reference and the seed
// content for system roles.
//
// Wildcards are stored literally in role_permissions ("menu:*", "*:*").
// Match() does the expansion at check time.
package rbac

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// The single source of truth for the manifest lives at
// `packages/rbac/permissions.json` so the TypeScript side can import it
// natively. Go's //go:embed cannot reach outside its package directory,
// so we keep a copy here that is refreshed by `go generate`. A CI test
// (TestManifestInSyncWithPackage) asserts byte-equality of the two files.
//
//go:generate cp ../../../../packages/rbac/permissions.json ./permissions.json
//go:embed permissions.json
var manifestBytes []byte

// Manifest is the parsed shared permission catalogue.
type Manifest struct {
	Version     int          `json:"version"`
	Resources   []Resource   `json:"resources"`
	Permissions []Permission `json:"permissions"`
	SystemRoles []SystemRole `json:"system_roles"`

	// Derived: permission key set, for O(1) IsKnown lookups.
	keys map[string]struct{}
}

type Resource struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type Permission struct {
	Key         string `json:"key"`
	Resource    string `json:"resource"`
	Action      string `json:"action"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type SystemRole struct {
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Locked      bool     `json:"locked"`
	Permissions []string `json:"permissions"`
}

// M is the parsed, validated, process-global manifest.
var M = mustLoad()

func mustLoad() *Manifest {
	var m Manifest
	if err := json.Unmarshal(manifestBytes, &m); err != nil {
		panic(fmt.Sprintf("rbac: malformed permissions.json: %v", err))
	}
	m.keys = make(map[string]struct{}, len(m.Permissions))
	for _, p := range m.Permissions {
		m.keys[p.Key] = struct{}{}
	}
	if err := m.validate(); err != nil {
		panic(fmt.Sprintf("rbac: invalid permissions.json: %v", err))
	}
	return &m
}

var (
	permRE = regexp.MustCompile(`^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$`)
	grantRE = regexp.MustCompile(`^(?:\*|[a-z][a-z0-9_]*):(?:\*|[a-z][a-z0-9_]*)$`)
)

func (m *Manifest) validate() error {
	resources := make(map[string]struct{}, len(m.Resources))
	for _, r := range m.Resources {
		if r.Key == "" {
			return fmt.Errorf("resource missing key")
		}
		resources[r.Key] = struct{}{}
	}
	seen := make(map[string]struct{}, len(m.Permissions))
	for _, p := range m.Permissions {
		if !permRE.MatchString(p.Key) {
			return fmt.Errorf("permission %q: bad shape (want resource:action, lowercase snake_case)", p.Key)
		}
		if _, ok := seen[p.Key]; ok {
			return fmt.Errorf("permission %q: duplicate", p.Key)
		}
		seen[p.Key] = struct{}{}
		if _, ok := resources[p.Resource]; !ok {
			return fmt.Errorf("permission %q: unknown resource %q", p.Key, p.Resource)
		}
		want := p.Resource + ":" + p.Action
		if want != p.Key {
			return fmt.Errorf("permission %q: key does not equal %q", p.Key, want)
		}
	}
	if len(m.SystemRoles) == 0 {
		return fmt.Errorf("no system_roles defined")
	}
	haveOwner := false
	for _, sr := range m.SystemRoles {
		if sr.Key == "owner" {
			haveOwner = true
			if !sr.Locked {
				return fmt.Errorf("owner system role must be locked")
			}
			if len(sr.Permissions) != 1 || sr.Permissions[0] != "*:*" {
				return fmt.Errorf("owner system role must hold exactly [*:*]")
			}
		}
		for _, g := range sr.Permissions {
			if err := m.ValidateGrant(g); err != nil {
				return fmt.Errorf("system_role %q: %w", sr.Key, err)
			}
		}
	}
	if !haveOwner {
		return fmt.Errorf("no owner system role")
	}
	return nil
}

// IsKnown reports whether key is an exact permission listed in the manifest.
// Wildcards are not "known" by this check — use ValidateGrant for grants.
func (m *Manifest) IsKnown(key string) bool {
	_, ok := m.keys[key]
	return ok
}

// Keys returns every permission key in manifest order. Useful for diffs
// and the AST-lint test.
func (m *Manifest) Keys() []string {
	out := make([]string, 0, len(m.Permissions))
	for _, p := range m.Permissions {
		out = append(out, p.Key)
	}
	return out
}

// ResourceKeys returns the resource keys in manifest order.
func (m *Manifest) ResourceKeys() []string {
	out := make([]string, 0, len(m.Resources))
	for _, r := range m.Resources {
		out = append(out, r.Key)
	}
	return out
}

// ValidateGrant accepts an exact permission key ("menu:create"), a
// resource wildcard ("menu:*"), or the global wildcard ("*:*"). Returns
// nil if grant is well-formed and references known resources.
func (m *Manifest) ValidateGrant(grant string) error {
	if grant == "*:*" {
		return nil
	}
	if !grantRE.MatchString(grant) {
		return fmt.Errorf("grant %q: malformed", grant)
	}
	colon := strings.IndexByte(grant, ':')
	resource := grant[:colon]
	action := grant[colon+1:]
	knownResource := false
	for _, r := range m.Resources {
		if r.Key == resource {
			knownResource = true
			break
		}
	}
	if !knownResource {
		return fmt.Errorf("grant %q: unknown resource %q", grant, resource)
	}
	if action == "*" {
		return nil
	}
	if !m.IsKnown(grant) {
		return fmt.Errorf("grant %q: unknown permission", grant)
	}
	return nil
}

// PermissionSet is the set of grants held by a member, plus the
// roles_version it was loaded under (for cache invalidation).
type PermissionSet struct {
	Version int64
	Set     map[string]struct{}
	Roles   []string // role keys, ordered by role.key — informational only
}

// Has reports whether want is granted by this set. Pure allow-list:
//   - exact match
//   - "{resource}:*" present
//   - "*:*" present
//
// Any one is sufficient. No precedence, no deny.
func (ps PermissionSet) Has(want string) bool {
	if ps.Set == nil {
		return false
	}
	if _, ok := ps.Set["*:*"]; ok {
		return true
	}
	if _, ok := ps.Set[want]; ok {
		return true
	}
	if colon := strings.IndexByte(want, ':'); colon > 0 {
		if _, ok := ps.Set[want[:colon]+":*"]; ok {
			return true
		}
	}
	return false
}

// HasAny reports whether at least one of wants is granted.
func (ps PermissionSet) HasAny(wants ...string) bool {
	for _, w := range wants {
		if ps.Has(w) {
			return true
		}
	}
	return false
}
