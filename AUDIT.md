# Production-Readiness Audit Backlog

Deep audit (2026-06-10) across UI consistency, security, UX/tablet ergonomics, and
production gaps. Check items off as they land; one commit per workstream.

Verified non-issues (no action): `apps/api/.env` is gitignored and was never
committed; the JWT dev-key fallback is rejected in prod by `config.Load`
(`SESSION_SECRET` ≥ 32 bytes enforced); OTP login uses crypto/rand +
constant-time compare + layered rate limits; refresh-token rotation has replay
detection; staff documents are private with an RBAC-gated proxy. Local `.env`
holds real prod creds (SendGrid/S3/Google) — rotate opportunistically.

## Workstream 1 — Backend security hardening

- [x] Rate-limit `/ws` (`internal/httpx/router.go` ~81) — unthrottled connection DoS vector
- [x] Rate-limit `/me/export` (10/hr) and `DELETE /me` (5/hr) (`router.go` ~200)
- [x] S3 private-by-default: invert `PutOpts.Private` → `Public` (`internal/storage/s3.go:76`); update logo/menu-image call sites
- [x] Explicit `tenant_id` filter on invites list (`internal/api/invites.go:36`) — defense-in-depth atop RLS
- [x] Sanitize 5xx bodies in prod (no `err.Error()` passthrough); slog the real error
- [x] `InvalidateTenantCache(slug)` on suspend/delete (`internal/tenant/middleware.go`); `tokenVersionCacheTTL` 60s → 10s (`internal/auth/session.go:170`)
- [x] Audit log pagination — replace hardcoded `LIMIT 200` with cursor/offset (`internal/api/audit.go`)
- [x] Reject `CORS_ORIGINS=*` in prod at `config.Load`
- [x] QR modal: render SVG via DOM/canvas instead of `dangerouslySetInnerHTML` (`apps/web/src/components/PublicMenuShareModal.tsx:125`)

## Workstream 2 — UX states (errors, loading, undo, focus)

- [x] New `<ErrorState>` (icon + message + retry); add `isError` branch to all ~15 data pages (silent blank panels today, e.g. `ExpensesPage.tsx:73`, `OwnersPage.tsx:146`)
- [x] New `<LoadingState>` spinner; replace `empty-state Loading…` pattern (~15 sites)
- [x] Undo toast (5s) for pre-kitchen line void (`TabPage.tsx:459`) and payment removal (`SettleModal.tsx:397`)
- [x] Replace native `alert()` at `TabPage.tsx:442` with toast/useConfirm
- [x] Focus trap + focus restore in shared `Modal.tsx`
- [x] Per-page `document.title` via `PageShell`
- [x] Dedicated 404 page (replace silent redirect, `App.tsx:124`)
- [x] `ErrorBoundary` around route outlet in `AdminShell` (page crash ≠ app crash)

## Workstream 3 — Tablet & touch (768–1024px)

- [x] 40px min touch targets at ≤1024px: `.btn.icon`, `.line-qty button`, row actions (`admin.css` ~429)
- [x] Persistent icon-rail sidebar (~72px) for tablet landscape instead of off-canvas drawer (`admin.css` ~3789)
- [x] TabPage: keep menu + cart side-by-side down to ~768px landscape (`admin.css` ~3971); note-indicator dot on lines with notes; bigger +/- at tablet widths
- [x] Floor grid 768–1024px rule `minmax(140px, 1fr)` (`admin.css` ~4162)
- [x] Table `overflow-x: auto` extended from ≤720px to ≤1024px (`admin.css` ~4220)
- [x] Explicit `:active` touch feedback on chips / menu cards / floor tiles; verify `[data-tip]` inert under `(hover: none)`
- [x] Settle amount input `scrollIntoView` on focus (`SettleModal.tsx:489`)

## Workstream 4 — Design-token discipline

- [x] Sweep inline literals → tokens (~50 spacing, ~100 color, ~80 font-size). Worst: `OwnersPage`, `ExpensesPage`, `AccountsPage`, `PickWorkspace`, `Login`
- [x] Add `--text-xs/--text-sm/--text-md` font-size tokens to `packages/design-tokens/src/tokens.css`
- [x] Add z-index tokens (`--z-scrim/--z-modal/--z-drawer`); fix OwnersPage drawer (59/60) vs `.scrim` (1000)
- [x] Extract shared `<Drawer>` from OwnersPage inline `<style>`; move `PublicMenuShareModal` CSS string into admin.css with tokens
- [x] Wrap stray label+input pairs in `.field`; errors via `.field-error` + `aria-invalid`
- [x] `width`/`height` attrs on public-menu images for CLS (`MenuPublicPage.tsx:177,211`)

