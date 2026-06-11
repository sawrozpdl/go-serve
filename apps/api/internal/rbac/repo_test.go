package rbac

// Integration + unit tests for repo.go, cache.go, and the untested parts of
// manifest.go.
//
// Strategy: two pools mirror production:
//
//   - adminPool (superuser, DATABASE_URL) — bypasses RLS, used to seed tenants,
//     users, and tenant_members so triggers and foreign-key constraints are
//     satisfied without RLS getting in the way.
//   - appPool (app_user, APP_DATABASE_URL, NOBYPASSRLS) — every Repo call runs
//     inside an app-pool transaction with app.tenant_id / app.user_id set, which
//     is exactly how the live API exercises the code. Missing GRANTs therefore
//     surface here rather than silently passing (see memory: db_grants_gotcha).
//
// Skip behaviour: when no database is reachable (CI without a postgres service,
// or a dev machine without .env set up), every DB-backed test calls requireDB
// and skips — `go test ./internal/rbac/` stays green with just the unit tests.

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// =========================================================================
// Test-main: DB pool setup
// =========================================================================

var (
	adminPool *pgxpool.Pool
	appPool   *pgxpool.Pool
	dbSkip    string
)

func TestMain(m *testing.M) {
	loadDotEnv()

	adminURL := firstNonEmpty(os.Getenv("DATABASE_URL"), os.Getenv("APP_DATABASE_URL"))
	appURL := firstNonEmpty(os.Getenv("APP_DATABASE_URL"), os.Getenv("DATABASE_URL"))
	if adminURL == "" {
		dbSkip = "DATABASE_URL / APP_DATABASE_URL not set; skipping DB integration tests"
		os.Exit(m.Run())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	adminPool, err = pgxpool.New(ctx, adminURL)
	if err == nil {
		err = adminPool.Ping(ctx)
	}
	if err != nil {
		dbSkip = fmt.Sprintf("cannot connect to admin DB (%v); skipping DB integration tests", err)
		os.Exit(m.Run())
	}

	appPool, err = pgxpool.New(ctx, appURL)
	if err == nil {
		err = appPool.Ping(ctx)
	}
	if err != nil {
		dbSkip = fmt.Sprintf("cannot connect to app DB (%v); skipping DB integration tests", err)
		os.Exit(m.Run())
	}

	code := m.Run()
	adminPool.Close()
	appPool.Close()
	os.Exit(code)
}

func requireDB(t *testing.T) {
	t.Helper()
	if dbSkip != "" {
		t.Skip(dbSkip)
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// loadDotEnv loads KEY=VALUE pairs from the api-root .env without overriding
// already-set env vars. Best-effort: missing file is silently ignored.
func loadDotEnv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	var envPath string
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			envPath = filepath.Join(dir, ".env")
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if envPath == "" {
		return
	}
	f, err := os.Open(envPath)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if key == "" {
			continue
		}
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, val)
		}
	}
}

// =========================================================================
// DB fixture helpers
// =========================================================================

// tenantFixture holds a throwaway tenant + owner user and cleans up on test end.
type tenantFixture struct {
	t        *testing.T
	TenantID uuid.UUID
	UserID   uuid.UUID
}

// newTenantFixture creates a tenant row, a user row, and a tenant_members row
// via the admin pool (RLS bypassed). Cleanup deletes them on test end.
func newTenantFixture(t *testing.T) *tenantFixture {
	t.Helper()
	requireDB(t)
	ctx := context.Background()
	suffix := uuid.NewString()[:8]

	fx := &tenantFixture{t: t}
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
		"rbac-test-"+suffix, "RBAC Test "+suffix,
	).Scan(&fx.TenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"rbac-owner-"+suffix+"@test.local", "Owner "+suffix,
	).Scan(&fx.UserID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := adminPool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
		fx.TenantID, fx.UserID,
	); err != nil {
		t.Fatalf("seed member: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = adminPool.Exec(bg, `DELETE FROM tenants WHERE id = $1`, fx.TenantID)
		_, _ = adminPool.Exec(bg, `DELETE FROM users WHERE id = $1`, fx.UserID)
	})
	return fx
}

// addUser creates an extra user and adds them as an active tenant member.
func (fx *tenantFixture) addUser() uuid.UUID {
	fx.t.Helper()
	ctx := context.Background()
	suffix := uuid.NewString()[:8]
	var id uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
		"rbac-extra-"+suffix+"@test.local", "Extra "+suffix,
	).Scan(&id); err != nil {
		fx.t.Fatalf("addUser insert: %v", err)
	}
	if _, err := adminPool.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
		fx.TenantID, id); err != nil {
		fx.t.Fatalf("addUser member: %v", err)
	}
	fx.t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// adminExec runs a statement via the admin pool (RLS bypassed). Fatal on error.
func (fx *tenantFixture) adminExec(sql string, args ...any) {
	fx.t.Helper()
	if _, err := adminPool.Exec(context.Background(), sql, args...); err != nil {
		fx.t.Fatalf("adminExec %q: %v", sql, err)
	}
}

func (fx *tenantFixture) adminScanInt(sql string, args ...any) int {
	fx.t.Helper()
	var n int
	if err := adminPool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		fx.t.Fatalf("adminScanInt %q: %v", sql, err)
	}
	return n
}

// appTx begins an app-pool transaction and sets app.tenant_id / app.user_id so
// RLS is satisfied. Returns the tx and a commit function. The caller must either
// call commit() or rollback the tx.
func (fx *tenantFixture) appTx() (pgx.Tx, func()) {
	fx.t.Helper()
	ctx := context.Background()
	tx, err := appPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		fx.t.Fatalf("appTx begin: %v", err)
	}
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_id', $1, true)", fx.TenantID.String(),
	); err != nil {
		_ = tx.Rollback(ctx)
		fx.t.Fatalf("appTx set tenant_id: %v", err)
	}
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.user_id', $1, true)", fx.UserID.String(),
	); err != nil {
		_ = tx.Rollback(ctx)
		fx.t.Fatalf("appTx set user_id: %v", err)
	}
	commit := func() {
		if err := tx.Commit(ctx); err != nil {
			fx.t.Fatalf("appTx commit: %v", err)
		}
	}
	return tx, commit
}

