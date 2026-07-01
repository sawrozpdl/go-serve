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
| **M2 — POS core + KOT printing** | 🚧 in progress | floor, order-taking, realtime, ESC/POS KOT on send |
| M3 — Settlement & money ops | ⬜ next | settle/payments/discounts + receipt print |
| M4 — Kitchen display (KDS) | ⬜ | ticket board, mark ready |
| M5 — Offline engine & sync review | ⬜ | sqlite queue + replay + reconciliation |
| M6 — Printing polish | ⬜ | discovery, multi-printer, code-page decision |
| M7 — Catalog, tables & inventory | ⬜ | |
| M8 — Finance, shift & analytics | ⬜ | |
| M9 — People, settings & feedback | ⬜ | |
| M10 — Public menu, super-admin, release | ⬜ | Maestro E2E, EAS submit |

Tests: **91 passing** (as of M1). Pure logic (jwt, refresh, tokenStore, permissions,
buildTheme) at ~100%.

---

## M2 checklist (in progress)

- [ ] `mapEventToInvalidations(ev, slug)` extracted to `@cafe-mgmt/api-types` (pure, tested)
- [ ] `useRealtime()` — ws-ticket → connect → invalidate → backoff → poll; AppState reconnect
- [ ] `useConnectivity()` via NetInfo + connectivity banner
- [ ] `packages/receipt-format` — ESC/POS builder + KOT docket (byte-for-byte tests)
- [ ] `src/printing` — tcpPrinter (:9100) + printerConfig (MMKV) + print-on-send hook
- [ ] Data hooks — orders (optimistic add/update/void/send/move/rename), menu, tables, tenant, kitchen
- [ ] Floor screen (FlashList tables + walk-in, tab-state badges)
- [ ] Tab detail (menu browse, line items, notes, void, send + pre-send sheet, move/rename, reprint)
- [ ] Settings → Printing (prefs, device role, printer IP, test print)
- [ ] Tablet split-view (floor list + detail pane) — additive
- [ ] Tests green + coverage gate; commit + push

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
