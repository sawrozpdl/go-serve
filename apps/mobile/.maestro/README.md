# Maestro E2E flows (M10)

Declarative end-to-end flows for Go Serve. Maestro drives the real app on a
device/emulator against a running API.

## Run

```bash
# Install: https://maestro.mobile.dev  (curl -fsSL https://get.maestro.mobile.dev | bash)
maestro test .maestro/login.yaml
maestro test .maestro/place-and-settle.yaml
maestro test .maestro/            # all flows
```

## Flows

- **login.yaml** — app launches, email-OTP entry is reachable. Full OTP verify
  needs a test inbox or a fixed dev code (parameterize via env in CI).
- **place-and-settle.yaml** — the core money loop: open walk-in → add item →
  send to kitchen → settle cash → back to floor. Needs an authenticated session
  + ≥1 active menu item.
- **credit-collect-and-reverse.yaml** — collect against a credit account, then
  reverse it (reason required). The reported bug was "collecting credit is
  counted as new sales", so this walks that path on the phone and leaves the data
  where it started. Needs a credit account with a balance — `make seed` makes
  several.
- **shift-open-count-close.yaml** — open the drawer, take a cash sale, count it
  SHORT, close. Asserts the variance is stated together with what it is measured
  against, rather than absorbed. Needs no shift already open (`midshift-cafe` has
  one on purpose — use a different cafe).
- **money-figures.yaml** — the read-only money screens use one vocabulary:
  "Credit collected" is never "Sales", the drawer says what it is measured
  against. Wording only; the arithmetic is asserted in `apps/api/test/e2e` and
  `apps/web/e2e/money`.

## Status

The three money flows above are written against the labels the screens set today
and have NOT been executed — no emulator was available when they were added. Treat
the first run as part of writing them: selector drift is likely, the assertions
are not. Their arithmetic counterparts DO run:
`make e2e-api` (Go, over HTTP) and
`pnpm --filter @cafe-mgmt/web test:e2e:money` (browser).

## Notes / TODO

- Selectors lean on the `accessibilityLabel`s the screens already set
  (`new-walkin`, `add-<name>`, etc.). Keep those stable.
- Planned additional flows (tracked): **offline→sync** (toggle airplane mode,
  add items, reconnect, assert the Sync banner drains) and **print** (needs a
  mock TCP :9100 listener on the runner).
- Maestro can assert what is on screen but cannot capture a figure and compare it
  later, so "Sales did not change" is checked in the API/browser suites and only
  walked here.
- CI: run against an EAS **preview** build nightly; smoke (`login`) per PR.