// adminTx begins an admin-pool transaction with tenant/user GUCs set so FORCE
// ROW SECURITY triggers pass (SeedSystemRoles needs this via the admin pool).
func (fx *tenantFixture) adminTx() (pgx.Tx, func()) {
	fx.t.Helper()
	ctx := context.Background()
	tx, err := adminPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		fx.t.Fatalf("adminTx begin: %v", err)
	}
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_id', $1, true)", fx.TenantID.String(),
	); err != nil {
		_ = tx.Rollback(ctx)
		fx.t.Fatalf("adminTx set tenant_id: %v", err)
	}
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.user_id', $1, true)", fx.UserID.String(),
	); err != nil {
		_ = tx.Rollback(ctx)
		fx.t.Fatalf("adminTx set user_id: %v", err)
	}
	commit := func() {
		if err := tx.Commit(ctx); err != nil {
			fx.t.Fatalf("adminTx commit: %v", err)
		}
	}
	return tx, commit
}

// seedSystemRoles seeds the four system roles via the admin pool and grants
// the 'owner' role to the fixture's owner user. Returns the key→id map.
func (fx *tenantFixture) seedSystemRoles() map[string]uuid.UUID {
	fx.t.Helper()
	repo := NewRepo(adminPool, NewCache(16))
	tx, commit := fx.adminTx()
	ids, err := repo.SeedSystemRoles(context.Background(), tx, fx.TenantID)
	if err != nil {
		_ = tx.Rollback(context.Background())
		fx.t.Fatalf("seedSystemRoles: %v", err)
	}
	if _, err := tx.Exec(context.Background(),
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
		fx.TenantID, fx.UserID, ids["owner"],
	); err != nil {
		_ = tx.Rollback(context.Background())
		fx.t.Fatalf("seedSystemRoles grant owner: %v", err)
	}
	commit()
	return ids
}

// =========================================================================
// NewRepo / NewCache
// =========================================================================

func TestNewRepo_NilCacheDefaultsToNewCache(t *testing.T) {
	requireDB(t)
	repo := NewRepo(adminPool, nil)
	if repo == nil {
		t.Fatal("NewRepo returned nil")
	}
	if repo.Cache() == nil {
		t.Fatal("NewRepo with nil cache should set a default cache, got nil")
	}
}

func TestNewRepo_ExplicitCache(t *testing.T) {
	requireDB(t)
	c := NewCache(32)
	repo := NewRepo(adminPool, c)
	if repo.Cache() != c {
		t.Fatal("NewRepo should use the supplied cache, got different pointer")
	}
}

func TestNewCache_Zero(t *testing.T) {
	c := NewCache(0)
	if c == nil {
		t.Fatal("NewCache(0) returned nil")
	}
	if c.Size() != 0 {
		t.Fatalf("fresh cache size = %d, want 0", c.Size())
	}
}

// =========================================================================
// Cache — pure unit tests (no DB needed)
// =========================================================================

func TestCache_GetMissOnEmpty(t *testing.T) {
	c := NewCache(64)
	id := uuid.New()
	_, ok := c.Get(id, id, 1)
	if ok {
		t.Fatal("Get on empty cache should miss")
	}
}

func TestCache_PutThenGet_Hit(t *testing.T) {
	c := NewCache(64)
	tid, uid := uuid.New(), uuid.New()
	ps := PermissionSet{Version: 7, Set: map[string]struct{}{"menu:read": {}}}
	c.Put(tid, uid, ps)
	got, ok := c.Get(tid, uid, 7)
	if !ok {
		t.Fatal("expected cache hit after Put, got miss")
	}
	if got.Version != 7 {
		t.Fatalf("version = %d, want 7", got.Version)
	}
	if _, has := got.Set["menu:read"]; !has {
		t.Fatal("cache hit missing expected permission")
	}
}

func TestCache_GetMiss_WrongVersion(t *testing.T) {
	c := NewCache(64)
	tid, uid := uuid.New(), uuid.New()
	ps := PermissionSet{Version: 3, Set: map[string]struct{}{"order:read": {}}}
	c.Put(tid, uid, ps)
	_, ok := c.Get(tid, uid, 99)
	if ok {
		t.Fatal("Get with stale version should miss")
	}
}

func TestCache_PutEvictsOldVersionsForSameMember(t *testing.T) {
	c := NewCache(64)
	tid, uid := uuid.New(), uuid.New()

	ps1 := PermissionSet{Version: 1, Set: map[string]struct{}{"menu:read": {}}}
	c.Put(tid, uid, ps1)
	if c.Size() != 1 {
		t.Fatalf("size after first put = %d, want 1", c.Size())
	}

	ps2 := PermissionSet{Version: 2, Set: map[string]struct{}{"order:read": {}}}
	c.Put(tid, uid, ps2)
	// Old version should be evicted; only v2 remains.
	if c.Size() != 1 {
		t.Fatalf("size after second put = %d, want 1 (old version should be evicted)", c.Size())
	}
	_, oldOK := c.Get(tid, uid, 1)
	if oldOK {
		t.Fatal("version 1 should have been evicted after put of version 2")
	}
	_, newOK := c.Get(tid, uid, 2)
	if !newOK {
		t.Fatal("version 2 should still be present")
	}
}

func TestCache_DifferentMembersCoexist(t *testing.T) {
	c := NewCache(64)
	tid := uuid.New()
	uid1, uid2 := uuid.New(), uuid.New()

	c.Put(tid, uid1, PermissionSet{Version: 1, Set: map[string]struct{}{"a:b": {}}})
	c.Put(tid, uid2, PermissionSet{Version: 1, Set: map[string]struct{}{"x:y": {}}})

	if c.Size() != 2 {
		t.Fatalf("size = %d, want 2", c.Size())
	}
	_, ok1 := c.Get(tid, uid1, 1)
	_, ok2 := c.Get(tid, uid2, 1)
	if !ok1 || !ok2 {
		t.Fatal("both members should be cached independently")
	}
}