## Workstream 5 — Accessibility & small correctness

- [x] `onKeyDown` Enter/Space on `role="button"` divs (`OwnersPage` owner-card; check `MenuPage`)
- [x] `aria-label` on menu-grid cards ("Add {item}") and floor-tile capacity icons
- [x] `React.memo` on `LineRow` (`TabPage.tsx:635`)
- [x] Currency name from tenant settings instead of hardcoded "Nepalese Rupees (NPR)" (`MenuPublicPage.tsx:256`); VAT/SC checkout note driven by tenant settings (`TabPage.tsx:489,505`)
- [ ] (Future) tenant-configurable discount reasons (`SettleModal.tsx:22`) — deliberate defer

## Workstream 6 — Offline mode / PWA

- [x] **Phase A**: vite-plugin-pwa shell + manifest/icons; TanStack query persistence to IDB (allowlisted keys — no staff/finance data on disk); connectivity store + banner; tri-state `refreshTokens` (network failure ≠ logout); `RequireAuth` offline fix; SW update prompt
- [x] **Phase B**: `AddOrderItems` idempotent via client UUIDs + `ON CONFLICT DO NOTHING`; void returns 204 when already voided; persisted FIFO-per-tab mutation queue; settle/discount/move/cancel blocked offline; pending-sync glyphs
- [x] **Phase C**: SyncReviewTray — failed replays surfaced with Discard / Re-apply, never silently dropped

## Workstream 7 — Observability / alerting

Reusable `internal/alert` package (Slack/webhook `Notifier` + `Fire` one-liner, per-event
throttle) + CloudWatch→SNS backstop (`infra/aws/setup-alerts.sh`). Motivated by the invisible
OTP-send failure. Adding an alert to a swallow site is now one line: `alert.Fire(ctx, level, "event", err, …)`.

- [x] `alert` package + config (`ALERT_WEBHOOK_URL`, `ALERT_THROTTLE`) + wired in `main.go`
- [x] Wired: `otp.send_failed`/`send_panic`/`no_mailer_configured` + OTP rate-limit fail-open; `shift_summary.send_failed`/`panic`
- [x] Custom `recoverer` (structured `http.panic` + stack) replaces chi's stderr dump; single 5xx alert path in `slogRequest`
- [x] CloudWatch metric filters + SNS email alarms (`setup-alerts.sh`)
- [ ] **Second wave** (each a one-line `alert.Fire`): `roles.go` swallowed `audit.Log` (148/201/239) — also make non-silent like other call sites; super `logPlatform` discarded error (`super/tenants.go:493`); legacy `auditEvent` silent insert (`audit_helper.go:14`)
- [ ] S3 orphan-blob cleanup failures (`staff.go:729`, `bugreport.go:124/178`) — currently `_ = store.Delete(...)`
- [ ] WS backpressure client drops (`realtime/hub.go:133`) — live screens silently stop updating
- [ ] `billing.NotifyAttention` no-op needs a scheduled sweep to drive trial-expired / past-due alerts (no caller today)

## Workstream 8 — Money accuracy (2026-07-25)

Deep audit of every money path after a café reported "credit settlement counted
as new sales". The ledger was right; the reporting and labelling were not. Landed
as one commit per phase on `fix-credit-collections-not-sales`.

- [x] **P0 — integrity holes.** `VoidOrderItem` had no order-status guard and
      ignored the `{id}` in its own route, so a line could be voided on a CLOSED
      order (desyncing the frozen total forever) or through another order's URL.
      `CancelOrder` allowed cancelling an order with payments (cash with no sale
      behind it). `DeletePayment` worked across a closed shift, invalidating a
      signed-off reconciliation. `DeleteStaffPay` soft-deleted payroll BEFORE a
      reversal that legitimately 409s — and the tx layer commits on 4xx, so the
      refusal committed a half-reversal. Credit settlements were INSERT-only with
      `amount > 0`, so a mis-entry could never be corrected (migration 0054 adds
      reversal rows + `FOR UPDATE`; `RecordPayment`/`CloseOrder` take the same
      lock so concurrent settles can't overpay an order into an unclosable
      state). `owner_ledger` corrections were a no-op for investments/payouts and
      *inverted* for repayments (5 queries missing `is_correction`).
      `paid_from='owner'` expenses debited a cafe account that never paid out
      while also booking a loan. Transfer fees left the drawer and the cash
      bucket disagreeing.
