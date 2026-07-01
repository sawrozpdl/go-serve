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
| M3 — Settlement & money ops | ⬜ next | settle/payments/discounts + receipt print |
| M4 — Kitchen display (KDS) | ⬜ | ticket board, mark ready |
| M5 — Offline engine & sync review | ⬜ | sqlite queue + replay + reconciliation |
| M6 — Printing polish | ⬜ | discovery, multi-printer, code-page decision |
| M7 — Catalog, tables & inventory | ⬜ | |
| M8 — Finance, shift & analytics | ⬜ | |
| M9 — People, settings & feedback | ⬜ | |
| M10 — Public menu, super-admin, release | ⬜ | Maestro E2E, EAS submit |

Tests: **121 passing** (as of M2.1). Pure logic (jwt, refresh, tokenStore, permissions,
buildTheme + hexToRgba, mapEventToInvalidations, ESC/POS builder, KOT gate/selection,
recomputeOrderDerived) at ~100%; screens verified via typecheck + smoke + dev-client.

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

## Known follow-ups / deferred

- **Offline queue + replay + Sync Review Tray** → M5 (M2 uses optimistic + online;
  client UUIDs already in place so replay is drop-in).
- **Customer receipt printing** → M3 (KOT is M2). **Printer discovery / multi-printer /
  code-page** → M6.
- **Google Sign-In end-to-end** needs the backend redeploy (`/auth/google/native`) +
  the Android/iOS OAuth clients — see `GOOGLE_SIGNIN_SETUP.md`.
- **Backend `client_op_id` dedupe column** — optional, strengthens offline replay (Risk #6).
- **Devanagari/₹ on thermal printers** — validate code-page on real hardware (Risk #2).
