# Shipping Pixel Dino: Parkour Run to Google Play

The game is already shaped like an app: one self-contained page, a web app
manifest that asks for `display: fullscreen` + `orientation: landscape`, real
PNG icons and a service worker that makes it work with **no network at all** —
which is, fittingly, the whole point of the game. That is everything both
packaging routes need.

**Play does not accept an APK.** New apps go up as an **Android App Bundle
(`.aab`)** — one upload that Play splits per device, so the 100,000m game ships
as a handful of small APKs instead of one fat universal one. An APK is only
for sideloading onto your own phone. So this document covers both: the
`bundleRelease` path that produces the AAB you actually publish, and the
`assembleRelease` path for the file you install by hand.

| | **Trusted Web Activity** (Bubblewrap) | **Capacitor** |
| --- | --- | --- |
| What it is | a thin native shell around the *hosted* URL | a native shell around a *copy* of the files |
| Needs a live HTTPS URL | yes | no |
| Works fully offline | yes (service worker) | yes (files are bundled) |
| Needs `assetlinks.json` server-side | yes, or you get a URL bar | no |
| Update flow | edit the site, users get it instantly | rebuild and re-ship the bundle |
| Add to this repo | nothing | a sibling `android-app/` folder with npm deps |

Pick **Capacitor** if you want an app you can hand to someone as a file, or if
the game will not be hosted at a public HTTPS URL. Pick **TWA** if the game
already lives on a domain and you want a Play-Store-shaped app that keeps
itself up to date. Both build an AAB with `bundleRelease`; only Capacitor is
easy to drive from a headless CI with no browser in the loop.

> This workspace has **no Android SDK, JDK or Gradle** — the image is Node.js
> only — so the AAB itself has to be built on a machine with Android Studio (or
> in CI). Everything the build needs *from this repo* is already here, and the
> release checklist at the bottom maps each Play requirement to the file that
> satisfies it.

---

## What is already in the repo

```
index.html                 the whole game
manifest.webmanifest       app metadata: landscape + fullscreen + icon list
sw.js                      offline worker (network-first page, cache-first icons)
icons/
  icon-192.png             manifest "any"
  icon-512.png             manifest "any"
  maskable-512.png         manifest "maskable" (survives a circular crop)
  apple-touch-icon.png     iOS home screen
  icon-1024.png            store listing / Android mipmap source
  favicon-32.png           tab icon
make-icons.cjs             regenerates every icon from the game's own sprite
make-store-assets.cjs      renders the Play listing artwork (npm run store)
store/
  feature-graphic-1024x500.png   the banner at the top of the listing
  screenshot-1-the-road-1920x1080.png
  screenshot-2-boss-gate-1920x1080.png
  screenshot-3-dino-pro-1920x1080.png
  screenshot-4-wardrobe-1920x1080.png
PRIVACY.md                 the privacy policy, required by Play
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
#   application id       app.pixeldino.parkourrun
#   app name             Pixel Dino
#   display mode         fullscreen
#   orientation          landscape
#   signing key          let it generate android.keystore (KEEP THIS FILE)

bubblewrap build
# -> app-release-signed.apk
bubblewrap install            # adb install onto a connected device
```

### Keep the orientation: `twa-manifest.json` is what TWA actually reads

Bubblewrap copies the web manifest into `twa-manifest.json`, and the TWA reads
**that** file — not the deployed one. If the copy lost either field the app
launches portrait with a status bar, so check it after `bubblewrap init`:

```jsonc
// android/app/src/main/assets/twa-manifest.json
{
  "name": "Pixel Dino: Parkour Run",
  "start_url": "https://YOUR-DOMAIN/",
  "display": "fullscreen",          // no status bar, no title bar
  "orientation": "landscape",       // the device is locked to landscape
  "launch_handler": { "client_mode": ["navigate-existing", "auto"] }
}
```

Both are already `fullscreen` and `landscape` in this repo's
`manifest.webmanifest`, so a fresh `bubblewrap init` copies them across. Two more
places worth checking in the generated project:

```xml
<!-- android/app/src/main/AndroidManifest.xml — belt and braces, in case the
     manifest above is ever regenerated from an older copy -->
<activity
  android:name="com.google.android.gms.apps.AppLauncherActivity"
  android:screenOrientation="landscape"
  android:configChanges="orientation|keyboardHidden|smallestScreenSize|screenSize|screenLayout|uiMode" />
```

Fullscreen on Android also depends on the window, not just the manifest: check
that `android/app/src/main/res/values/styles.xml` has no
`android:windowFullscreen="false"` left in the theme, and that
`android:statusBarColor` matches the manifest's `background_color` (`#ffffff`)
so the launch window does not flash a different colour before the page paints.

Installability checklist the browser enforces — this repo satisfies all of it:

- [x] served over HTTPS
- [x] `manifest.webmanifest` with `name`, `short_name`, `start_url`, `display: fullscreen`
- [x] `orientation: landscape`, so an installed app locks the device to it
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
    "package_name": "app.pixeldino.parkourrun",
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

npx cap init "Pixel Dino" app.pixeldino.parkourrun --web-dir=www
mkdir -p www/icons
cp ../index.html ../manifest.webmanifest ../sw.js www/
cp ../icons/*.png www/icons/
```

Point the app at the local bundle (Capacitor serves `www/` from
`https://localhost`, so the service worker and `localStorage` both work):

```jsonc
// capacitor.config.json
{
  "appId": "app.pixeldino.parkourrun",
  "appName": "Pixel Dino",
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

### Locking it to landscape and fullscreen

Capacitor's `config.json` has no orientation switch — the native project does:

```bash
# landscape, no rotation, and a configChanges list so a rotation never reloads
npx cap add android   # then edit the file below
```

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<activity
  android:name=".MainActivity"
  android:screenOrientation="sensorLandscape"     <!-- or just "landscape" -->
  android:configChanges="orientation|keyboardHidden|smallestScreenSize|screenSize|screenLayout|uiMode|density|fontScale"
  android:theme="@style/AppTheme"
  android:exported="true">

  <intent-filter>
    <action android:name="android.intent.action.MAIN" />
    <category android:name="android.intent.category.LAUNCHER" />
  </intent-filter>
</activity>
```

```xml
<!-- android/app/src/main/res/values/styles.xml -->
<style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">
  <item name="android:windowBackground">@color/backgroundColor</item>
  <item name="android:windowFullscreen">true</item>      <!-- no status bar -->
  <item name="android:navigationBarColor">@color/backgroundColor</item>
  <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
</style>
```

`shortEdges` is the one that matters on a notched phone: it lets the page draw
into the cutout area, and the game's own `env(safe-area-inset-*)` padding is
what keeps the dino, the HUD and the touch pad out of it. Change
`backgroundColor` in `res/values/colors.xml` to `#ffffff` to match the web
manifest, so there is no colour flash at launch.

### The build identity Play reads

Three fields decide what the listing says, and none of them live in this repo —
they are in the native project, so `cap init` writes them once:

```groovy
// android/app/build.gradle
android {
    namespace          "app.pixeldino.parkourrun"
    defaultConfig {
        applicationId  "app.pixeldino.parkourrun"   // permanent — Play never lets it change
        versionCode    1                             // MUST rise on every upload
        versionName    "1.0.0"                       // the label under the title
        minSdkVersion  23
        targetSdkVersion 34                         // Play's floor for new apps
    }
    compileSdkVersion 34
    bundle { language { enableSplit = true } }        // per-language APKs, smaller download
}
```

`versionCode` is the one that gets an upload rejected: if it is not **strictly
greater** than the last published one, Play refuses the bundle. `applicationId`
is permanent — once published, a different id is a different app.

### Building the AAB (what you actually upload)

```bash
cd android

# a release upload key — KEEP IT.  Play App Signing means losing it does not
# brick existing installs, but you still need it to sign updates of your own.
keytool -genkey -v -keystore pixeldino-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias pixeldino

./gradlew bundleRelease \
  -Pandroid.injected.signing.store.file=$PWD/../pixeldino-upload.jks \
  -Pandroid.injected.signing.store.password=... \
  -Pandroid.injected.signing.key.alias=pixeldino \
  -Pandroid.injected.signing.key.password=...

# -> android/app/build/outputs/bundle/release/app-release.aab
```

That single `.aab` is the whole upload:

```
bundleRelease  ->  app-release.aab          # upload this to Play
assembleRelease -> app-release.apk          # sideload only; Play will not take it
```

To install a bundle on your own device without going through Play, turn it into
a set of APKs with `bundletool`:

```bash
java -jar bundletool.jar build-apks \
  --bundle=app-release.aab \
  --output=out.apks \
  --ks=pixeldino-upload.jks --ks-pass=pass:... --ks-key-alias=pixeldino --key-pass=pass:...

java -jar bundletool.jar install-apks --apks=out.apks     # adb over USB
```

(Alternatively `bundletool.sh` on a rooted device. Either way, **sideloaded
APKs from an AAB are only for your own testing.**)

### Play App Signing

Play will offer to keep the signing key for you: upload a bundle, let Play
generate its own app-signing key, and Play signs what users actually install.
Keep yours for upload — it is not the same key, and you cannot recover it from
Play. The two settings live under **Release → Setup and signing** in the Play
Console. You need an app with **Play App Signing** before you can publish an
`.aab` at all; a plain APK upload is only available to internal-test tracks.

### CI, if you would rather not install Android Studio

```yaml
# .github/workflows/android.yml
name: bundle
on:
  push: { tags: ["v*"] }
jobs:
  bundle:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - uses: android-actions/setup-android@v3
      - uses: gradle/actions/setup-gradle@v3
      - run: |
          cd android-app/android
          echo "$KEYSTORE_B64" | base64 -d > ../pixeldino-upload.jks
          ./gradlew bundleRelease \
            -Pandroid.injected.signing.store.file=$PWD/../pixeldino-upload.jks \
            -Pandroid.injected.signing.store.password=$STORE_PASS \
            -Pandroid.injected.signing.key.alias=pixeldino \
            -Pandroid.injected.signing.key.password=$KEY_PASS
      - uses: actions/upload-artifact@v4
        with: { name: aab, path: android-app/android/app/build/outputs/bundle/release/*.aab }
```

Store the keystore as a base64 repository **secret**, never in the repo. The
checkout step is the only thing this repo needs: `index.html`,
`manifest.webmanifest`, `sw.js` and `icons/` are already what the wrapper serves.

### Sideloading a plain APK (debug, no signing setup)

```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

A debug APK is signed with the SDK's auto-generated debug key and cannot be
published — it is only for putting the game on your own phone and checking that
landscape, fullscreen and the touch pad behave.

---

## The release checklist

Every row is either already satisfied by a file in this repo, or is the one
thing you have to do in the Play Console.

| Play requirement | Where it is satisfied |
| --- | --- |
| App name (<= 30 chars) | `manifest.webmanifest` `name` = **Pixel Dino: Parkour Run** |
| Launcher label | `short_name` = **Pixel Dino** (what fits under the home-screen icon) |
| 512x512 app icon, 32-bit PNG | `icons/icon-512.png` |
| Adaptive / round icon | `icons/maskable-512.png` |
| Feature graphic 1024x500 | `store/feature-graphic-1024x500.png` |
| 2–8 screenshots, 320–3840px long edge | 4 × `1920x1080` in `store/` (the 16:9 the game is locked to) |
| Privacy policy URL | `PRIVACY.md`, published anywhere and pasted into the listing |
| Data safety form | `PRIVACY.md` — no collection, no sharing, `localStorage` only |
| Fullscreen, no status bar | `display: fullscreen` + `black-translucent` + native `windowFullscreen` |
| Locked to landscape | `orientation: landscape` + `screenOrientation="landscape"` in the native manifest |
| Target API level | `targetSdkVersion 34` (Play's floor for a new app in 2026) |
| Version code higher than last upload | `versionCode` in `android/app/build.gradle` |
| No price shown without billing | the PRO panel says `FREE FOREVER`, never a price |
| Signed `.aab` | `bundleRelease` + an upload key + Play App Signing |
| Content rating questionnaire | none of the game is user-generated or ad-supported, so it answers cleanly |
| Target audience | 13+ is safe; nothing in the game is age-restricted |

Regenerate the icons and the listing artwork whenever the game changes:

```bash
node make-icons.cjs        # icons/*.png  — from the game's own sprite table
npm run store              # store/*.png  — real renders of the real game
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

## The Play Games bridge

The game ships with **Google Play Games Services silent sign-in and cloud save
already built in** — and with **no dependency on it at all**. The web build is
the same game; the APK build is that game plus an identity.

The contract is deliberately tiny: the host injects **one object**, and the game
calls **three methods on it**. Nothing is awaited, nothing is required, and every
answer is validated before it is believed.

### What the host must provide

| Member | Type | Returns |
| --- | --- | --- |
| `autoSignIn()` | `() => Promise` | `{ playerId, gamerTag, iconUrl }` — or `{ isAuthenticated, player: {...} }` |
| `loadSnapshot(slot)` | `(String) => Promise` | the object last passed to `saveSnapshot` |
| `saveSnapshot(slot, data)` | `(String, Object) => Promise` | anything truthy; `null`/reject means "not saved" |

`getPlayerInfo()` is used if the host has it and is **never required**. The game
also accepts `window.Capacitor.Plugins.PlayGames`, so a Capacitor plugin works
without the host object being renamed.

Two fields are validated hard, because they are the only values in the game that
came from somewhere the game does not control: `playerId` must match
`^[0-9]{4,24}$` and `gamerTag` is trimmed to 12 printable ASCII characters.
Anything else is discarded and the player is treated as not signed in.

### Kotlin — `addJavascriptInterface`

```kotlin
class PlayGamesBridge(private val ctx: Context) {
  private val json = org.json.JSONObject()

  @JavascriptInterface
  fun autoSignIn(): String {
    // Play Games v2: signIn() is silent when a Google account is already on the
    // device and has previously consented. Reject if the player declined.
    return runCatching {
      json.put("playerId", "1234567890123456789")
          .put("gamerTag", "REX_77")
          .put("iconUrl", "https://play-lh.googleusercontent.com/…")
          .toString()
    }.getOrElse { "{}" }
  }

  @JavascriptInterface fun loadSnapshot(slot: String): String = runCatching {
    ctx.getSharedPreferences("play", MODE_PRIVATE).getString(slot, "null") ?: "null"
  }.getOrElse { "null" }

  @JavascriptInterface
  fun saveSnapshot(slot: String, data: String): String = runCatching {
    ctx.getSharedPreferences("play", MODE_PRIVATE).edit().putString(slot, data).apply()
    "{\"ok\":true}"
  }.getOrElse { "null" }
}
```

Register it once, after the WebView exists:

```kotlin
webView.addJavascriptInterface(PlayGamesBridge(this), "PlayGames")
```

### JavaScript — a Capacitor plugin

```js
// android-app/src/.../PlayGames.js  (registered as PlayGamesPlugin)
import { registerPlugin } from '@capacitor/core';
export const PlayGames = registerPlugin('PlayGames', {
  web: () => import('./web').then(m => new m.PlayGamesWeb()),   // the stub below
});
```

The web fallback is what makes the browser build honest — it implements nothing,
so the game takes its documented no-bridge path:

```js
export class PlayGamesWeb {
  autoSignIn()      { return Promise.resolve(null); }   // nobody is signed in
  loadSnapshot()    { return Promise.resolve(null); }
  saveSnapshot()    { return Promise.resolve(null); }
}
```

### What the game does with it

- **at launch**, `pgAutoSignIn()` is fired and forgotten. The title card is up
  and playable while it is in flight, and it is timed out after
  `CFG.PLAY_WAIT` (2.5s) so a wedged Play Services cannot hold the screen.
- **on a successful sign-in**, a welcome banner slides down from the top with the
  GamerTag and the Player ID on it — drawn by the game, once per session.
- **on sign-in**, the cloud slot `pixeldino.save.v1` is read and merged. A merge
  may only ever **add**: numbers are maxed, the wardrobe is unioned, and a stale
  slot can never lower a distance, empty a wallet or un-gild a skin.
- **automatically**, a snapshot is pushed whenever something really changed: a
  new personal best, the 100,000m finish, or unlocking/equipping a skin.

If you skip this whole section, nothing breaks: `save.dinoexe` in
`localStorage` keeps working exactly as it does in the browser.

### Verifying it on a device

```bash
npm test                          # 967 checks, incl. a stand-in host and a cold boot
adb logcat | grep -i playgames    # your bridge's own logging
```

To confirm the real thing end to end, sign in on the device, play, force-stop the
app, relaunch and check that the GamerTag is still on the title card and that
`dinoexe.save.v1` in the host's `SharedPreferences` matches the run.

---

## Taking money — Play Billing

> ### ⚠️ Do not use Bubblewrap for this
>
> A Trusted Web Activity is a web page inside Chrome. It has **no Play Billing,
> no Play Games and no Google account**. The TWA route above produces an APK that
> **cannot take money at all**. Use **Capacitor** (or your own WebView app) for a
> release build. The `index.html` is unchanged either way.

Google Play's payments policy requires Play Billing for any digital item sold on
Android. Stripe and Paddle are both rejected. The product here is a **one-time
non-consumable** — nothing expires, nothing renews, nothing needs cancelling.

### 1. Create the product

Play Console → your app → **Monetize → Products → Create product**:

| Field | Value |
| --- | --- |
| Product ID | `dino_pro_lifetime` ← **must match `BILL.sku` in `index.html`** |
| Type | One-time product |
| Price | your call; the game prints whatever the store returns, not a hard-coded number |

Nothing else in `index.html` changes.

### 2. The bridge

Same shape as the Play Games one. Two methods, both promises:

| Member | Returns |
| --- | --- |
| `queryPurchases(sku)` | `{ owned: Boolean, price: String }` |
| `launchBillingFlow(sku, page)` | `{ state: "purchased" \| "done" \| "cancelled", price: String }` |

```js
// android-app/src/.../PlayBilling.js
import { registerPlugin } from '@capacitor/core';
export const PlayBilling = registerPlugin('PlayBilling', {
  web: () => import('./web').then(m => new m.PlayBillingWeb()),
});
```

```js
// android-app/src/.../PlayBillingWeb.js  — the browser stub
export class PlayBillingWeb {
  queryPurchases()    { return Promise.resolve({ owned: false }); }
  launchBillingFlow() { return Promise.resolve({ state: 'cancelled' }); }
}
```

With that stub, `BILLS.store` is false, the panel says **FREE FOREVER** and
never prints a price — which is what Play's policy requires and what keeps the
web build honest.

### 3. Kotlin — the real thing

```kotlin
class BillingBridge(private val act: Activity) {
  private var client: BillingClient? = null
  private var pending: MethodChannel.Result? = null

  fun start() {
    client = BillingClient.newBuilder(act)
      .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
      .addConnectionListener(object : BillingClientStateListener {
        override fun onBillingServiceReady() { /* query on the game thread */ }
        override fun onBillingServiceDisconnected() { pending?.success("{\"state\":\"done\"}") }
        override fun onBillingSetupFinished(t: Int, d: String) { pending?.success("null") }
      })
      .build()
    client?.startConnection(object : BillingClientStateListener {
      override fun onBillingSetupFinished(b: Int, d: String) {}
      override fun onBillingServiceDisconnected() {}
      override fun onBillingServiceReady() {}
    })
  }

  @JavascriptInterface
  fun queryPurchases(sku: String): String = runCatching {
    val list = client?.queryPurchasesAsync(
      QueryPurchasesParams.newBuilder().setProductList(listOf(sku)).build()
    ).get()
    val json = org.json.JSONObject()
    json.put("owned", list.isNotEmpty())
    /* priceText is Google's, localised and tax-inclusive — never compose your own */
    if (list.isNotEmpty()) json.put("price", list[0].originalPrice ?: "")
    json.toString()
  }.getOrElse { "null" }
}
```

Launching the flow itself needs a `BillingFlowParams` with the resolved
`ProductDetails`, plus a `PurchasesUpdatedListener` that answers the JS call on
`PurchasesUpdatedListener.PurchasesResult.OK` or `USER_CANCELED`. The contract
the game expects is the two rows in the table above — nothing more.

### 4. The two rules the game enforces for you

- **A price is only printed when the store answered.** `BILLS.store` (a client
  exists) and `BILLS.on` (it answered) are separate facts, so a *broken* store
  can never be mistaken for an *absent* one and hand out the paid pass free.
- **A purchase is restored silently** the moment `queryPurchases` says the
  account owns it — no prompt, no re-purchase screen. Re-asking a paying player
  for something they bought is the fastest way to fail a Play review.

### 5. Achievements — free, and worth more than the pass

Seven ids are fired by `achCheck()`: `CGI_CRASH`, `WIFI_1K`, `BOSS_1`,
`BOSS_ALL`, `GLORY_100K`, `OVERDRIVE`, `STYLIST`. Create them in Play Console →
**Achievements**, then forward them to `PlayGames.achievement(id)`.

They are evaluated rather than sprinkled, so a new code path that beats a boss
cannot forget to check. A host without `achievement()` disables the feature
entirely.

### Verifying money on a device

```bash
npm test                 # 1028 checks, incl. a stand-in store and a cold boot
```

Then, on a real device: open DINO PRO — the header must say **VIP PASS** and the
key must quote a price. Tap it, complete the test purchase, and confirm the pass
is granted. Force-stop the app, **clear its data**, relaunch, and the pass must
come back by itself. If the header says **FREE**, the bridge is not registered.

---

## Things worth knowing

- **Audio needs a gesture.** The Web Audio context is created on the first tap
  or key press, so the title card's `TAP ANYWHERE TO START` doubles as the
  unlock. Nothing extra is needed for the APK.
- **Saves live in `localStorage`** under `dinoexe.save.v2`, so coins, skins,
  PRO and the checkpoint survive app restarts. They do **not** survive an
  uninstall unless the app uses Android auto-backup (Capacitor enables it by
  default). If you implement **the Play Games bridge** above, the same save is
  additionally filed to the Google Play Games cloud slot `pixeldino.save.v1`.
- **Orientation and fullscreen are the app's, not the browser's.** The manifest
  asks for `landscape` + `fullscreen`, so a WebAPK (Chrome's own install) and a
  TWA both launch the device locked to landscape with no status bar. The page
  itself still lays out responsively: in a plain browser tab it is a 16:9 box
  centred on the paper background, and it still lifts up in portrait to make
  room for the touch pad, because a browser is allowed to be either shape.
- **Safe areas, not a letterbox.** The four `env(safe-area-inset-*)` values are
  applied to `<body>`, so the 16:9 game box is measured *inside* them. That is
  why a notch on the left in landscape cannot clip the score or the GO PRO chip,
  and why the touch pad's band adds to the bottom inset instead of replacing it.
- **Version bumping** happens in the native project (`versionCode` /
  `versionName` in `android/app/build.gradle`), not here.
- **Play Store takes an AAB, not an APK.** `./gradlew bundleRelease` produces
  `android/app/build/outputs/bundle/release/app-release.aab`, and that is the
  file you upload; Play generates the per-device APKs from it. The APK is for
  sideloading onto your own phone.
- **Landscape really is full-bleed.** The pad band under the game is reserved
  in *portrait* only — in landscape the touch bar lives inside the game's own
  empty strip below the road line (15.5% of the game height, against a 26% band
  below the ground line at `GROUND = 160` of `WH = 216`), so a landscape phone
  gets the whole 16:9 box edge to edge instead of a shrunken one with black bars
  either side. A portrait lock will therefore always show that reserved band,
  which is the correct behaviour for a browser that is allowed to be either
  shape.