func TestCache_InvalidateTenantClearsAll(t *testing.T) {
	c := NewCache(64)
	tid := uuid.New()
	uid1, uid2 := uuid.New(), uuid.New()
	otherTid := uuid.New()

	c.Put(tid, uid1, PermissionSet{Version: 1})
	c.Put(tid, uid2, PermissionSet{Version: 1})
	c.Put(otherTid, uid1, PermissionSet{Version: 1})

	c.InvalidateTenant(tid)

	_, ok1 := c.Get(tid, uid1, 1)
	_, ok2 := c.Get(tid, uid2, 1)
	_, okOther := c.Get(otherTid, uid1, 1)
	if ok1 || ok2 {
		t.Fatal("InvalidateTenant should have evicted all entries for the tenant")
	}
	if !okOther {
		t.Fatal("InvalidateTenant should not affect other tenants")
	}
}

func TestCache_CapEnforcedOnInsert(t *testing.T) {
	cap := 5
	c := NewCache(cap)
	for i := 0; i < cap+10; i++ {
		c.Put(uuid.New(), uuid.New(), PermissionSet{Version: int64(i)})
	}
	// After trim, size must not exceed cap.
	if c.Size() > cap {
		t.Fatalf("cache size %d exceeds cap %d after overflow inserts", c.Size(), cap)
	}
}

func TestCache_ConcurrentPutGet(t *testing.T) {
	c := NewCache(1024)
	var wg sync.WaitGroup
	tid := uuid.New()
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			uid := uuid.New()
			ps := PermissionSet{Version: int64(v), Set: map[string]struct{}{"menu:read": {}}}
			c.Put(tid, uid, ps)
			c.Get(tid, uid, int64(v))
		}(i)
	}
	wg.Wait()
	// No assertion on final state — the race detector is the oracle here.
}

// =========================================================================
// Manifest — untested parts (validate / IsKnown / Keys / ResourceKeys)
// =========================================================================

func TestManifest_IsKnown_ExactKeys(t *testing.T) {
	for _, p := range M.Permissions {
		if !M.IsKnown(p.Key) {
			t.Errorf("IsKnown(%q) = false, want true", p.Key)
		}
	}
}

func TestManifest_IsKnown_WildcardsNotKnown(t *testing.T) {
	wildcards := []string{"*:*", "menu:*", "order:*"}
	for _, w := range wildcards {
		if M.IsKnown(w) {
			t.Errorf("IsKnown(%q) = true, wildcards should not be 'known'", w)
		}
	}
}

func TestManifest_IsKnown_UnknownReturnsFalse(t *testing.T) {
	if M.IsKnown("bogus:action") {
		t.Error("IsKnown(bogus:action) should be false")
	}
	if M.IsKnown("") {
		t.Error("IsKnown('') should be false")
	}
}

func TestManifest_Keys_LengthMatchesPermissions(t *testing.T) {
	keys := M.Keys()
	if len(keys) != len(M.Permissions) {
		t.Fatalf("Keys() len = %d, want %d", len(keys), len(M.Permissions))
	}
}

func TestManifest_Keys_NonemptyAndAllKnown(t *testing.T) {
	if len(M.Keys()) == 0 {
		t.Fatal("Keys() returned empty slice")
	}
	for _, k := range M.Keys() {
		if !M.IsKnown(k) {
			t.Errorf("Keys() returned %q which IsKnown says is unknown", k)
		}
	}
}

func TestManifest_ResourceKeys_NotEmpty(t *testing.T) {
	rk := M.ResourceKeys()
	if len(rk) == 0 {
		t.Fatal("ResourceKeys() returned empty slice")
	}
	if len(rk) != len(M.Resources) {
		t.Fatalf("ResourceKeys() len = %d, want %d", len(rk), len(M.Resources))
	}
}

func TestManifest_SystemRoles_AllKeysPresent(t *testing.T) {
	wantKeys := map[string]bool{"owner": false, "manager": false, "waiter": false, "kitchen": false}
	for _, sr := range M.SystemRoles {
		if _, ok := wantKeys[sr.Key]; ok {
			wantKeys[sr.Key] = true
		}
	}
	for k, found := range wantKeys {
		if !found {
			t.Errorf("system role %q missing from manifest", k)
		}
	}
}

func TestManifest_NonOwnerSystemRoles_NotLocked(t *testing.T) {
	for _, sr := range M.SystemRoles {
		if sr.Key == "owner" {
			continue
		}
		if sr.Locked {
			t.Errorf("system role %q: only owner should be locked, got locked=true", sr.Key)
		}
	}
}

func TestManifest_AllSystemRolePermsValidGrants(t *testing.T) {
	for _, sr := range M.SystemRoles {
		for _, g := range sr.Permissions {
			if err := M.ValidateGrant(g); err != nil {
				t.Errorf("system_role %q grant %q: %v", sr.Key, g, err)
			}
		}
	}
}

func TestManifest_PermissionKeys_MatchResourceColonAction(t *testing.T) {
	for _, p := range M.Permissions {
		want := p.Resource + ":" + p.Action
		if p.Key != want {
			t.Errorf("permission key = %q, want %q (resource:action)", p.Key, want)
		}
	}
}

func TestManifest_Version_Positive(t *testing.T) {
	if M.Version < 1 {
		t.Fatalf("manifest version = %d, want >= 1", M.Version)
	}
}

// =========================================================================
// SeedSystemRoles
// =========================================================================

func TestSeedSystemRoles_CreatesAllFourRoles(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	wantKeys := []string{"owner", "manager", "waiter", "kitchen"}
	for _, k := range wantKeys {
		if _, ok := ids[k]; !ok {
			t.Errorf("SeedSystemRoles missing key %q", k)
		}
	}
	if len(ids) != 4 {
		t.Fatalf("SeedSystemRoles returned %d ids, want 4", len(ids))
	}
}

