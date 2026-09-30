# Turning DINO.EXE into an APK

The game is already shaped like an app: one self-contained page, a web app
manifest, real PNG icons and a service worker that makes it work with **no
network at all** — which is, fittingly, the whole point of the game. That is
everything both packaging routes need.

There are two ways to get an `.apk`, and they trade off differently.

| | **Trusted Web Activity** (Bubblewrap) | **Capacitor** |
| --- | --- | --- |
| What it is | a thin native shell around the *hosted* URL | a native shell around a *copy* of the files |
| Needs a live HTTPS URL | yes | no |
| Works fully offline | yes (service worker) | yes (files are bundled) |
| Needs `assetlinks.json` server-side | yes, or you get a URL bar | no |
| Update flow | edit the site, users get it instantly | rebuild and re-ship the APK |
| Add to this repo | nothing | a sibling `android-app/` folder with npm deps |

Pick **Capacitor** if you want an APK you can hand to someone as a file, or if
the game will not be hosted at a public HTTPS URL. Pick **TWA** if the game
already lives on a domain and you want a Play-Store-shaped app that keeps
itself up to date.

> This workspace has **no Android SDK, JDK or Gradle** — the hosting image is
> Node.js only — so the APK itself has to be built on a machine with Android
> Studio (or in CI). Everything the build needs *from this repo* is already
> here.

---

## What is already in the repo

```
index.html                 the whole game
manifest.webmanifest       standalone app metadata + icon list
sw.js                      offline worker (network-first page, cache-first icons)
icons/
  icon-192.png             manifest "any"
  icon-512.png             manifest "any"
  maskable-512.png         manifest "maskable" (survives a circular crop)
  apple-touch-icon.png     iOS home screen
  icon-1024.png            store listing / Android mipmap source
  favicon-32.png           tab icon
make-icons.cjs             regenerates every icon from the game's own sprite
ANDROID.md                 this file
```

Regenerate the icons any time the sprite art changes:

```bash
node make-icons.cjs
```

---

## Route 1 — Trusted Web Activity (Bubblewrap)

A TWA renders your page inside a Chrome Custom Tab with the URL bar hidden.
It is the officially supported way to ship a PWA to the Play Store.

**You will need:** Node 18+, JDK 17, and the Android SDK (`sdkmanager` with
`platform-tools` and `build-tools`), plus the site live at a public HTTPS URL.

```bash
npm install -g @bubblewrap/cli

# reads your manifest straight off the deployed site
bubblewrap init --manifest https://YOUR-DOMAIN/manifest.webmanifest
#   application id       app.dinoexe.bufferingrun
#   app name             DINO.EXE
#   display mode         standalone
#   signing key          let it generate android.keystore (KEEP THIS FILE)

bubblewrap build
# -> app-release-signed.apk
bubblewrap install            # adb install onto a connected device
```

Installability checklist the browser enforces — this repo satisfies all of it:

- [x] served over HTTPS
- [x] `manifest.webmanifest` with `name`, `short_name`, `start_url`, `display: standalone`
- [x] a 192px and a 512px icon, plus a `maskable` one
- [x] a registered service worker with a `fetch` handler
- [x] `theme_color` and `background_color`

### Remove the URL bar: Digital Asset Links

Without this the TWA shows a small address bar. Host a file at
`https://YOUR-DOMAIN/.well-known/assetlinks.json` containing the SHA-256
fingerprint of the keystore Bubblewrap generated:

```bash
keytool -list -v -keystore android.keystore -alias android | grep SHA256
```

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "app.dinoexe.bufferingrun",
    "sha256_cert_fingerprints": ["AA:BB:CC:...:FF"]
  }
}]
```

The `Content-Type` must be `application/json` and the file must be reachable
without a redirect. Verify with:

```bash
curl -sI https://YOUR-DOMAIN/.well-known/assetlinks.json | grep -i content-type
```

---

## Route 2 — Capacitor (a self-contained APK)

Capacitor copies the game into the APK and serves it from the app itself, so
the APK works with no hosting and no `assetlinks.json`. This is the route to
take if you want a file you can just send to somebody.

This adds npm dependencies in a **sibling folder**, so the game stays exactly
as it is: one HTML file, zero dependencies, no build step.

```bash
mkdir android-app && cd android-app
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android

npx cap init "DINO.EXE" app.dinoexe.bufferingrun --web-dir=www
mkdir -p www/icons
cp ../index.html ../manifest.webmanifest ../sw.js www/
cp ../icons/*.png www/icons/
```

Point the app at the local bundle (Capacitor serves `www/` from
`https://localhost`, so the service worker and `localStorage` both work):

```jsonc
// capacitor.config.json
{
  "appId": "app.dinoexe.bufferingrun",
  "appName": "DINO.EXE",
  "webDir": "www",
  "android": { "allowMixedContent": false, "backgroundColor": "#ffffff" },
  "server": { "androidScheme": "https" }
}
```

Then generate the native project and build:

```bash
npx cap add android
npx cap copy
npx cap open android        # opens Android Studio; press Run
# or, headless:
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

For a release APK, sign it:

```bash
cd android
./gradlew assembleRelease \
  -Pandroid.injected.signing.store.file=$PWD/../dinoexe.keystore \
  -Pandroid.injected.signing.store.password=... \
  -Pandroid.injected.signing.key.alias=dinoexe \
  -Pandroid.injected.signing.key.password=...
# -> android/app/build/outputs/apk/release/app-release.apk
```

### Launcher icons in the native project

Capacitor has a helper that turns one square source into every Android density
and adaptive-icon layer:

```bash
cd android-app
npm install --save-dev @capacitor/assets
npx capacitor-assets generate --android --iconBackgroundColor "#535353" \
                              --iconBackgroundColorDark "#535353" \
                              --splashBackgroundColor "#ffffff"
```

Point `assets/icon.png` at the 1024px icon this repo generates
(`icons/icon-1024.png`). Android adaptive icons want the mark inside the inner
~66% circle, which is exactly how `maskable-512.png` is laid out.

---

## Things worth knowing

- **Audio needs a gesture.** The Web Audio context is created on the first tap
  or key press, so the title card's `TAP ANYWHERE TO START` doubles as the
  unlock. Nothing extra is needed for the APK.
- **Saves live in `localStorage`** under `dinoexe.save.v2`, so coins, skins,
  PRO and the checkpoint survive app restarts. They do **not** survive an
  uninstall unless the app uses Android auto-backup (Capacitor enables it by
  default).
- **Orientation.** The manifest asks for `any`, because the game lays itself
  out responsively and already lifts up in portrait to make room for the
  six-button pad. Lock it in the native project if you would rather force
  landscape.
- **Version bumping** happens in the native project (`versionName` in
  `android/app/build.gradle`), not here.
- **Play Store** needs a signed AAB, not an APK: `./gradlew bundleRelease`
  produces `android/app/build/outputs/bundle/release/app-release.aab`.
