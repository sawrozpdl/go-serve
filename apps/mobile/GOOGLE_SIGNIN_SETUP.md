# Google Sign-In setup (native) — Go Serve

The app signs in with the **native** Google flow (system account picker), not a
web popup. That needs **three OAuth client IDs** in Google Cloud, wired to the
backend and the app.

```
 Phone ──native sign-in──▶ Google ──ID token──▶ App
   App ──POST /auth/google/native { id_token }──▶ Go API
   Go API verifies the ID token's audience is one of {web, android, ios} → issues our tokens
```

## 1. Google Cloud Console — create 3 OAuth client IDs

APIs & Services → **Credentials** → *Create credentials → OAuth client ID*.
(Configure the OAuth **consent screen** first if you haven't — External, add your
email as a test user while unpublished.)

| # | Application type | Fields to enter |
|---|---|---|
| **Web** | Web application | Authorized redirect URI = `https://goserve.sarojpaudyal.com.np/auth/google/callback` (for the existing web browser flow). This client ID also acts as the **server client ID** for the mobile app. |
| **Android** | Android | Package name: `com.goserve.app` · SHA-1: **`5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`** (debug build — see §4 for production) |
| **iOS** | iOS | Bundle ID: `com.goserve.app` |

## 2. Backend env (`apps/api/.env`, then restart/redeploy the API)

```sh
GOOGLE_OAUTH_CLIENT_ID=<WEB client ID>
GOOGLE_OAUTH_CLIENT_SECRET=<WEB client secret>
GOOGLE_OAUTH_REDIRECT_URL=https://goserve.sarojpaudyal.com.np/auth/google/callback
GOOGLE_OAUTH_CLIENT_ID_ANDROID=<ANDROID client ID>
GOOGLE_OAUTH_CLIENT_ID_IOS=<IOS client ID>
```

The API accepts an ID token whose audience is **any** of these three. Deploy the
updated `apps/api` (it has the new `POST /auth/google/native` endpoint).

## 3. Mobile env (`apps/mobile/.env`, then restart Metro `--clear`)

```sh
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<WEB client ID>       # required (Android + iOS use this as server id)
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<IOS client ID>       # iOS only
EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME=<reversed IOS client ID>   # iOS only, e.g. com.googleusercontent.apps.123-abc
```

> Android needs **no** client ID in the app — Google matches it by package name
> + SHA-1. Only the WEB client ID is required for Android to return an ID token.

## 4. SHA-1 fingerprints

- **Debug / local dev builds** (`expo run:android`): the value in the table above
  (Expo's bundled debug keystore). Re-extract any time with:
  ```sh
  keytool -list -v -keystore apps/mobile/android/app/debug.keystore \
    -alias androiddebugkey -storepass android -keypass android | grep SHA1
  ```
- **Production / EAS builds**: EAS manages a separate upload keystore, shared
  across all `production*` build profiles (`production` APK and `production-play`
  AAB both sign with this same keystore). Its SHA-1 is:
  **`10:E8:31:89:58:71:1C:9C:12:8B:28:A3:01:AD:EB:C0:8C:A0:34:3F`**
  (extracted from the signed `production-play` AAB's `META-INF/*.RSA`; re-derive
  any time with `eas credentials` → Android → keystore → SHA-1/SHA-256, or by
  unzipping a signed build and running
  `openssl pkcs7 -inform DER -in META-INF/*.RSA -print_certs | openssl x509 -noout -fingerprint -sha1`).
  Add it as a **second** Android OAuth client (do not delete the debug one above).

- **Play Store installs** — ⚠️ **required, and easy to miss.** Play App Signing
  **re-signs the uploaded AAB with Google's own key**, so an app installed from
  Play does *not* carry the upload keystore's SHA-1 above. Without a matching
  OAuth client, native sign-in on every Play install fails with
  `DEVELOPER_ERROR` — the button appears to do nothing. (This is what got the
  first submission rejected under Play's *Broken Functionality* policy.)

  Register it as a **third** Android OAuth client (keep the debug and upload
  ones):

  1. Play Console → your app → **Test and release → Setup → App signing**.
  2. Copy the **App signing key certificate**'s SHA-1 (*not* the "Upload key
     certificate" one right below it — that's the `10:E8:31:…` value above).
  3. Google Cloud Console → Credentials → *Create credentials → OAuth client ID*
     → Android, package `com.goserve.app`, paste that SHA-1.
  4. Allow a few minutes to propagate, then verify on a device that installed
     the app **from Play** (an internal-testing install counts) — a sideloaded
     AAB/APK is signed with the upload key and will not exercise this path.

  Email OTP login does not depend on any of this and works on every build; it is
  deliberately the always-available fallback on the login screen.

## 5. Rebuild + run

Adding the native module requires a **new dev build** (JS-only reloads won't pick
up native code):

```sh
cd apps/mobile
npx expo run:android          # with your phone connected — builds + installs
# then, day to day:
npx expo start --dev-client --clear
```

The **Continue with Google** button already appears (server reports
`google_enabled: true`). Once the client IDs above are set and the API is
redeployed, tapping it opens the native Google picker and signs you in.

## Troubleshooting
- **DEVELOPER_ERROR on Android** → the SHA-1 + package name in the Android OAuth
  client don't match the keystore that signed the running build. Re-check §4.
- **audience_mismatch from the API** → `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (app)
  and `GOOGLE_OAUTH_CLIENT_ID`/`_ANDROID`/`_IOS` (backend) are inconsistent.
- **Nothing happens / no ID token** → confirm `webClientId` is set (it's what
  makes Google return an `idToken`).
