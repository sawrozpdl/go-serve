# Fix guide: prod alert noise — commit_failed on 409 + "context canceled" 500s

**Date:** 2026-07-19 · **Tenant seen:** chiya-thali · **Status:** ✅ fixed (implemented + tested).
Three alert types fired over 18–19 July. All three are **alert/status-mapping bugs, not data-loss or outage bugs**. No customer data was lost. The goal of this fix is to stop paging on non-events while keeping the real signals. See **Resolution** at the bottom for what shipped.

---

## Alert A — `http.commit_failed` "commit unexpectedly resulted in rollback" (POST /v1/orders, status 409)

### Root cause (confirmed)

Chain, all in-repo:

1. `OpenOrder` (`apps/api/internal/api/orders.go:279-295`) runs `INSERT INTO orders …`. When the table already has an open tab, the partial unique index rejects it (pgcode 23505), the handler maps it to **409 `tab_already_open`** and returns. Correct behavior so far.
2. But that failed INSERT leaves the **request-scoped transaction in an aborted state** (Postgres: any error aborts the tx until rollback).
3. `TxMiddleware` (`apps/api/internal/db/pool.go:135-147`) commits on every status < 500 ("4xx → COMMIT"). Committing an aborted tx makes Postgres silently issue ROLLBACK, and pgx surfaces that as `pgx.ErrTxCommitRollback` = *"commit unexpectedly resulted in rollback"*.
4. The middleware treats any commit error (except `context.Canceled`) as a lost write and fires `alert.Fire(… "http.commit_failed" …)`.

So the alert fires precisely when a handler correctly converts a DB constraint violation into a 4xx. Nothing was lost — the client was already told the request failed. The alert's stated purpose (pool.go comment, lines 139-143) is to catch a **2xx told to the client but rolled back** — that case remains real and must keep alerting.

This affects every handler that maps a constraint error to 4xx, not just OpenOrder: `isUniqueViolation` call sites in `orders.go` (289, 1082), `house_tabs.go` (237, 324), `outlets.go` (148, 237), `shifts.go` (188).

### Fix

In `apps/api/internal/db/pool.go`, in the commit-error branch (line ~138): suppress the alert when **both** (a) the error is `pgx.ErrTxCommitRollback` and (b) the handler already reported failure to the client (`ww.status >= 400`). Keep alerting in every other combination — in particular `ErrTxCommitRollback` with a 2xx/3xx status is exactly the lost-write case the alert exists for.

```go
if err := tx.Commit(ctx); err != nil && !errors.Is(err, context.Canceled) {
    if errors.Is(err, pgx.ErrTxCommitRollback) && ww.status >= 400 {
        // Handler hit a DB error (e.g. unique violation), mapped it to a
        // 4xx, and left the tx aborted — commit-degraded-to-rollback is
        // the expected outcome and the client was already told it failed.
        return
    }
    alert.Fire(ctx, slog.LevelError, "http.commit_failed", err, …)
    return
}
```

(Optionally log the suppressed case at Debug for traceability.)

**Do not** "fix" this by making handlers roll back savepoints around every constraint-checked statement — the middleware-level suppression covers all current and future call sites. One known acceptable side effect: on such 4xx requests, earlier same-tx writes (e.g. `audit.Log` rows) are lost with the rollback; that was already true before this change.

---

## Alerts B & C — `http.5xx` 500s: "membership lookup: context canceled" and "set tenant: timeout: context already done: context canceled" (GET /v1/shifts/current)

### Root cause (confirmed)

Both are the same event at different pipeline stages: the **client disconnected / aborted the request** while it was in flight, so `r.Context()` was canceled, the next DB operation failed with `context.Canceled`, and the middleware mapped it to a 500 + page.

- "membership lookup: context canceled" — `RequireMember` → `loadMemberContextRetrying` (`apps/api/internal/auth/middleware.go:97-108`). The retry helper already correctly declines to retry when `ctx.Err() != nil` (line 226) but the error still falls into the generic 500 branch.
- "set tenant: timeout: context already done: context canceled" — `TxMiddleware` (`apps/api/internal/db/pool.go:118-123`); the "timeout: context already done" wrapper is pgxpool's `Acquire` being handed an already-canceled context.

`GET /v1/shifts/current` is polled by the web/mobile shell, and clients cancel in-flight polls on navigation/refocus/network flap — hence the repetition from one tenant/manager. A canceled client is not a server error; nginx-style convention is status **499**.

Note the codebase already knows this pattern: commit errors from `context.Canceled` are excluded in pool.go:138, and `realtime/hub.go:209` ignores it too. The gap is just the pre-handler middleware error paths and the alert emitter.

