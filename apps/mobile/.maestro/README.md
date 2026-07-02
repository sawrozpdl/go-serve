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

## Notes / TODO

- Selectors lean on the `accessibilityLabel`s the screens already set
  (`new-walkin`, `add-<name>`, etc.). Keep those stable.
- Planned additional flows (tracked): **offline→sync** (toggle airplane mode,
  add items, reconnect, assert the Sync banner drains) and **print** (needs a
  mock TCP :9100 listener on the runner).
- CI: run against an EAS **preview** build nightly; smoke (`login`) per PR.
