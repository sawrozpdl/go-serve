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

## Verification gates

- `go test ./... && go vet ./...` green (tenant isolation suite especially)
- `pnpm build` + typecheck clean
- Manual pass at 768/834/1024/1280 both orientations: Floor → Tab → Settle, Expenses, Owners, House Tabs, `/menu/:slug`
- Offline drill: hard reload offline (no /login bounce), >15min offline keeps session, queued ops replay exactly-once, cross-device settle conflict lands in review tray