func TestSeedSystemRoles_OwnerIsSystem(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	ctx := context.Background()
	repo := NewRepo(adminPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := repo.Get(ctx, tx, fx.TenantID, ids["owner"])
	if err != nil {
		t.Fatalf("Get owner: %v", err)
	}
	commit()
	if !role.IsSystem {
		t.Fatal("owner role should have is_system=true")
	}
	if role.Key != "owner" {
		t.Fatalf("owner key = %q, want owner", role.Key)
	}
}

func TestSeedSystemRoles_OwnerHasGlobalWildcard(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	ctx := context.Background()
	repo := NewRepo(adminPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := repo.Get(ctx, tx, fx.TenantID, ids["owner"])
	if err != nil {
		t.Fatalf("Get owner: %v", err)
	}
	commit()
	if len(role.Permissions) != 1 || role.Permissions[0] != "*:*" {
		t.Fatalf("owner permissions = %v, want [*:*]", role.Permissions)
	}
}

func TestSeedSystemRoles_NonSystemRolesHaveExpectedGrants(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	ctx := context.Background()
	repo := NewRepo(adminPool, NewCache(16))

	for _, sr := range M.SystemRoles {
		if sr.Key == "owner" {
			continue
		}
		tx, commit := fx.appTx()
		role, err := repo.Get(ctx, tx, fx.TenantID, ids[sr.Key])
		if err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("Get %s: %v", sr.Key, err)
		}
		commit()

		wantSorted := append([]string(nil), sr.Permissions...)
		sort.Strings(wantSorted)
		gotSorted := append([]string(nil), role.Permissions...)
		sort.Strings(gotSorted)

		if strings.Join(wantSorted, ",") != strings.Join(gotSorted, ",") {
			t.Errorf("role %s: permissions = %v, want %v", sr.Key, gotSorted, wantSorted)
		}
	}
}

func TestSeedSystemRoles_AllRolesMarkedSystem(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	ctx := context.Background()
	repo := NewRepo(adminPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	roles, err := repo.List(ctx, tx, fx.TenantID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	commit()

	for _, r := range roles {
		if _, seeded := ids[r.Key]; seeded {
			if !r.IsSystem {
				t.Errorf("role %q should have is_system=true", r.Key)
			}
		}
	}
}

// =========================================================================
// List
// =========================================================================

func TestList_EmptyTenant(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	roles, err := repo.List(ctx, tx, fx.TenantID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	commit()
	if len(roles) != 0 {
		t.Fatalf("List on empty tenant = %d, want 0", len(roles))
	}
}

func TestList_AfterSeed_ReturnsFourRoles(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	fx.seedSystemRoles()
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	roles, err := repo.List(ctx, tx, fx.TenantID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	commit()
	if len(roles) != 4 {
		t.Fatalf("List after seed = %d roles, want 4", len(roles))
	}
}

func TestList_OrderSystemFirst(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	fx.seedSystemRoles()
	// Add a custom role; it should sort after system roles.
	var customID uuid.UUID
	if err := adminPool.QueryRow(context.Background(),
		`INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, 'aaaa', 'AAAA', false) RETURNING id`,
		fx.TenantID,
	).Scan(&customID); err != nil {
		t.Fatalf("insert custom role: %v", err)
	}

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	roles, err := repo.List(ctx, tx, fx.TenantID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	commit()

	// All is_system=true rows must come before is_system=false rows.
	seenCustom := false
	for _, r := range roles {
		if !r.IsSystem {
			seenCustom = true
		}
		if seenCustom && r.IsSystem {
			t.Fatal("List ordering broken: system role appeared after custom role")
		}
	}
}

func TestList_MemberCountPopulated(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	extra := fx.addUser()

	// Grant waiter to extra user directly.
	fx.adminExec(
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
		fx.TenantID, extra, ids["waiter"],
	)

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	roles, err := repo.List(ctx, tx, fx.TenantID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	commit()

	for _, r := range roles {
		switch r.Key {
		case "owner":
			if r.MemberCount != 1 {
				t.Errorf("owner MemberCount = %d, want 1", r.MemberCount)
			}
		case "waiter":
			if r.MemberCount != 1 {
				t.Errorf("waiter MemberCount = %d, want 1", r.MemberCount)
			}
		case "manager", "kitchen":
			if r.MemberCount != 0 {
				t.Errorf("%s MemberCount = %d, want 0", r.Key, r.MemberCount)
			}
		}
	}
}

func TestList_IsolatedByTenant(t *testing.T) {
	requireDB(t)
	fx1 := newTenantFixture(t)
	fx2 := newTenantFixture(t)
	fx2.seedSystemRoles() // seed only for tenant2

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx1.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	roles, err := repo.List(ctx, tx, fx1.TenantID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	commit()

	if len(roles) != 0 {
		t.Fatalf("tenant isolation broken: List for tenant1 returned %d roles, want 0", len(roles))
	}
}

// =========================================================================
// Get
// =========================================================================

func TestGet_NotFound(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	_, err := repo.Get(ctx, tx, fx.TenantID, uuid.New())
	if err != ErrNotFound {
		t.Fatalf("Get(unknown) = %v, want ErrNotFound", err)
	}
}

func TestGet_WrongTenant(t *testing.T) {
	requireDB(t)
	fx1 := newTenantFixture(t)
	fx2 := newTenantFixture(t)
	ids := fx2.seedSystemRoles() // roles belong to tenant2

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	// Query under tenant1's tx — RLS should hide tenant2's roles.
	tx, _ := fx1.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	_, err := repo.Get(ctx, tx, fx1.TenantID, ids["owner"])
	if err != ErrNotFound {
		t.Fatalf("Get with wrong tenant = %v, want ErrNotFound (RLS should hide it)", err)
	}
}

func TestGet_PermissionsSorted(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := repo.Get(ctx, tx, fx.TenantID, ids["manager"])
	if err != nil {
		t.Fatalf("Get manager: %v", err)
	}
	commit()

	if !sort.StringsAreSorted(role.Permissions) {
		t.Fatalf("Get: Permissions not sorted: %v", role.Permissions)
	}
}

// =========================================================================
// Create
// =========================================================================

func TestCreate_Success(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := repo.Create(ctx, tx, fx.TenantID, "barista", "Barista", "Makes coffee",
		[]string{"menu:read", "order:read"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	commit()

	if role.Key != "barista" {
		t.Errorf("key = %q, want barista", role.Key)
	}
	if role.Name != "Barista" {
		t.Errorf("name = %q, want Barista", role.Name)
	}
	if role.Description != "Makes coffee" {
		t.Errorf("description = %q, want Makes coffee", role.Description)
	}
	if role.IsSystem {
		t.Error("Create should set is_system=false")
	}
	if len(role.Permissions) != 2 {
		t.Fatalf("permissions len = %d, want 2", len(role.Permissions))
	}
}

func TestCreate_OwnerKeyReturnsErrOwnerImmutable(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	_, err := repo.Create(ctx, tx, fx.TenantID, "owner", "Custom Owner", "", nil)
	if err != ErrOwnerImmutable {
		t.Fatalf("Create(owner) = %v, want ErrOwnerImmutable", err)
	}
}

func TestCreate_InvalidGrantReturnsError(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	_, err := repo.Create(ctx, tx, fx.TenantID, "barista", "Barista", "",
		[]string{"bogus:action"})
	if err == nil {
		t.Fatal("Create with unknown grant should return error")
	}
}

func TestCreate_WildcardGrantAllowed(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := repo.Create(ctx, tx, fx.TenantID, "menuall", "Menu All", "", []string{"menu:*"})
	if err != nil {
		t.Fatalf("Create with menu:*: %v", err)
	}
	commit()
	if len(role.Permissions) != 1 || role.Permissions[0] != "menu:*" {
		t.Fatalf("permissions = %v, want [menu:*]", role.Permissions)
	}
}

func TestCreate_DeduplicatesGrants(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	// Supply the same grant three times.
	role, err := repo.Create(ctx, tx, fx.TenantID, "barista", "Barista", "",
		[]string{"menu:read", "menu:read", "menu:read"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	commit()
	if len(role.Permissions) != 1 {
		t.Fatalf("duplicate grants not deduplicated: permissions = %v", role.Permissions)
	}
}

func TestCreate_NoGrants(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := repo.Create(ctx, tx, fx.TenantID, "observer", "Observer", "", nil)
	if err != nil {
		t.Fatalf("Create with no grants: %v", err)
	}
	commit()
	if len(role.Permissions) != 0 {
		t.Fatalf("permissions = %v, want empty", role.Permissions)
	}
}

func TestCreate_PersistedToDatabase(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := repo.Create(ctx, tx, fx.TenantID, "cashier", "Cashier", "", []string{"payment:record"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	commit()

	n := fx.adminScanInt(
		`SELECT count(*) FROM roles WHERE tenant_id = $1 AND key = 'cashier' AND is_system = false`,
		fx.TenantID)
	if n != 1 {
		t.Fatalf("role not persisted: count = %d", n)
	}

	np := fx.adminScanInt(
		`SELECT count(*) FROM role_permissions WHERE role_id = $1 AND permission = 'payment:record'`,
		role.ID)
	if np != 1 {
		t.Fatalf("grant not persisted: count = %d", np)
	}
}

// =========================================================================
// Update
// =========================================================================

func TestUpdate_NotFound(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	name := "X"
	_, err := repo.Update(ctx, tx, fx.TenantID, uuid.New(), &name, nil, nil)
	if err != ErrNotFound {
		t.Fatalf("Update(unknown) = %v, want ErrNotFound", err)
	}
}

func TestUpdate_OwnerReturnsErrOwnerImmutable(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	name := "Super Owner"
	_, err := repo.Update(ctx, tx, fx.TenantID, ids["owner"], &name, nil, nil)
	if err != ErrOwnerImmutable {
		t.Fatalf("Update(owner) = %v, want ErrOwnerImmutable", err)
	}
}

func TestUpdate_OwnerGrantChangeReturnErrOwnerImmutable(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	grants := []string{"menu:read"}
	_, err := repo.Update(ctx, tx, fx.TenantID, ids["owner"], nil, nil, &grants)
	if err != ErrOwnerImmutable {
		t.Fatalf("Update owner grants = %v, want ErrOwnerImmutable", err)
	}
}

func TestUpdate_NameOnly(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	// Create a custom role.
	txC, commitC := fx.appTx()
	role, err := repo.Create(ctx, txC, fx.TenantID, "barista", "Barista", "Orig desc", []string{"menu:read"})
	if err != nil {
		_ = txC.Rollback(ctx)
		t.Fatalf("Create: %v", err)
	}
	commitC()

	// Update name only.
	txU, commitU := fx.appTx()
	defer func() { _ = txU.Rollback(ctx) }()
	newName := "Head Barista"
	updated, err := repo.Update(ctx, txU, fx.TenantID, role.ID, &newName, nil, nil)
	if err != nil {
		t.Fatalf("Update name: %v", err)
	}
	commitU()

	if updated.Name != "Head Barista" {
		t.Errorf("name = %q, want Head Barista", updated.Name)
	}
	if updated.Description != "Orig desc" {
		t.Errorf("description changed: got %q, want Orig desc", updated.Description)
	}
	if len(updated.Permissions) != 1 || updated.Permissions[0] != "menu:read" {
		t.Errorf("permissions changed unexpectedly: %v", updated.Permissions)
	}
}

func TestUpdate_DescriptionOnly(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	txC, commitC := fx.appTx()
	role, err := repo.Create(ctx, txC, fx.TenantID, "cashier", "Cashier", "Old desc", nil)
	if err != nil {
		_ = txC.Rollback(ctx)
		t.Fatalf("Create: %v", err)
	}
	commitC()

	txU, commitU := fx.appTx()
	defer func() { _ = txU.Rollback(ctx) }()
	newDesc := "New desc"
	updated, err := repo.Update(ctx, txU, fx.TenantID, role.ID, nil, &newDesc, nil)
	if err != nil {
		t.Fatalf("Update desc: %v", err)
	}
	commitU()

	if updated.Description != "New desc" {
		t.Errorf("description = %q, want New desc", updated.Description)
	}
	if updated.Name != "Cashier" {
		t.Errorf("name changed: got %q, want Cashier", updated.Name)
	}
}

func TestUpdate_ReplaceGrants(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	txC, commitC := fx.appTx()
	role, err := repo.Create(ctx, txC, fx.TenantID, "runner", "Runner", "",
		[]string{"menu:read", "order:read"})
	if err != nil {
		_ = txC.Rollback(ctx)
		t.Fatalf("Create: %v", err)
	}
	commitC()

	txU, commitU := fx.appTx()
	defer func() { _ = txU.Rollback(ctx) }()
	newGrants := []string{"kitchen:read", "kitchen:update"}
	updated, err := repo.Update(ctx, txU, fx.TenantID, role.ID, nil, nil, &newGrants)
	if err != nil {
		t.Fatalf("Update grants: %v", err)
	}
	commitU()

	sort.Strings(newGrants)
	sort.Strings(updated.Permissions)
	if strings.Join(updated.Permissions, ",") != strings.Join(newGrants, ",") {
		t.Errorf("permissions = %v, want %v", updated.Permissions, newGrants)
	}
}

func TestUpdate_InvalidGrantReturnsError(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	txC, commitC := fx.appTx()
	role, err := repo.Create(ctx, txC, fx.TenantID, "runner", "Runner", "", nil)
	if err != nil {
		_ = txC.Rollback(ctx)
		t.Fatalf("Create: %v", err)
	}
	commitC()

	txU, _ := fx.appTx()
	defer func() { _ = txU.Rollback(ctx) }()
	bad := []string{"INVALID_GRANT"}
	_, err = repo.Update(ctx, txU, fx.TenantID, role.ID, nil, nil, &bad)
	if err == nil {
		t.Fatal("Update with invalid grant should return error")
	}
}

func TestUpdate_SystemNonOwnerCanBeRenamed(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	newName := "Senior Manager"
	updated, err := repo.Update(ctx, tx, fx.TenantID, ids["manager"], &newName, nil, nil)
	if err != nil {
		t.Fatalf("Update manager name: %v", err)
	}
	commit()
	if updated.Name != "Senior Manager" {
		t.Errorf("name = %q, want Senior Manager", updated.Name)
	}
}

func TestUpdate_EmptyGrantsListClearsPermissions(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	txC, commitC := fx.appTx()
	role, err := repo.Create(ctx, txC, fx.TenantID, "runner", "Runner", "",
		[]string{"menu:read"})
	if err != nil {
		_ = txC.Rollback(ctx)
		t.Fatalf("Create: %v", err)
	}
	commitC()

	txU, commitU := fx.appTx()
	defer func() { _ = txU.Rollback(ctx) }()
	empty := []string{}
	updated, err := repo.Update(ctx, txU, fx.TenantID, role.ID, nil, nil, &empty)
	if err != nil {
		t.Fatalf("Update empty grants: %v", err)
	}
	commitU()
	if len(updated.Permissions) != 0 {
		t.Fatalf("permissions = %v, want empty after clearing", updated.Permissions)
	}
}

// =========================================================================
// Delete
// =========================================================================

func TestDelete_NotFound(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	err := repo.Delete(ctx, tx, fx.TenantID, uuid.New())
	if err != ErrNotFound {
		t.Fatalf("Delete(unknown) = %v, want ErrNotFound", err)
	}
}

func TestDelete_OwnerReturnsErrOwnerImmutable(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	err := repo.Delete(ctx, tx, fx.TenantID, ids["owner"])
	if err != ErrOwnerImmutable {
		t.Fatalf("Delete(owner) = %v, want ErrOwnerImmutable", err)
	}
}

func TestDelete_RoleWithMembersReturnsErrRoleHasMembers(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	txC, commitC := fx.appTx()
	role, err := repo.Create(ctx, txC, fx.TenantID, "cashier", "Cashier", "", nil)
	if err != nil {
		_ = txC.Rollback(ctx)
		t.Fatalf("Create: %v", err)
	}
	commitC()

	// Grant the role to the owner user.
	fx.adminExec(
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
		fx.TenantID, fx.UserID, role.ID,
	)

	txD, _ := fx.appTx()
	defer func() { _ = txD.Rollback(ctx) }()
	err = repo.Delete(ctx, txD, fx.TenantID, role.ID)
	if err != ErrRoleHasMembers {
		t.Fatalf("Delete(role with member) = %v, want ErrRoleHasMembers", err)
	}
}

func TestDelete_CustomRoleSuccess(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	txC, commitC := fx.appTx()
	role, err := repo.Create(ctx, txC, fx.TenantID, "cashier", "Cashier", "",
		[]string{"payment:record"})
	if err != nil {
		_ = txC.Rollback(ctx)
		t.Fatalf("Create: %v", err)
	}
	commitC()

	txD, commitD := fx.appTx()
	defer func() { _ = txD.Rollback(ctx) }()
	if err := repo.Delete(ctx, txD, fx.TenantID, role.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	commitD()

	n := fx.adminScanInt(`SELECT count(*) FROM roles WHERE id = $1`, role.ID)
	if n != 0 {
		t.Fatalf("role still exists after Delete: count = %d", n)
	}
	// Permissions cascade-deleted.
	np := fx.adminScanInt(`SELECT count(*) FROM role_permissions WHERE role_id = $1`, role.ID)
	if np != 0 {
		t.Fatalf("role_permissions not cascade-deleted: count = %d", np)
	}
}

func TestDelete_NonOwnerSystemRoleCanBeDeleted(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	// Waiter has no members — should be deletable.
	if err := repo.Delete(ctx, tx, fx.TenantID, ids["waiter"]); err != nil {
		t.Fatalf("Delete waiter system role: %v", err)
	}
	commit()
}

func TestDelete_SecondDeleteReturnsNotFound(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	txC, commitC := fx.appTx()
	role, err := repo.Create(ctx, txC, fx.TenantID, "cashier", "Cashier", "", nil)
	if err != nil {
		_ = txC.Rollback(ctx)
		t.Fatalf("Create: %v", err)
	}
	commitC()

	txD1, commitD1 := fx.appTx()
	if err := repo.Delete(ctx, txD1, fx.TenantID, role.ID); err != nil {
		_ = txD1.Rollback(ctx)
		t.Fatalf("first Delete: %v", err)
	}
	commitD1()

	txD2, _ := fx.appTx()
	defer func() { _ = txD2.Rollback(ctx) }()
	if err := repo.Delete(ctx, txD2, fx.TenantID, role.ID); err != ErrNotFound {
		t.Fatalf("second Delete = %v, want ErrNotFound", err)
	}
}

// =========================================================================
// LookupRoleByKey
// =========================================================================

func TestLookupRoleByKey_Found(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := repo.LookupRoleByKey(ctx, tx, fx.TenantID, "owner")
	if err != nil {
		t.Fatalf("LookupRoleByKey(owner): %v", err)
	}
	commit()
	if role.Key != "owner" {
		t.Errorf("key = %q, want owner", role.Key)
	}
}

func TestLookupRoleByKey_NotFound(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	_, err := repo.LookupRoleByKey(ctx, tx, fx.TenantID, "nonexistent")
	if err != ErrNotFound {
		t.Fatalf("LookupRoleByKey(nonexistent) = %v, want ErrNotFound", err)
	}
}

func TestLookupRoleByKey_AllSystemRoles(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	for _, k := range []string{"owner", "manager", "waiter", "kitchen"} {
		tx, commit := fx.appTx()
		role, err := repo.LookupRoleByKey(ctx, tx, fx.TenantID, k)
		if err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("LookupRoleByKey(%s): %v", k, err)
		}
		commit()
		if role.ID != ids[k] {
			t.Errorf("LookupRoleByKey(%s): id mismatch", k)
		}
	}
}

func TestLookupRoleByKey_IsolatedByTenant(t *testing.T) {
	requireDB(t)
	fx1 := newTenantFixture(t)
	fx2 := newTenantFixture(t)
	fx2.seedSystemRoles() // only seed for tenant2

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx1.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	// Tenant1 has no roles — should get ErrNotFound for "owner".
	_, err := repo.LookupRoleByKey(ctx, tx, fx1.TenantID, "owner")
	if err != ErrNotFound {
		t.Fatalf("LookupRoleByKey cross-tenant = %v, want ErrNotFound", err)
	}
}

// =========================================================================
// LoadForMember (permission resolution + cache integration)
// =========================================================================

func TestLoadForMember_OwnerHasGlobalWildcard(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	fx.seedSystemRoles()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(64))

	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()
	ps, err := repo.LoadForMember(ctx, tx, fx.TenantID, fx.UserID)
	if err != nil {
		t.Fatalf("LoadForMember(owner): %v", err)
	}
	commit()

	if _, has := ps.Set["*:*"]; !has {
		t.Fatal("owner permission set should contain *:*")
	}
	if !ps.Has("finance:correct") {
		t.Fatal("owner with *:* should grant finance:correct via Has")
	}
	if !ps.Has("menu:read") {
		t.Fatal("owner with *:* should grant menu:read via Has")
	}
}

func TestLoadForMember_WaiterHasLimitedGrants(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	waiterUser := fx.addUser()

	// Grant waiter role to the extra user.
	fx.adminExec(
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
		fx.TenantID, waiterUser, ids["waiter"],
	)

	ctx := context.Background()
	// Use an app-pool tx scoped to the waiter user.
	tx, err := appPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", fx.TenantID.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", waiterUser.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}

	repo := NewRepo(appPool, NewCache(64))
	ps, err := repo.LoadForMember(ctx, tx, fx.TenantID, waiterUser)
	if err != nil {
		t.Fatalf("LoadForMember(waiter): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// Waiter should have menu:read, order:read, order:create etc.
	if !ps.Has("menu:read") {
		t.Error("waiter should have menu:read")
	}
	if !ps.Has("order:create") {
		t.Error("waiter should have order:create")
	}
	// Waiter should NOT have finance:read or admin-level perms.
	if ps.Has("finance:read") {
		t.Error("waiter should NOT have finance:read")
	}
	if ps.Has("role:delete") {
		t.Error("waiter should NOT have role:delete")
	}
}

func TestLoadForMember_ResourceWildcardExpansion(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	extra := fx.addUser()

	// Manager has menu:* — every menu action should be granted.
	fx.adminExec(
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
		fx.TenantID, extra, ids["manager"],
	)

	ctx := context.Background()
	tx, err := appPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", fx.TenantID.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", extra.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}

	repo := NewRepo(appPool, NewCache(64))
	ps, err := repo.LoadForMember(ctx, tx, fx.TenantID, extra)
	if err != nil {
		t.Fatalf("LoadForMember(manager): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// Manager has menu:* in role_permissions — Has() should expand it.
	for _, action := range []string{"read", "create", "update", "delete"} {
		key := "menu:" + action
		if !ps.Has(key) {
			t.Errorf("manager should have %s via menu:* wildcard", key)
		}
	}
}

func TestLoadForMember_NoRolesEmptySet(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	extra := fx.addUser() // member with no roles

	ctx := context.Background()
	tx, err := appPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", fx.TenantID.String()); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", extra.String()); err != nil {
		t.Fatalf("set user: %v", err)
	}

	repo := NewRepo(appPool, NewCache(64))
	ps, err := repo.LoadForMember(ctx, tx, fx.TenantID, extra)
	if err != nil {
		t.Fatalf("LoadForMember(no roles): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if len(ps.Set) != 0 {
		t.Fatalf("expected empty permission set for memberless user, got %v", ps.Set)
	}
}

func TestLoadForMember_RolesFieldPopulated(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	fx.seedSystemRoles() // grants owner to fx.UserID

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(64))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	ps, err := repo.LoadForMember(ctx, tx, fx.TenantID, fx.UserID)
	if err != nil {
		t.Fatalf("LoadForMember: %v", err)
	}
	commit()

	found := false
	for _, rk := range ps.Roles {
		if rk == "owner" {
			found = true
		}
	}
	if !found {
		t.Fatalf("Roles = %v, want 'owner' to be present", ps.Roles)
	}
	if !sort.StringsAreSorted(ps.Roles) {
		t.Fatalf("Roles not sorted: %v", ps.Roles)
	}
}

func TestLoadForMember_CacheHitOnSecondCall(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	fx.seedSystemRoles()

	ctx := context.Background()
	cache := NewCache(64)
	repo := NewRepo(appPool, cache)

	tx1, commit1 := fx.appTx()
	ps1, err := repo.LoadForMember(ctx, tx1, fx.TenantID, fx.UserID)
	if err != nil {
		_ = tx1.Rollback(ctx)
		t.Fatalf("first LoadForMember: %v", err)
	}
	commit1()

	if cache.Size() != 1 {
		t.Fatalf("cache size after first load = %d, want 1", cache.Size())
	}

	tx2, commit2 := fx.appTx()
	ps2, err := repo.LoadForMember(ctx, tx2, fx.TenantID, fx.UserID)
	if err != nil {
		_ = tx2.Rollback(ctx)
		t.Fatalf("second LoadForMember: %v", err)
	}
	commit2()

	// Both calls should return identical data.
	if ps1.Version != ps2.Version {
		t.Errorf("version mismatch: %d vs %d", ps1.Version, ps2.Version)
	}
	if len(ps1.Set) != len(ps2.Set) {
		t.Errorf("Set size mismatch: %d vs %d", len(ps1.Set), len(ps2.Set))
	}
}

func TestLoadForMember_CacheMissAfterRolesVersionBump(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	fx.seedSystemRoles()

	ctx := context.Background()
	cache := NewCache(64)
	repo := NewRepo(appPool, cache)

	// Warm the cache.
	tx1, commit1 := fx.appTx()
	ps1, err := repo.LoadForMember(ctx, tx1, fx.TenantID, fx.UserID)
	if err != nil {
		_ = tx1.Rollback(ctx)
		t.Fatalf("first LoadForMember: %v", err)
	}
	commit1()
	oldVersion := ps1.Version

	// Force a roles_version bump by inserting a new role via admin pool.
	// The trigger on roles will increment tenants.roles_version.
	var newRoleID uuid.UUID
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, 'tmp_bump', 'Tmp', false) RETURNING id`,
		fx.TenantID,
	).Scan(&newRoleID); err != nil {
		t.Fatalf("insert bump role: %v", err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(ctx, `DELETE FROM roles WHERE id = $1`, newRoleID)
	})

	// Next load should see a new version and re-query.
	tx2, commit2 := fx.appTx()
	ps2, err := repo.LoadForMember(ctx, tx2, fx.TenantID, fx.UserID)
	if err != nil {
		_ = tx2.Rollback(ctx)
		t.Fatalf("second LoadForMember: %v", err)
	}
	commit2()

	if ps2.Version <= oldVersion {
		t.Fatalf("roles_version not bumped: old=%d, new=%d", oldVersion, ps2.Version)
	}
}

// =========================================================================
// AssignMemberRoles
// =========================================================================

func TestAssignMemberRoles_ReplacesRoles(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	extra := fx.addUser()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))

	// Initially assign waiter.
	tx1, commit1 := fx.appTx()
	if err := repo.AssignMemberRoles(ctx, tx1, fx.TenantID, extra, []uuid.UUID{ids["waiter"]}); err != nil {
		_ = tx1.Rollback(ctx)
		t.Fatalf("AssignMemberRoles(waiter): %v", err)
	}
	commit1()

	n1 := fx.adminScanInt(
		`SELECT count(*) FROM tenant_member_roles WHERE tenant_id = $1 AND user_id = $2`,
		fx.TenantID, extra)
	if n1 != 1 {
		t.Fatalf("after assign waiter: count = %d, want 1", n1)
	}

	// Replace with manager + kitchen.
	tx2, commit2 := fx.appTx()
	if err := repo.AssignMemberRoles(ctx, tx2, fx.TenantID, extra,
		[]uuid.UUID{ids["manager"], ids["kitchen"]}); err != nil {
		_ = tx2.Rollback(ctx)
		t.Fatalf("AssignMemberRoles(manager+kitchen): %v", err)
	}
	commit2()

	n2 := fx.adminScanInt(
		`SELECT count(*) FROM tenant_member_roles WHERE tenant_id = $1 AND user_id = $2`,
		fx.TenantID, extra)
	if n2 != 2 {
		t.Fatalf("after assign manager+kitchen: count = %d, want 2", n2)
	}
	// Old waiter assignment should be gone.
	nW := fx.adminScanInt(
		`SELECT count(*) FROM tenant_member_roles tmr
		 JOIN roles r ON r.id = tmr.role_id
		 WHERE tmr.tenant_id = $1 AND tmr.user_id = $2 AND r.key = 'waiter'`,
		fx.TenantID, extra)
	if nW != 0 {
		t.Fatalf("waiter role should be gone after replace, found %d rows", nW)
	}
}

func TestAssignMemberRoles_RejectsForeignRole(t *testing.T) {
	requireDB(t)
	fx1 := newTenantFixture(t)
	fx2 := newTenantFixture(t)
	ids2 := fx2.seedSystemRoles() // roles belong to tenant2
	extra := fx1.addUser()

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, _ := fx1.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	// Trying to assign a role from tenant2 should fail.
	err := repo.AssignMemberRoles(ctx, tx, fx1.TenantID, extra, []uuid.UUID{ids2["waiter"]})
	if err == nil {
		t.Fatal("AssignMemberRoles with foreign role should return error")
	}
}

func TestAssignMemberRoles_EmptyListClearsRoles(t *testing.T) {
	requireDB(t)
	fx := newTenantFixture(t)
	ids := fx.seedSystemRoles()
	extra := fx.addUser()

	// Assign waiter first.
	fx.adminExec(
		`INSERT INTO tenant_member_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
		fx.TenantID, extra, ids["waiter"],
	)

	ctx := context.Background()
	repo := NewRepo(appPool, NewCache(16))
	tx, commit := fx.appTx()
	defer func() { _ = tx.Rollback(ctx) }()

	if err := repo.AssignMemberRoles(ctx, tx, fx.TenantID, extra, []uuid.UUID{}); err != nil {
		t.Fatalf("AssignMemberRoles(empty): %v", err)
	}
	commit()

	n := fx.adminScanInt(
		`SELECT count(*) FROM tenant_member_roles WHERE tenant_id = $1 AND user_id = $2`,
		fx.TenantID, extra)
	if n != 0 {
		t.Fatalf("expected 0 roles after empty assign, got %d", n)
	}
}