### Fix (two layers — do both)

**1. Central suppression in the alert emitter** — `slogRequest` in `apps/api/internal/httpx/router.go:724-742`. Before firing the `http.5xx` alert, check whether the request context was canceled by the client:

```go
case ww.Status() >= 500:
    if errors.Is(r.Context().Err(), context.Canceled) {
        // Client went away mid-request; the 5xx is fallout, not a server
        // fault. Log (warn) but don't page.
        rl.WarnContext(ctx, "http.client_gone", args...)
        break
    }
    rl.ErrorContext(ctx, "http.request", args...)
    … alert …
```

Important: only suppress on `context.Canceled`. A `context.DeadlineExceeded` (server-side timeout) must still page — that's a genuinely slow backend.

**2. Correct status at the two error sites**, so metrics/logs stop counting these as 500s:

- `apps/api/internal/auth/middleware.go` `RequireMember` (~line 102): before writing the 500, if `r.Context().Err() != nil`, respond with `499` and kind `client_closed_request` (or simply return without writing — the client is gone; but writing 499 keeps the status recorder/log line coherent).
- `apps/api/internal/db/pool.go` `TxMiddleware`: same treatment for the three early error paths — `begin tx` (line 108), `set tenant` (line 120), `set user` (line 126).

A tiny shared helper is worth it, e.g. in `respond` or `httpx`:

```go
// ClientGone reports whether the request was aborted by the client.
func ClientGone(ctx context.Context) bool { return errors.Is(ctx.Err(), context.Canceled) }
```

### Explicitly NOT the fix

- Do not blanket-ignore `context.Canceled` errors from DB calls inside handlers regardless of `r.Context()` — always gate on the **request** context being canceled, so an internally created/canceled context can't mask a real bug.
- Do not raise pool timeouts or retry harder; `loadMemberContextRetrying` is already correct.

---

## Verification

From `apps/api` (note the GOROOT quirk: use homebrew Go, not /usr/local/go):

1. `go test ./internal/...` — existing suites in `internal/httpx/middleware_test.go` (there are already tests asserting `http.5xx` fires, lines ~748/815/846 — make sure they still pass) and db pool tests.
2. Add tests:
   - **A:** handler that executes a failing statement in the request tx, writes 409, returns → assert **no** `http.commit_failed` alert. Counter-test: handler whose commit degrades to rollback after writing 200 → alert **must** fire. (Simulate by executing a failing statement, swallowing the error, and writing 200.)
   - **B/C:** request whose context is canceled before/while the middleware runs (cancelable `r.WithContext`) → assert no `http.5xx` alert fires and the log line is `http.client_gone`; counter-test with `context.DeadlineExceeded` still alerts.
3. The two-pool RLS integration harness (`internal/api` tests) should be unaffected — nothing here touches RLS or grants.

## Post-deploy expectations

- `http.commit_failed` volume drops to zero for 4xx statuses; any remaining occurrence is a real lost write — treat as P1.
- `http.5xx` no longer pages for `context canceled`; watch that genuine `/v1/shifts/current` latency (visible as `DeadlineExceeded` or high `dur_ms`) still would. If "client_gone" warns are extremely frequent from one tenant, that's a client-side polling bug worth a separate look (mobile app aborting polls aggressively), not a server incident.

---

## Resolution (shipped 2026-07-19)

All three alerts are addressed exactly as planned above:

- **Alert A** — `TxMiddleware`'s commit branch (`apps/api/internal/db/pool.go`) suppresses the
  `http.commit_failed` alert when the error is `pgx.ErrTxCommitRollback` **and** `ww.status >= 400`
  (logs `http.commit_rolled_back_after_4xx` at debug). A 2xx commit-degraded-to-rollback still pages.
- **Alerts B & C** — added `respond.ClientGone(ctx)` / `respond.StatusClientClosedRequest` (499).
  - `slogRequest` (`internal/httpx/router.go`): client-gone 5xx logs `http.client_gone` at warn instead of paging (only `context.Canceled`; `DeadlineExceeded` still alerts).
  - `TxMiddleware` early paths (begin tx / set tenant / set user) and `RequireMember` (`internal/auth/middleware.go`) return **499** instead of 500 when the client aborted.

**Tests:** `internal/httpx/middleware_test.go` (client-gone 5xx → warn, no alert; `DeadlineExceeded` still alerts) and `internal/db/pool_test.go` (4xx `ErrTxCommitRollback` → no alert; 2xx commit-rollback → alert). Both packages green.
