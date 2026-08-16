# HTTP end-to-end tests

These drive the API the way a client does: over HTTP, through the real router,
with real tokens.

```bash
make e2e-api                                 # from the repo root, verbose
cd apps/api && go test -tags e2e ./test/e2e/ # or just this package
```

**The `e2e` build tag is required.** Without it every file here is excluded, so
plain `go test ./...` — what CI runs — skips the package entirely. That is
deliberate: these tests overlap the `internal/api` integration suite on coverage
but take far longer, and CI minutes are the scarce resource. Run them locally
before anything that touches money, ordering, or the router.

`REQUIRE_DB=1` turns "no database" into a failure instead of a silent skip.

## Why they exist next to `internal/api`

The ~1250 tests in `internal/api` call handler functions directly with a
hand-built context. That covers handler logic and RLS well and runs fast, but a
whole layer of the server never gets exercised:

| Layer | Invisible from a handler test |
|---|---|
| Router | Is the handler mounted where the client expects it? Right verb? |
| Auth | Bearer parsing, expiry, `token_version`, the shape of a 401 |
| RBAC | Does `waiter` really lack `report:read` in the production wiring? |
| Tenant | `X-Tenant-ID` resolution, cross-cafe refusal |
| Billing | Trial expiry, write locks, per-plan feature gating |
| Concurrency | Two tablets are two connections, two transactions, two row locks |

A route mounted without its permission guard, or a gate that stopped firing, is
a green unit test and a broken app.

## Files

- **`harness_test.go`** — boots `httpx.NewRouter` on `httptest`, logs in through
  `/auth/dev-login`, and gives each test a throwaway cafe with a member at every
  role. Roles come from `rbac.SeedSystemRoles` — the same call tenant creation
  makes — so the role tests assert what a real cafe gets rather than what the
  harness granted itself.
- **`access_test.go`** — authentication, tenant scoping, role boundaries in both
  directions, billing gates, `/v1/super`.
- **`money_journey_test.go`** — a day's trading with the arithmetic asserted at
  every step, including the credit-collected journey that prompted the accuracy
  audit.
- **`edge_cases_test.go`** — races (4 concurrent requests, exactly one may win),
  refusals that protect closed books, local-midnight and timezone boundaries,
  replayed writes.

## Two pools, deliberately

- `pool` — `DATABASE_URL`, superuser. Fixture setup and verification. **Bypasses
  RLS.**
- `appPool` — `APP_DATABASE_URL`, `app_user`, `NOBYPASSRLS`. What the **router**
  runs on, exactly as production does.

Booting the router on the superuser pool looks fine and silently disables every
tenant boundary: reports then aggregate the whole database, and "expected cash"
picks up another cafe's open shift. Both were observed while writing these tests.

## Conventions

- Every money test ends with `c.assertClean()`, which runs the live invariant
  checker (`platform_accuracy_check`, migration 0056) over that tenant only and
  fails with the offending rows spelled out. A handler that leaves the books
  inconsistent fails here even if its own unit test passes.
- `expectDenied()` accepts 401/403/402/409 and a JSON 404, but **rejects** 405 and
  chi's plain-text `404 page not found`: those mean the test called a route that
  isn't there, so a missing guard would read as a pass.
- Fixtures are created on a real plan (`standard`) and paid through next month. A
  planless tenant 403s every feature-gated route, which would make the role tests
  lie.
