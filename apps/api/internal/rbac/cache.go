package rbac

import (
	"sync"

	"github.com/google/uuid"
)

// Cache stores per-member permission sets keyed by
// (tenant_id, user_id, roles_version). roles_version is bumped by DB
// triggers on every RBAC mutation, so a stale entry whose version no
// longer matches the freshly-read tenants.roles_version is simply
// ignored — there is no separate eviction step.
//
// The cache is intentionally simple: bounded by a soft cap that is
// enforced lazily on insert. Workloads here are O(active sessions per
// tenant) which is small.
type Cache struct {
	mu  sync.RWMutex
	cap int
	m   map[cacheKey]PermissionSet
}

type cacheKey struct {
	tenant  uuid.UUID
	user    uuid.UUID
	version int64
}

// NewCache returns a Cache with capacity cap. A cap of 0 disables eviction.
func NewCache(cap int) *Cache {
	return &Cache{cap: cap, m: make(map[cacheKey]PermissionSet, 64)}
}

// Get looks up a member's permission set under the supplied version.
// Returns ok=false on miss.
func (c *Cache) Get(tenantID, userID uuid.UUID, version int64) (PermissionSet, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	ps, ok := c.m[cacheKey{tenantID, userID, version}]
	return ps, ok
}

// Put stores ps under (tenantID, userID, ps.Version). Older versions for
// the same (tenant, user) are removed so the map doesn't grow without
// bound under steady mutation. When cap is set and the map exceeds it, a
// best-effort random-eviction trim runs to bring it back under.
func (c *Cache) Put(tenantID, userID uuid.UUID, ps PermissionSet) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.m {
		if k.tenant == tenantID && k.user == userID && k.version != ps.Version {
			delete(c.m, k)
		}
	}
	c.m[cacheKey{tenantID, userID, ps.Version}] = ps
	if c.cap > 0 && len(c.m) > c.cap {
		over := len(c.m) - c.cap
		for k := range c.m {
			if over <= 0 {
				break
			}
			delete(c.m, k)
			over--
		}
	}
}

// InvalidateTenant drops every cached entry for the given tenant.
// Useful when a tenant is closed or when admin tooling forces a refresh.
func (c *Cache) InvalidateTenant(tenantID uuid.UUID) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.m {
		if k.tenant == tenantID {
			delete(c.m, k)
		}
	}
}

// Size returns the current entry count. Test helper.
func (c *Cache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.m)
}
