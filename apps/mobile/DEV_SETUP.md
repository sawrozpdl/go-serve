# Go Serve — mobile dev setup (macOS + Android phone)

This is a **custom Expo dev client** (SDK 57). You build the dev app **once** with
all the native modules baked in, install it on your phone, then iterate on JS
forever — Metro hot-reloads changes and you only rebuild when a **new native
module** is added.

## 0. Prerequisites (already installed on this Mac ✅)

- Node 20, pnpm 9 (repo uses `pnpm@9.12.0`)
- JDK 17 (`java -version` → 17)
- Android SDK at `~/Library/Android/sdk` (`ANDROID_HOME` set), `adb` on PATH
- Xcode 16 (only needed if you also want to run on iOS)

If a new shell can't find `adb`, add to `~/.zshrc`:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
```

## 1. Put your Android phone in developer mode (one time)

1. Settings → About phone → tap **Build number** 7×.
2. Settings → System → Developer options → enable **USB debugging**.
3. Plug the phone into the Mac with a USB-data cable.
4. On the phone, accept the "Allow USB debugging?" prompt.
5. Confirm the Mac sees it:

```sh
adb devices          # should list your device as "device" (not "unauthorized")
```

## 2. Install the dev client on your phone (one time, + after native changes)

We build a debug APK that is your reusable **Go Serve (dev)** app.

**Option A — build + install in one step (phone connected):**

```sh
cd apps/mobile
npx expo run:android           # prebuilds, compiles, installs to the phone
```

**Option B — install a pre-built APK** (if the APK was already compiled):

```sh
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Either way you end up with a **Go Serve** icon on the phone. That app is the dev
client — it does not contain your JS; it loads it live from Metro.

> First build downloads Gradle + compiles native code (~10–20 min). Later builds
> are incremental and much faster.

## 3. Daily workflow (no rebuild needed)

```sh
# from the repo root
pnpm --filter @cafe-mgmt/mobile dev
#   ↳ equivalently:  cd apps/mobile && npx expo start --dev-client
```

- Keep the phone on the **same Wi-Fi** as the Mac (or connected via USB).
- Open the **Go Serve** app on the phone → it connects to Metro and loads the JS.
- Edit code → it hot-reloads. Shake the phone (or `m` in the Metro terminal) for
  the dev menu.

USB-only (no shared Wi-Fi)? Forward Metro over the cable:

```sh
adb reverse tcp:8081 tcp:8081     # Metro's default port
```

## 4. Talking to the backend API (needed from M1 onward)

The Go API runs on your Mac at **:8081**. On the phone, `localhost` is the phone,
so point the app at the Mac. Copy the env template and edit:

```sh
cd apps/mobile && cp .env.example .env
```

Pick one:

- **Same Wi-Fi (simplest):** set `EXPO_PUBLIC_API_BASE_URL=http://<mac-lan-ip>:8081`
  and `EXPO_PUBLIC_WS_BASE_URL=ws://<mac-lan-ip>:8081`. Find the IP with
  `ipconfig getifaddr en0`. The API must bind `0.0.0.0` (not just localhost).
- **USB:** `adb reverse tcp:8081 tcp:8081` and keep `localhost:8081`. ⚠️ Metro also
  defaults to 8081 — run Metro on another port so they don't clash:
  `npx expo start --dev-client --port 8082`.

Restart Metro after editing `.env` (env vars are inlined at bundle time).

## 5. When do I have to rebuild the dev client?

- **JS/TS, components, screens, styles, most Expo config** → no rebuild, just reload.
- **A new native module / config-plugin / native permission** → rebuild (step 2).
  We front-loaded every native module we expect to need (printing, secure storage,
  SQLite, camera/image picker, notifications, charts SVG, haptics, bottom sheet,
  netinfo, crypto), so this should be rare.

## 6. iOS (optional, Xcode is installed)

```sh
cd apps/mobile && npx expo run:ios          # simulator
```

A physical iPhone dev build needs an Apple developer signing identity (free
personal team works for on-device dev builds).

## 7. Cloud builds (optional, no local toolchain needed)

`eas.json` defines `development` / `preview` / `production` profiles. To build in
Expo's cloud (produces an installable APK link):

```sh
cd apps/mobile
eas login                                   # your Expo account (run as: ! eas login)
eas build --profile development --platform android
```

## Handy commands

```sh
pnpm --filter @cafe-mgmt/mobile typecheck   # tsc --noEmit
pnpm --filter @cafe-mgmt/mobile test        # jest
pnpm --filter @cafe-mgmt/mobile lint        # eslint
npx expo-doctor                             # dependency/config sanity (run in apps/mobile)
```