- [x] **P1 — CI actually runs the money tests.** The workflow had no Postgres, so
      ~1250 integration tests skipped and CI was green while asserting nothing.
      `REQUIRE_DB=1` now makes a skipped DB suite a hard failure.
- [x] **P2 — one revenue basis.** Profit is computed on NET REVENUE
      (`total − VAT`, net of discounts, service charge included). The old item
      basis survives as `item_sales_cents`, labelled "menu item sales". Per
      category, each order's discount/service/VAT is allocated with
      largest-remainder so rows sum EXACTLY. `internal/api/money.go` holds the
      vocabulary and the primitives.
- [x] **P3 — one window convention.** Shift summary mixed populations (sales by
      `closed_at`, on-tab by `shift_id`) and could report negative "Received";
      heatmap bucketed `opened_at` while filtering `closed_at`; table mix dropped
      take-away and retired-table revenue; `ListExpenses` windowed in the
      DATABASE's timezone (invisible in dev, wrong in prod); `qty_30d` was
      all-time; `range=all` was clamped to 14 days. Migration 0055 indexes the
      sales window (13 vs 1386 buffers at 60k orders).
      **Found here:** `buildShiftSummary` still selected `tenant_members.role`,
      removed by migration 0019 — so shift-close emails had been silently dead
      for every tenant, hidden by a savepoint + warning log.
- [x] **P4 — invariants, in CI and on production.** `money_invariants_test.go`
      asserts that handlers AGREE (sales across three endpoints, category net
      revenue summing exactly, accounts vs cafe balance, drawer vs expected cash,
      reversal symmetry, local-midnight boundaries). It immediately caught the
      Accounts bank card disagreeing with the Balance bank tile by every
      owner-cash deposit — five copied formulas are now one `loadAccountBucket`.
      `GET /super/accuracy-check` (migration 0056) runs nine row-level identities
      against live rows.
- [x] **P5 — one vocabulary, arithmetic shown inline.** `<FormulaHint>` renders
      the actual sum behind a figure with the tenant's own numbers (and shouts if
      the terms don't add up to it). New explainers for the whole shift/drawer and
      accounts domains. Fixed labels: Profitability's "Sales"/"Revenue" for one
      value and `COGS (allocated)` for direct+allocated, Owners' double-counted
      "Net profit (lifetime)", Dashboard's "Tax collected" that included service
      charge, the Accounts drawer-vs-ledger duality. Dashboard gained a
      reconciliation strip where the day's money visibly adds up.

### Deliberately deferred

- **DB CHECK constraints** for `payments.method='house_tab' ⇒ house_tab_id`,
  `method='cash' ⇒ shift_id`, and `house_tab_settlements.payment_method <>
  'house_tab'`. The handlers enforce all three; `/super/accuracy-check` catches
  any row that gets in another way. Adding the constraints needs a data audit of
  legacy rows first — the check reports exactly which.
- **`shift_id IS NULL` cash settlements** still enter the cash ledger but no
  drawer count (`computeDrawer` filters on the open shift). Not "fixed" on
  purpose: after a close the drawer falls back to `closing_count_cents`, so
  adding uncounted inflows would corrupt the variance baseline. The check surfaces
  them; the dev database has two such rows (Rs 56) from seeded history.
- **`owner_ledger.is_opening`** is read by the bank roll-up but written by
  nothing since the go-live wizard was removed — dead filter, harmless.
- **Mobile balance screen.** Mobile still has no cash-position screen, so the
  drawer/bank/online/owner-cash view remains web-only.
- **`OrderHistoryPage`'s inline summary reducer** is still not extracted for unit
  testing (its mobile twin `summarizeHistory` is tested).

## Verification gates

- `go test ./... && go vet ./...` green (tenant isolation suite especially)
- `pnpm build` + typecheck clean
- Manual pass at 768/834/1024/1280 both orientations: Floor → Tab → Settle, Expenses, Owners, House Tabs, `/menu/:slug`
- Offline drill: hard reload offline (no /login bounce), >15min offline keeps session, queued ops replay exactly-once, cross-device settle conflict lands in review tray
