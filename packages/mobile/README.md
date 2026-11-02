# Cezar mobile shell

A thin iOS and Android app that connects to a hosted cezar and shows that server's own cockpit.
Design: `.ai/specs/2026-10-31-mobile-apps-manager-first.md`. Version 0.1.0, debug builds only: no
signing, push, quick actions or CI yet.

> **iOS status:** none of the iOS code has been compiled for iOS. It was written on a Mac without
> Xcode. Only the plain classes were checked, against the macOS SDK (see [Checks](#checks)).

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
npm run test:swift      # compiles the plain Swift classes for macOS and runs them
cd android && ./gradlew :app:testDebugUnitTest   # JVM tests for the plain Java classes
```

`test:swift` needs only the Command Line Tools. It proves the logic of the plain classes and that
they typecheck against the macOS SDK. It does **not** prove they build for iOS, and it skips
`ServerViewController.swift`, which needs UIKit. It never touches the real keychain.

An emulator does not prove keychain, suspension or keyboard behaviour. Those need a real phone.
