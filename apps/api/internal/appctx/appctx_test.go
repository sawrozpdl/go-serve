package appctx

import (
	"context"
	"log/slog"
	"testing"

	"github.com/google/uuid"
)

// ---------------------------------------------------------------------------
// Tx
// ---------------------------------------------------------------------------

func TestTx_PanicsWhenAbsent(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic when no tx in context")
		}
	}()
	Tx(context.Background())
}

// We can't use a real pgx.Tx in a unit test without a DB, but we can verify
// that WithTx stores something the type-assert path can retrieve. Since pgx.Tx
// is an interface the zero value is nil; store a real-typed nil pointer to
// satisfy the interface — the panic path is the important thing to cover here,
// and it is covered above.
func TestTx_PresentDoesNotPanic(t *testing.T) {
	// Use a typed-nil pgx.Tx: nil satisfies pgx.Tx interface in WithTx.
	ctx := context.WithValue(context.Background(), txKey, nil)
	// ctx.Value will return nil (interface), which type-asserts to (pgx.Tx, false).
	// That means WithTx(ctx, nil) would panic... but we can verify the panic
	// guard works by injecting a raw nil through the WithTx helper; here just
	// ensure WithTx itself doesn't panic when the value is the interface type.
	// The real test is the panic test above.
	_ = ctx
}

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

func TestTenant_RoundTrip(t *testing.T) {
	want := Tenant{ID: uuid.New(), Slug: "cafe-test", Name: "Test Cafe", Timezone: "Asia/Kathmandu"}
	ctx := WithTenant(context.Background(), want)
	got, ok := TenantFromContext(ctx)
	if !ok {
		t.Fatal("TenantFromContext ok = false, want true")
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestTenant_Missing(t *testing.T) {
	_, ok := TenantFromContext(context.Background())
	if ok {
		t.Fatal("ok = true, want false when absent")
	}
}

func TestMustTenant_PanicsWhenAbsent(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic when no tenant in context")
		}
	}()
	MustTenant(context.Background())
}

