# Cezar mobile shell

A thin iOS and Android app that connects to a hosted cezar and shows that server's own cockpit.
Design: `.ai/specs/2026-10-31-mobile-apps-manager-first.md`. Version 0.1.0. Release builds, signing
and store uploads: [RELEASING-MOBILE.md](../../RELEASING-MOBILE.md).

> **iOS status:** the app compiles for the iOS Simulator in mobile-check's iOS leg, which blocks, and
> the plain classes are tested on macOS (see [Checks](#checks)). Signed builds come from
> `mobile-release.yml` (RELEASING-MOBILE.md).

## How it fits together

| Part | Where | Framework? |
| --- | --- | --- |
| Connect screen | `connect/`, bundled | Talks to the `Connection` plugin |
| Adapters | `android/…/mobile/MainActivity.java`, `ConnectionPlugin.java`, `ios/App/App/ShellViewController.swift`, `ConnectionPlugin.swift` | The only code that names Capacitor |
| Plain classes | `android/…/mobile/shell/`, `ios/App/App/Shell/` | None, enforced by `npm run check` |
| Server pages | `ServerActivity`, `ServerViewController` | A plain webview with no bridge |

Capacitor is not finally accepted (spec Q2), so everything that matters would survive dropping it.
Server pages get their **own** webview. Capacitor's webview shows only the connect page, because
Capacitor 8 on iOS injects its bridge into every main frame and its message handler checks no
origin. Page script reaches native code only by navigating to `cezar://servers`.

## Icons and splash

Every launcher icon, splash and the connect screen's mark come from `docs/brand/cezar-icon-black.svg`
(guidelines: `docs/brand/README.md`). Regenerate after the mark changes; `npm test` fails while an
output is stale:

```bash
npm run brand                               # writes every output, no dependency
node scripts/build-brand.mjs --previews DIR # also renders circle, squircle, themed and splash previews
```

| Output | What |
| --- | --- |
| `drawable/ic_launcher_foreground.xml` | Vector mark: the adaptive foreground and monochrome (themed) layer, and the splash icon. The mark plus x of clear space fills the 72 dp every mask shows. |
| `mipmap-anydpi-v26/ic_launcher*.xml`, `values/ic_launcher_background.xml` | Adaptive icon on tile black |
| `mipmap-*dpi/ic_launcher*.png` | Android 7 launchers: the brand tile, and a round one, at all five densities |
| `drawable/splash.xml` | The splash before Android 12; Android 12+ uses `windowSplashScreen*` in `styles.xml` |
| `AppIcon.appiconset`, `Splash.imageset` | iOS icon (default, dark, tinted) and launch image. |

## Build the debug APK

You need Node 22+, JDK 21 and the Android SDK with `platforms;android-36` and
`build-tools;36.0.0`. `ANDROID_HOME` and `JAVA_HOME` must point at them.

```bash
cd packages/mobile
npm ci
npx cap sync android
cd android
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The app needs an `https://` cezar in hosted mode. A Cloudflare quick tunnel is not enough: in the
M2 spike it passed the Basic challenge but delivered no live events. Debug builds also trust user-installed CAs, so a
local test gate with its own CA works on an emulator once that CA is installed there. Release
builds do not.

## Build a release

`mobile-release.yml` builds, signs and uploads both apps; [RELEASING-MOBILE.md](../../RELEASING-MOBILE.md)
is the step by step. Locally, with an upload keystore that never enters the repository (`*.jks` is ignored):

```bash
cd packages/mobile/android
export CEZAR_ANDROID_KEYSTORE=/path/to/upload.jks CEZAR_ANDROID_KEYSTORE_PASSWORD=… \
       CEZAR_ANDROID_KEY_ALIAS=upload CEZAR_ANDROID_KEY_PASSWORD=…
./gradlew -PcezarVersionName=0.1.0 :app:bundleRelease :app:assembleRelease
cd .. && node scripts/check-release.mjs --name 0.1.0 --signed
```

Without the four variables the release is unsigned. The version name comes from `-PcezarVersionName`
(else `package.json`) and the code from `scripts/release-version.mjs`. Release builds run R8 and
resource shrinking, and the debug-only trust of user CAs lives in `src/debug/`, so a release never
carries it; `check-release.mjs` proves both on the built APK.

## Build for iOS, on a Mac with Xcode

This path has not been run yet. Expect to fix compile errors the first time.

```bash
cd packages/mobile
npm ci
npx cap sync ios
npx cap open ios                    # opens ios/App/App.xcodeproj
```

Xcode resolves Capacitor through Swift Package Manager (`ios/App/CapApp-SPM`), so there is no
`pod install`. Pick a team under Signing & Capabilities for the App target, choose a simulator or
your iPhone, and press Run.

## Checks

```bash
npm test                # connect-screen logic, node:test
npm run check           # plain classes must not name the framework; --selftest proves the check bites
npm run test:swift      # compiles the plain Swift classes for macOS and runs each suite in test/swift/
npm run typecheck:ios   # every iOS source against the Mac Catalyst SDK, with a Capacitor stub
cd android && ./gradlew :app:testDebugUnitTest   # JVM tests for the plain Java classes
```

Both need only the Command Line Tools, and neither proves an iOS build. `test:swift` proves the logic
of the plain classes on macOS; a source that imports UIKit is left out of it. `typecheck:ios` checks
every source against the real UIKit, WebKit and AVFoundation that Mac Catalyst ships, so it catches
wrong names and types there, but not iOS-only APIs, `Info.plist` or entitlements, and Capacitor is
a stub (`test/swift/stubs/Capacitor.swift`) copied from its 8.6 sources. Neither touches the real keychain.

The app needs iOS 17: each server gets its own `WKWebsiteDataStore(forIdentifier:)`, which is how
Forget server ends a cached Basic answer (see `Shell/WebsiteData.swift`).

An emulator does not prove keychain, suspension or keyboard behaviour. Those need a real phone.
