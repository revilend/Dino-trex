# android-app — Pixel Dino: Parkour Run (Capacitor wrapper)

This is the self-contained Android APK route for the game. The game itself is
unchanged — this folder only wraps the shipped web files (`index.html`,
`manifest.webmanifest`, `sw.js`, `icons/`) inside a Capacitor native shell so
the result is a real `.apk` / `.aab` you can install or publish.

Layout
```
android-app/
  package.json          npm deps for the wrapper (capacitor core/cli/android)
  capacitor.config.json  app id + web dir + Android https scheme
  www/                  the web bundle Capacitor serves from the APK
    index.html
    manifest.webmanifest
    sw.js
    icons/              (icon-192, icon-512, maskable-512, apple-touch-icon, …)
  android/              the native Android project Capacitor generated
    app/src/main/AndroidManifest.xml   <- locked to landscape, fullscreen
    app/src/main/res/values/           <- white background, no action bar
    app/build.gradle                   <- targetSdk 34, versionCode 1
  .gitignore
  packages.yaml         pinned capacitor versions used for this build
```

What is already committed vs what must be built locally
- Committed here: wrapper config, native manifest/styles/gradle tweaks,
  generated web bundle under `www/`, and the pin file.
- NOT committed: the actual `.apk` / `.aab` and any keystores. Those must be
  built on a machine that has a JDK 17 + Android SDK (or in CI). This workspace
  is Node.js only, so the APK itself cannot be produced from here.

Local build (requires JDK 17 + Android SDK on the machine running it)
```bash
cd android-app
npm install
npx cap sync          # copy www/ into android/app/src/main/assets/public
cd android
./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
# or, for the publishable bundle:
./gradlew bundleRelease        # -> app/build/outputs/bundle/release/app-release.aab
```

Release checklist (already satisfied by the files in this repo)
- Fullscreen, landscape, no status bar: `AndroidManifest.xml` +
  `styles.xml` + web `manifest.webmanifest`.
- Target API 34, minSdk 23, applicationId `app.pixeldino.parkourrun`.
- App icon 512 + maskable in `www/icons/`.
- Feature graphic + 4 screenshots in `store/` (used by `npm run store`).
- Privacy policy: `PRIVACY.md`.

Play stores an AAB, not an APK. If you only need a file to sideload onto your
own phone, use `assembleDebug`.
