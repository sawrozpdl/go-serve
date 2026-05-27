package rbac

import "testing"

func TestPermissionSet_Has(t *testing.T) {
	cases := []struct {
		name string
		set  []string
		want string
		ok   bool
	}{
		{"exact match", []string{"menu:read"}, "menu:read", true},
		{"miss", []string{"menu:read"}, "menu:create", false},
		{"resource wildcard hits", []string{"menu:*"}, "menu:create", true},
		{"resource wildcard misses other resource", []string{"menu:*"}, "order:create", false},
		{"global wildcard hits everything", []string{"*:*"}, "finance:correct", true},
		{"empty set denies", []string{}, "menu:read", false},
		{"nil set denies", nil, "menu:read", false},
		{"multiple grants, exact wins", []string{"order:create", "order:read"}, "order:read", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ps := PermissionSet{Set: makeSet(tc.set)}
			if got := ps.Has(tc.want); got != tc.ok {
				t.Fatalf("Has(%q) over %v = %v, want %v", tc.want, tc.set, got, tc.ok)
			}
		})
	}
}

func TestPermissionSet_HasAny(t *testing.T) {
	ps := PermissionSet{Set: makeSet([]string{"menu:read"})}
	if !ps.HasAny("order:create", "menu:read") {
		t.Fatal("expected HasAny to find menu:read")
	}
	if ps.HasAny("order:create", "order:read") {
		t.Fatal("expected HasAny to miss")
	}
	if ps.HasAny() {
		t.Fatal("HasAny with no args must be false")
	}
}

func TestManifest_ValidateGrant(t *testing.T) {
	ok := []string{"*:*", "menu:*", "menu:read", "finance:correct"}
	bad := []string{"", "menu", ":read", "Menu:read", "menu:Create", "bogus:read", "menu:bogus"}
	for _, g := range ok {
		if err := M.ValidateGrant(g); err != nil {
			t.Errorf("ValidateGrant(%q) returned %v, want nil", g, err)
		}
	}
	for _, g := range bad {
		if err := M.ValidateGrant(g); err == nil {
			t.Errorf("ValidateGrant(%q) returned nil, want error", g)
		}
	}
}

func TestManifest_OwnerLocked(t *testing.T) {
	var owner *SystemRole
	for i := range M.SystemRoles {
		if M.SystemRoles[i].Key == "owner" {
			owner = &M.SystemRoles[i]
			break
		}
	}
	if owner == nil {
		t.Fatal("manifest missing owner system role")
	}
	if !owner.Locked {
		t.Fatal("owner system role must be locked")
	}
	if len(owner.Permissions) != 1 || owner.Permissions[0] != "*:*" {
		t.Fatalf("owner permissions = %v, want [*:*]", owner.Permissions)
	}
}

func makeSet(keys []string) map[string]struct{} {
	if keys == nil {
		return nil
	}
	m := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		m[k] = struct{}{}
	}
	return m
}