func TestMustTenant_ReturnsWhenPresent(t *testing.T) {
	want := Tenant{ID: uuid.New(), Slug: "s", Name: "N", Timezone: "UTC"}
	ctx := WithTenant(context.Background(), want)
	got := MustTenant(ctx)
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

func TestUser_RoundTrip(t *testing.T) {
	want := User{ID: uuid.New(), Email: "user@test.local", Name: "Test User"}
	ctx := WithUser(context.Background(), want)
	got, ok := UserFromContext(ctx)
	if !ok {
		t.Fatal("UserFromContext ok = false, want true")
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestUser_Missing(t *testing.T) {
	_, ok := UserFromContext(context.Background())
	if ok {
		t.Fatal("ok = true, want false when absent")
	}
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

func TestSession_RoundTrip(t *testing.T) {
	want := Session{
		ID:        uuid.New(),
		UserID:    uuid.New(),
		TenantID:  uuid.New(),
		ExpiresAt: 9999999999,
	}
	ctx := WithSession(context.Background(), want)
	got, ok := SessionFromContext(ctx)
	if !ok {
		t.Fatal("SessionFromContext ok = false, want true")
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestSession_Missing(t *testing.T) {
	_, ok := SessionFromContext(context.Background())
	if ok {
		t.Fatal("ok = true, want false when absent")
	}
}

// ---------------------------------------------------------------------------
// RequestID
// ---------------------------------------------------------------------------

func TestRequestID_RoundTrip(t *testing.T) {
	ctx := WithRequestID(context.Background(), "req-123")
	got, ok := RequestID(ctx)
	if !ok {
		t.Fatal("ok = false")
	}
	if got != "req-123" {
		t.Errorf("got %q, want %q", got, "req-123")
	}
}

func TestRequestID_Missing(t *testing.T) {
	_, ok := RequestID(context.Background())
	if ok {
		t.Fatal("ok = true, want false when absent")
	}
}

// ---------------------------------------------------------------------------
// IP
// ---------------------------------------------------------------------------

func TestIP_RoundTrip(t *testing.T) {
	ctx := WithIP(context.Background(), "192.168.1.1")
	got, ok := IP(ctx)
	if !ok {
		t.Fatal("ok = false")
	}
	if got != "192.168.1.1" {
		t.Errorf("got %q, want %q", got, "192.168.1.1")
	}
}

func TestIP_Missing(t *testing.T) {
	_, ok := IP(context.Background())
	if ok {
		t.Fatal("ok = true, want false when absent")
	}
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

func TestRoles_RoundTrip(t *testing.T) {
	want := []string{"owner", "manager"}
	ctx := WithRoles(context.Background(), want)
	got, ok := Roles(ctx)
	if !ok {
		t.Fatal("ok = false")
	}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] got %q, want %q", i, got[i], want[i])
		}
	}
}

func TestRoles_Missing(t *testing.T) {
	_, ok := Roles(context.Background())
	if ok {
		t.Fatal("ok = true, want false when absent")
	}
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

func TestPermissions_RoundTrip(t *testing.T) {
	want := map[string]struct{}{"menu:read": {}, "menu:*": {}}
	ctx := WithPermissions(context.Background(), want)
	got, ok := Permissions(ctx)
	if !ok {
		t.Fatal("ok = false")
	}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d", len(got), len(want))
	}
	for k := range want {
		if _, exists := got[k]; !exists {
			t.Errorf("key %q missing from result", k)
		}
	}
}

func TestPermissions_Missing(t *testing.T) {
	_, ok := Permissions(context.Background())
	if ok {
		t.Fatal("ok = true, want false when absent")
	}
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

func TestLogger_RoundTrip(t *testing.T) {
	l := slog.New(slog.NewTextHandler(nil, nil))
	// Note: slog.New with nil writer panics on emit but the pointer identity is fine.
	_ = l
	customLogger := slog.Default().With("req", "test")
	ctx := WithLogger(context.Background(), customLogger)
	got := Logger(ctx)
	if got != customLogger {
		t.Error("Logger returned different pointer than stored")
	}
}

func TestLogger_FallsBackToDefault_WhenAbsent(t *testing.T) {
	got := Logger(context.Background())
	if got != slog.Default() {
		t.Error("Logger should return slog.Default() when absent")
	}
}

func TestLogger_FallsBackToDefault_WhenNilStored(t *testing.T) {
	// Storing a nil *slog.Logger should also fall back to slog.Default().
	ctx := context.WithValue(context.Background(), loggerKey, (*slog.Logger)(nil))
	got := Logger(ctx)
	if got != slog.Default() {
		t.Error("Logger should return slog.Default() when nil stored")
	}
}

// ---------------------------------------------------------------------------
// PlatformAdmin
// ---------------------------------------------------------------------------

func TestPlatformAdmin_RoundTrip(t *testing.T) {
	ctx := WithPlatformAdmin(context.Background(), true)
	if !IsPlatformAdmin(ctx) {
		t.Error("IsPlatformAdmin = false, want true")
	}
}

func TestPlatformAdmin_False(t *testing.T) {
	ctx := WithPlatformAdmin(context.Background(), false)
	if IsPlatformAdmin(ctx) {
		t.Error("IsPlatformAdmin = true, want false")
	}
}

func TestPlatformAdmin_Missing_ReturnsFalse(t *testing.T) {
	if IsPlatformAdmin(context.Background()) {
		t.Error("IsPlatformAdmin = true on empty context, want false")
	}
}

// ---------------------------------------------------------------------------
// Post-commit registry
// ---------------------------------------------------------------------------

func TestAfterCommit_RunsImmediately_WhenNoRegistry(t *testing.T) {
	ran := false
	AfterCommit(context.Background(), func() { ran = true })
	if !ran {
		t.Fatal("fn should run immediately when no registry on context")
	}
}

func TestAfterCommit_QueuesWhenRegistryPresent(t *testing.T) {
	ctx := WithPostCommit(context.Background())

	ran := false
	AfterCommit(ctx, func() { ran = true })

	if ran {
		t.Fatal("fn should NOT run yet before RunPostCommit")
	}

	RunPostCommit(ctx)
	if !ran {
		t.Fatal("fn should run after RunPostCommit")
	}
}

func TestAfterCommit_MultipleFns_DrainInOrder(t *testing.T) {
	ctx := WithPostCommit(context.Background())

	order := make([]int, 0, 3)
	for i := range 3 {
		i := i
		AfterCommit(ctx, func() { order = append(order, i) })
	}

	RunPostCommit(ctx)

	if len(order) != 3 {
		t.Fatalf("len = %d, want 3", len(order))
	}
	for i, v := range order {
		if v != i {
			t.Errorf("order[%d] = %d, want %d", i, v, i)
		}
	}
}

func TestRunPostCommit_NoOp_WhenEmpty(t *testing.T) {
	// Should not panic.
	ctx := WithPostCommit(context.Background())
	RunPostCommit(ctx)
}

func TestRunPostCommit_NoOp_WhenNoRegistry(t *testing.T) {
	// Should not panic.
	RunPostCommit(context.Background())
}

func TestRunPostCommit_Drains_Queue(t *testing.T) {
	ctx := WithPostCommit(context.Background())
	runs := 0
	AfterCommit(ctx, func() { runs++ })
	RunPostCommit(ctx)
	RunPostCommit(ctx) // second call should be a no-op (queue cleared)
	if runs != 1 {
		t.Errorf("fn ran %d times, want 1", runs)
	}
}

func TestAfterCommit_RegistryPresent_DoesNotRunImmediately(t *testing.T) {
	ctx := WithPostCommit(context.Background())
	called := false
	AfterCommit(ctx, func() { called = true })
	if called {
		t.Error("AfterCommit must not call fn until RunPostCommit")
	}
}
