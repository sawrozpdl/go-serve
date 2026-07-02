# Go Serve mobile — roadmap & status

Living status board for the React Native app. Full plan lives in
`~/.claude/plans/we-need-to-now-mellow-kite.md`; this file is the at-a-glance
tracker updated at the end of every milestone.

**Conventions**
- Commit + push to `main` on every milestone clear (typecheck + lint + tests green).
- Every screen is built with the `frontend-design` skill — native gestures, bottom
  sheets, haptics, spring transitions, empty/loading/error states, safe-area correct.
- Business logic is pure + unit-tested to ~100%; screens covered via RNTL + MSW.

**Run it**
- Dev: `pnpm --filter @cafe-mgmt/mobile dev` → open Go Serve on device (`--clear`
  after `.env` edits). Full setup: `DEV_SETUP.md`. Google: `GOOGLE_SIGNIN_SETUP.md`.
- Dev-client APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`
  (rebuild only when a **new native module** is added).

---

## Status

| Milestone | Status | Notes |
|---|---|---|
| M0 — Foundations & shared packages | ✅ done | monorepo wiring, theme, MMKV, jest-expo harness, api-types, design-tokens JS |
| M1 — Auth, workspace & nav shell | ✅ done | OTP + native Google, refresh state machine, RBAC tabs, fonts + login redesign |
| **M2 — POS core + KOT printing** | ✅ done | floor, order-taking, realtime, ESC/POS KOT on send |
| **M2.1 — POS polish & UX** | ✅ done | Lucide icons, elevation/depth, Sheet (safe-area), two-row categories, selected-count badges, sticky floor bar, icon actions, auto-open menu, printing gated by tenant:update |
| **M3 — Settlement & money ops** | ✅ done | settle sheet (cash/online/house-tab splits), discounts/adjustments, reclassify, close; offline-guarded; customer receipt print on close |
| **M4 — Kitchen display (KDS)** | ✅ done | live ticket board (In progress / Ready segments), mark ready/served, urgency tiers, new-order haptic alert, WS-synced |
| **M5 — Offline engine & sync review** | ✅ done | MMKV-persisted queue, FIFO-per-order replay, needs-review tray, offline banner, per-line "not synced" hint; idempotent ops (no reconciliation needed) |
| **M6 — Printing polish** | ✅ done | LAN /24 discovery (bounded concurrency) + assign to kitchen/receipt, reachability probe, code-page decision locked (ASCII/CP437 "Rs.") |
| **M7 — Catalog, tables & inventory** | ✅ done | menu categories/items CRUD (price/cost/icon/kitchen-routing/featured), tables CRUD, inventory CRUD + stock adjust w/ low-stock flags; icon picker |
| **M8 — Finance, shift & analytics** | ✅ done | cash drawer (open/close w/ variance, cash drops), expenses (record + list), dashboard (KPIs + payment-mix bar + SVG sales chart). Deep ledgers → follow-up |
| M9 — People, settings & feedback | ⬜ next | |
| M10 — Public menu, super-admin, release | ⬜ | Maestro E2E, EAS submit |

Tests: **223 passing** (as of M8). Pure logic (jwt, refresh, tokenStore, permissions,
buildTheme + hexToRgba + mixHex, mapEventToInvalidations, ESC/POS KOT + receipt builders,
computeReceiptTotals, KOT gate/selection, shouldPrintReceipt, recomputeOrderDerived,
kitchen board: partition/elapsed/new-ticket/urgency) at 100%; settle/house-tab data
hooks integration-tested (fetch-mock); screens verified via typecheck + smoke + dev-client.

---

## M2 checklist (done)

- [x] `mapEventToInvalidations(ev, slug)` in `@cafe-mgmt/api-types` (pure, tested)
- [x] `useRealtime()` — ws-ticket → connect → invalidate → backoff → poll; AppState reconnect
- [x] `useConnectivity()` via NetInfo
- [x] `packages/receipt-format` — ESC/POS builder + KOT docket (byte-for-byte tests)
- [x] `src/printing` — tcpPrinter (:9100) + printerConfig (MMKV) + print-on-send + test slip
- [x] Data hooks — orders (optimistic add/update/void/send/move/rename), menu, tables, tenant, kitchen
- [x] Floor screen (table grid + walk-ins, tab-state badges, pull-to-refresh)
- [x] Tab detail (menu sheet, line items, notes, void, send + pre-send sheet, reprint, rename)
- [x] Settings → Printing (prefs, device role, printer IP, test print)
- [x] Toasts host; tests green + coverage gate; committed + pushed

### M2 / M2.1 follow-ups (deferred, tracked)
- Tab **move/merge** modal (hook `useMoveOrder` exists; UI not built yet).
- **Tablet split-view** (floor list + persistent detail pane) — still phone-only.
- Swap the RN-`Modal` `Sheet` for `@gorhom/bottom-sheet` (gesture-draggable) — the
  current Sheet is safe-area correct with a grabber + cancel, but not drag-to-dismiss.
- Raise integration (MSW) coverage on data hooks + screens.
- Validate KOT on a real thermal printer (code-page / item-name script — Risk #2).
- Icon fidelity: mobile mirrors web's 54-name Lucide registry; if web adds names,
  update `src/components/ui/Icon.tsx` to match.

---

## M3 checklist (done)

- [x] `computeReceiptTotals(quote)` in `@cafe-mgmt/receipt-format` — all VAT-mode ×
  discount × service combos, byte-tested (100%)
- [x] `buildReceiptCommands` (customer receipt, WITH prices) + `formatReceiptMoney` +
  `trimPct` + payment labels in `@cafe-mgmt/receipt-format`
- [x] Money hooks `src/api/settle.ts` — payments (record/delete/reclassify),
  adjustments (apply/remove), close; `src/api/houseTabs.ts`
- [x] `SettleSheet` — totals breakdown, payment list, discount form, cash/online/
  house-tab tenders, partial payments/splits, close gated on `balance === 0`
- [x] Offline guard — all money actions disabled when `mode === 'offline'`
- [x] Receipt print on close — `shouldPrintReceipt(prefs, role)` + snapshot BEFORE
  close; Settings → Printing gains receipt toggle, header/footer, receipt device
  role + separate receipt printer IP:port
- [x] Settle wired into tab detail (Send when pending, else Settle; `order:settle` gated)
- [x] Integration tests for settle + house-tab hooks (fetch-mock); coverage gate green

### M3 follow-ups (deferred, tracked)
- **Card** as a distinct tender (backend uses cash/online/bank; mobile exposes
  cash/online/house-tab — matches the consolidated money-flow decision).
- Adjustment UI is discount-only in the sheet; other `AdjustmentType`s via hook only.
- Validate the receipt on a real thermal printer (code-page / ₹ — Risk #2, M6).

---

## M4 checklist (done)

- [x] `src/kitchen/board.ts` pure logic (100%): `partitionTickets`, `elapsedLabel`,
  `findNewInProgress` (new-ticket alert), `ticketUrgency` (fresh/warn/urgent tiers)
- [x] Kitchen screen — `FlashList` board, In progress / Ready segmented toggle with
  live counts, pull-to-refresh, empty states, loading state
- [x] Ticket card — table label, elapsed time (urgency-coloured), qty×name,
  modifiers + notes, urgency left-accent, full-width mark-ready / mark-served
- [x] `useUpdateKitchenTicket` mark ready → served; WS `kitchen` topic already
  invalidates `['kitchen-tickets']` at the app root → syncs across devices
- [x] New-order **haptic alert** + per-device toggle (`useKitchenPrefs`, MMKV);
  `kitchen:update` gates the action buttons (waiters see the queue, can't act)

---

## M5 checklist (done)

- [x] `src/offline/queue.ts` — MMKV-persisted queue + pure reducers (100%):
  addOp/removeOpFrom/setStatusIn/opsForOrder/needsReviewOps/replayableOps/
  queuedLineIds/groupByOrder
- [x] `src/offline/replay.ts` — runReplay (FIFO per order, halt-chain on failure,
  classifyFailure 0/5xx→retry · 4xx→needs_review) + execQueuedOp; logic 100%
- [x] `useOfflineReplay` — drain on connectivity-return / startup / 30s sweep
- [x] Order hooks enqueue when offline (add/update/void/send) + skip invalidation;
  new-tab creation blocked offline; offline send counts BEFORE optimistic flip
- [x] OfflineBanner (offline / syncing / needs-review) + Sync Review tray
  (retry/discard) under More w/ badge; per-line "not synced" hint
- [x] Integration test: offline mutations enqueue + don't fetch
- **Decision:** MMKV-persisted queue over expo-sqlite — ops are tiny + idempotent
  (client line ids + ON CONFLICT; replay-safe void/send), so a double replay after
  an app-kill is harmless. No transactional storage / fetch-and-diff needed.

## M6 checklist (done)

- [x] `src/printing/discovery.ts` — deriveScanBase/normalizeBase/candidateHosts
  (/24) + mapWithConcurrency (bounded pool) + scanForPrinters; IP math + pool 100%
- [x] `probePrinter(host, port)` reachability in tcpPrinter
- [x] Settings→Printing: "Find printers on Wi-Fi" scan (live results) → assign a
  found IP to the kitchen or receipt printer; multi-printer routing already split
- [x] Retry path: manual Reprint (KOT) + clear "could not reach printer" toasts
- **Code-page decision LOCKED:** default to CP437/ASCII with "Rs." (encodeText
  folds typographic chars, drops non-ASCII to `?`) — works on every thermal
  printer, no raster complexity. Devanagari item-name receipts via `GS v 0`
  raster is a documented future enhancement, only if a café needs Nepali script.

### M6 follow-ups (deferred, tracked)
- Device self-IP autodetect for the scan base needs `expo-network` → dev-client
  rebuild (batch with the M4 audio module). Today the base seeds from a
  configured printer IP or a typed range.
- Auto-retry queue for failed print jobs (today: manual Reprint + toast).

---

## M7 checklist (done)

- [x] `src/catalog/money.ts` — parsePriceToCents / centsToPriceInput (100%)
- [x] Menu manager (`more/menu.tsx`) — categories + items CRUD via bottom-sheet
  forms; item fields: name, category, price, cost, icon, kitchen routing,
  description, available, featured; delete with confirm
- [x] `src/api/menuAdmin.ts` — category + item create/update/delete (invalidates
  menu + popular)
- [x] Tables manager (`more/tables.tsx`) — CRUD (name, seats, area, icon) +
  `useCreate/Update/DeleteServiceTable`
- [x] Inventory manager (`more/inventory.tsx`) — item CRUD + stock adjust (add/
  remove × reason, optional unit cost), low-stock flag; `src/api/inventory.ts`
- [x] Shared `IconPickerField` (registry grid) + `Field` (ToggleRow/SegmentedField);
  Catalog section in More, per-permission gated

---

## M8 checklist (done)

- [x] `src/finance/calc.ts` (100%): cashVariance, varianceTone, paymentMixPercents
  (largest-remainder → sums to 100), barGeometry (SVG bar layout)
- [x] Cash drawer (`more/shift.tsx`) — live drawer (float / cash in / out /
  expected), open shift, close with counted-cash **variance preview**, cash
  drops list + record; `src/api/shift.ts`
- [x] Expenses (`more/expenses.tsx`) — recent list + quick add (amount, category,
  paid-from, vendor, note); `src/api/expenses.ts`
- [x] Dashboard (`more/dashboard.tsx`) — range picker, KPI cards, payment-mix
  bar, daily-sales SVG bar chart (react-native-svg, no chart lib), top sellers;
  `src/api/reports.ts` (60s refetch)
- [x] Finance section in More (perm-gated); finance hooks integration-tested

### M8 follow-ups (deferred, tracked)
- **Deep finance ledgers** — accounts + transfers, owners/equity/investments/
  payouts/loans, owner-cash custody, house-tabs ledger view. Admin-heavy; better
  on web for now (endpoints exist).
- **Advanced analytics** — hourly / heatmap / category-mix / velocity / top-
  sellers page / profitability drill-down (plan-gated `advAnalytics`).
- **Expense edit/delete + owner-funded sources** (need an owner picker); expense
  categories CRUD; expense receipt image.
- Live WS `finance`-topic refresh of the drawer (today: pull-to-refresh + the
  dashboard's 60s poll).

---

## M7 follow-ups (deferred, tracked)
- **Image upload** (item/category photos via `/v1/menu/images`) — needs a
  multipart FormData upload from `expo-image-picker` (installed); not yet wired.
- **Bulk menu import** (paste ChatGPT JSON → NEW/UPDATE/SKIP preview) — the
  `/v1/menu/import` endpoint + `BulkImportPayload` exist; big stepped modal TBD.
- **Inventory pack-rules + menu-item links** (`/pack-rules`, `/inventory-link`) —
  endpoints exist; advanced, deferred.
- Category reorder (drag sort) — sort is respected on read, no editor yet.

---

## M4 follow-ups (deferred, tracked)
- **Audible chime** on new tickets — needs a native audio module (`expo-audio`) →
  dev-client rebuild. M4 ships a haptic buzz (no rebuild); batch the audio module
  into the next rebuild (with M6 printing polish).
- On-device visual QA pending a re-login (the dev session logged out mid-testing).
- Tablet two-column board (both In progress + Ready side by side) — phone shows one
  segment at a time; tablet split is the deferred Risk #1 track.

---

## Known follow-ups / deferred

- **Offline queue + replay + Sync Review Tray** → M5 (M2 uses optimistic + online;
  client UUIDs already in place so replay is drop-in).
- **Customer receipt printing** ✅ (M3). **Printer discovery / multi-printer /
  code-page** → M6.
- **Google Sign-In end-to-end** needs the backend redeploy (`/auth/google/native`) +
  the Android/iOS OAuth clients — see `GOOGLE_SIGNIN_SETUP.md`.
- **Backend `client_op_id` dedupe column** — optional, strengthens offline replay (Risk #6).
- **Devanagari/₹ on thermal printers** — validate code-page on real hardware (Risk #2).
