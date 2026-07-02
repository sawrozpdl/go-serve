# Go Serve — release & store submission (M10)

## Build

```bash
# JS-only change already on a dev/preview build? Ship over the air:
eas update --branch production -m "…"

# Native change (new module / permissions / icon)? Rebuild:
eas build --profile production --platform all
```

`app.config.ts` owns name/slug/scheme/bundle id and the icon/splash. Bump the
user-facing version there; `production` build has `autoIncrement` for the native
build number.

## Submit

```bash
eas submit --profile production --platform android   # → Play internal track (draft)
eas submit --profile production --platform ios       # → App Store Connect
```

Fill in before the first iOS submit:
- `eas.json` → `submit.production.ios.ascAppId` (App Store Connect app id).
- Apple/Google service credentials via `eas credentials`.

## Required env (EXPO_PUBLIC_*, inlined at build)

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
