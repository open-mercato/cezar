# Cezar mobile shell

A thin iOS and Android app that connects to a hosted cezar and shows that server's own cockpit, or,
on Android, pairs with a cezar through the relay. Design: `.ai/specs/2026-10-31-mobile-apps-manager-first.md`
and `.ai/specs/2026-11-01-relay-qr-pairing.md`; the wire contract is `RELAY_PROTOCOL.md`. Version 0.1.0, debug builds only: no
signing, quick actions or CI yet. Push is Android only, for relay-paired servers, and off in any
build without a `google-services.json` ([below](#push-notifications-android)).

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

## App lock (Android)

Optional and off by default, on the Servers list. It prompts on every process start and after 60
seconds in the background, using the phone's biometrics or screen lock. `AppLock` watches the
activities, `LockPolicy` is the pure decision, and `LockShield` is the screen (spec QR3). It is a UI
gate: it holds no key, and keys and the relay work as before. iOS has no lock yet.

## The relay client (Android)

`android/…/mobile/shell/relay/` is plain Java over BouncyCastle's lightweight API and OkHttp's
WebSocket. iOS has none of it yet, so it keeps the URL form as its first screen.

| Class | Job |
| --- | --- |
| `RelayCrypto` | Every primitive, each one a direct BouncyCastle call |
| `NoiseHandshake`, `NoiseCipher` | `XXpsk3`, `KK`, `Rekey` |
| `PairSecret`, `RelayOrigin`, `PairingClient`, `PairingFlow` | QR and typed code, one rendezvous |
| `RelayLink` | One phone socket and its session: proof, `hello`, ping, reconnect, close codes |
| `TunnelSession`, `TunnelStream`, `TunnelFrame`, `TunnelRecord` | The tunnel |
| `LoopbackProxy`, `ProxyRequest` | The plain-HTTP face under the webview |
| `RelayConnections` | One link and one listener per process |

> **The Noise state machine is unaudited.** No maintained library has `XXpsk3`, `KK` and `Rekey`, so
> it is thin code over audited primitives (spec QR8). It passes Noise's published vectors and every
> file in `test-vectors/relay/`, which the JVM tests read in place.

Test it on an emulator with a dev relay on the host. `10.0.2.2` is refused on purpose, so use the
same loopback address on both sides:

```bash
adb reverse tcp:8787 tcp:8787         # CEZ_RELAY_URL=http://127.0.0.1:8787 on the computer
```

Debug builds also accept `http` for `127.0.0.1`, `localhost` and `[::1]`, and have one way to pair
without a camera. It does not exist in a release build:

```bash
adb shell "am start --activity-clear-task -n com.openmercato.cezar.mobile/.shell.DebugPairActivity --es qr '<qr string>'"
```

The activity requires `android.permission.DUMP`, which adb's shell holds and an installed app cannot
get, so other apps on the phone cannot start a pairing through it. The app registers no `cezar-pair`
intent filter, on purpose: the string works only inside its own scanner (spec QR9). A debug build still trusts user
CAs: keep it to a phone you trust.

## Push notifications (Android)

A relay-paired server can wake the phone when cezar needs the user (spec R5 as built,
`RELAY_PROTOCOL.md` § 7). cezar never sends the phone's push token anything: the phone asks the relay
for a **grant** that seals its FCM token to that cezar's Ed25519 key, and hands the grant to cezar
inside the encrypted session (`PUT /api/v1/workspace/phone/push`). The relay sends a fixed
notification, `Cezar` / `Cezar needs you`, with only `s` (the cezarId) as data. A tap opens that
server through the normal launch, so the app lock still applies, then asks cezar inside the session
which manager the push was about and loads `/manager/<id>`. Nothing is ever approved from a
notification.

| Part | Where |
| --- | --- |
| Grants, renewal, revoke, tap routing | `shell/push/`: plain Java with no Android or Firebase import (`npm run check` enforces both) |
| FCM | `push/FcmTokenSource.java`, `push/CezarMessagingService.java` |
| The `attention` channel, the foreground notification | `push/PushNotifier.java` |
| The switch | Servers list, per relay server (`connect/`), shown only when FCM is present |

How it behaves:

- After the **first** relay pairing the server view asks once whether to turn notifications on.
  Otherwise each relay server has a **Notifications** switch on the Servers list. Android 13+ asks
  for the notification permission when it goes on.
- On: the grant is got and handed over on the next server open with a live session. It is renewed on
  open once under 30 days remain, when cezar holds none or another `grantId`, and after FCM rotates
  the token (minted at once, handed over on the next open).
- Off: the relay revokes the grant at once; cezar gets its `DELETE` with the next session.
- Forget server: the goodbye makes cezar deny every grant, and the relay is asked to revoke too. A
  revoke that answers 429 or 503 keeps the grant and that server's device key, and is retried on each
  app open until a terminal answer or the grant expires. The Servers list names such a server as
  still being removed.
- State lives in `push.json` in the no-backup directory. The grant and the token are never logged.
- FCM auto-init is off, so the app asks FCM for nothing until a switch is on.

Known gap: when the app's task is alive in the background, Android brings it to the front on a tap
of the **system** notification without delivering `s`, so the app shows where it was rather than the
tapped server. The relay sends no `click_action` that could fix this. A tap on the notification the
app posts itself in the foreground always routes.

### Turning on real delivery

The build works without Firebase and push is then off: no `FirebaseApp` starts, no switch is shown,
and no grant is requested. To deliver for real, a maintainer:

1. Creates a Firebase project, or uses the one the relay already uses.
2. Adds an **Android app** with the package name `com.openmercato.cezar.mobile` (`applicationId` in
   `android/app/build.gradle`).
3. Downloads its `google-services.json` into `packages/mobile/android/app/`. It is not a secret, but
   it is gitignored: do not commit it until Open Mercato owns the Firebase project. The build applies
   the google-services plugin only when the file exists.
4. Gives the relay (`patzick/rome`) a service account key from the **same** Firebase project:
   Project settings → Service accounts → Generate new private key, then
   `npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON < key.json`. The relay also needs
   `GRANT_SEAL_KEY`, which seals the grants. Delete the downloaded key file afterwards.
5. Rebuilds the app, turns a server's switch on and opens that server once, so the grant reaches
   cezar.

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
| `drawable/ic_stat_cezar.xml` | The push notification's monochrome small icon: the mark filling 22 of 24 dp |
| `drawable/ic_launcher_foreground.xml` | Vector mark: the adaptive foreground and monochrome (themed) layer, and the splash icon. The mark plus x of clear space fills the 72 dp every mask shows. |
| `mipmap-anydpi-v26/ic_launcher*.xml`, `values/ic_launcher_background.xml` | Adaptive icon on tile black |
| `mipmap-*dpi/ic_launcher*.png` | Android 7 launchers: the brand tile, and a round one, at all five densities |
| `drawable/splash.xml` | The splash before Android 12; Android 12+ uses `windowSplashScreen*` in `styles.xml` |
| `AppIcon.appiconset`, `Splash.imageset` | iOS icon (default, dark, tinted) and launch image. Not compiled yet, like the rest of iOS. |

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
