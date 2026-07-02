# Go Serve — release & store submission (M10)

## Versioning

```bash
pnpm --filter @cafe-mgmt/mobile version:bump patch   # or minor / major
```

Bumps `apps/mobile/package.json` (`app.config.ts` reads `version` from there).
Android `versionCode` / iOS `buildNumber` are never touched by hand — `eas.json`
sets `appVersionSource: "remote"` and the `production` profile has
`autoIncrement`, so EAS assigns those on every build.

`runtimeVersion` uses the `appVersion` policy: the OTA runtime version *is*
the semver string above. Practically:

- **JS/asset-only change**: no version bump needed. `eas update` targets the
  current version's runtime and reaches every installed build on that version,
  no rebuild required.
- **Native change** (new module, config-plugin, permission, SDK bump): bump
  the version *and* rebuild. The version bump changes the runtime version, so
  the new binary and any updates published against it are correctly isolated
  from older installs.

## Build

```bash
# JS-only change already on a dev/preview build? Ship over the air:
pnpm --filter @cafe-mgmt/mobile update:production -- -m "…"
#   ↳ equivalently:  eas update --branch production -m "…"

# Native change (new module / permissions / icon)? Rebuild — produces a
# direct-install production APK (not a Play Store AAB):
pnpm --filter @cafe-mgmt/mobile build:apk
#   ↳ equivalently:  eas build --profile production --platform android
```

`app.config.ts` owns name/slug/scheme/bundle id and the icon/splash.

## Submit (dormant — not in use)

We currently distribute the production build as a direct-install APK, not
through the Play Store, so `submit.production` in `eas.json` is left
scaffolded but unused. The `production` build profile now emits an APK
(`android.buildType: "apk"`), which Play Store production tracks don't accept
— if store submission is revisited later, add a separate AAB profile and fill
in the placeholders below first:

```bash
eas submit --profile production --platform android   # → Play internal track (draft)
eas submit --profile production --platform ios       # → App Store Connect
```

- `eas.json` → `submit.production.ios.ascAppId` (App Store Connect app id).
- Apple/Google service credentials via `eas credentials`.

## Required env (EXPO_PUBLIC_*, inlined at build)

`EXPO_PUBLIC_*` vars are inlined into the JS bundle at build time, so EAS
Build needs them set per environment via the EAS dashboard / `eas env:create`
(the `development`/`preview`/`production` environments match the build
profiles' `channel` names) — a local `.env` only covers `expo start`/local
builds, not cloud builds.

- `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_WS_BASE_URL`
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (+ `_IOS_CLIENT_ID` / `_IOS_URL_SCHEME` for iOS)
- `EXPO_PUBLIC_PUBLIC_MENU_BASE_URL` (public /menu/:slug origin; falls back to the API origin)

## Pre-release QA checklist

- [ ] Login: email OTP + native Google on a real device (both platforms).
- [ ] Core loop: open tab → add/edit/void → send to kitchen → settle (cash /
      online / house-tab / split) → close; balance + floor update.
- [ ] KDS: ticket appears on send; mark ready/served syncs across two devices.
- [ ] Offline: airplane mode → add items → reconnect → Sync banner drains; no
      duplicate lines. Rejected op lands in Sync Review.
- [ ] Printing: KOT on send + receipt on close to a real LAN thermal printer;
      Wi-Fi scan finds it. **Validate the code-page** with a Nepali item name
      (ASCII/CP437 "Rs." fallback — decide if raster is needed — Risk #2).
- [ ] Catalog/finance/team/settings/feedback CRUD round-trips.
- [ ] Safe-area on a notch + a punch-hole device: sticky headers, bottom bars,
      sheets, and the offline banner clear the insets.
- [ ] Accessibility: interactive controls have labels; text scales; reduced
      motion respected.

## Known deferrals carried into release

See `ROADMAP.md` "follow-ups" — audible KDS chime + printer self-IP autodetect
need a rebuild (batch together); deep finance ledgers, staff/scheduling, RBAC
editor, advanced analytics, and image upload / bulk import live on web for now.
