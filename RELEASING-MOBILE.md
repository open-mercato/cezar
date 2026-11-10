# Releasing the mobile apps

The exact steps to put the cezar app (`packages/mobile`) on Google Play and the App Store. Everything
that can be built is in the repository; what is left needs an account, a secret or a decision that only
the owner can make. Each step says where it is done.

| Piece | Where |
| --- | --- |
| Release build, signing, version | `packages/mobile/android/app/build.gradle`, `packages/mobile/scripts/release-version.mjs` |
| Release check (version, signature, no debug code, cleartext only to loopback) | `packages/mobile/scripts/check-release.mjs` |
| CI on mobile PRs | `.github/workflows/mobile-check.yml` |
| Signed builds and uploads | `.github/workflows/mobile-release.yml` |
| Listing text, Data safety, App Privacy, age rating, reviewer notes | `packages/mobile/store/*.md` |
| Screenshots, feature graphic, Play icon | `packages/mobile/store/screenshots/`, `packages/mobile/store/graphics/` |
| Privacy policy page | `packages/mobile/store/privacy-policy.md` → `privacy-policy.html` |
| Reviewer demo server | `packages/mobile/demo/` |

## Versions

The app has its own version, `packages/mobile/package.json`. `release-version.mjs` turns it into:

| | Example `0.1.0` | Example `0.2.0-rc.3` |
| --- | --- | --- |
| Android `versionName` | `0.1.0` | `0.2.0-rc.3` |
| Android `versionCode`, iOS `CFBundleVersion` | `10099` | `20003` |
| iOS `CFBundleShortVersionString` | `0.1.0` | `0.2.0` |

Code = major × 1 000 000 + minor × 10 000 + patch × 100 + (rc number, or 99 for the final release), so
every rc sorts below its release and both stores accept each upload as newer. Minor and patch stay
below 100, rc numbers run 1 to 98.

To release: bump `packages/mobile/package.json` in a PR, merge it, then a maintainer pushes the tag on
that commit: `git tag mobile-v0.1.0 && git push origin mobile-v0.1.0`. The workflow refuses a tag that
does not match `package.json` apart from an `-rc.N` suffix. A manual run (**Actions > Mobile release >
Run workflow**) releases what `package.json` says.

## 1. Accounts (once)

1. **Google Play Console** developer account, as an organization: https://play.google.com/console/signup.
   USD 25 once. An organization account needs a D-U-N-S number and verification, which takes days.
   A personal account created after November 2023 must also run a closed test with at least 12
   testers for 14 days before it can publish to production; an organization account does not.
2. **Apple Developer Program**, as an organization: https://developer.apple.com/programs/enroll/.
   USD 99 a year, D-U-N-S number required.
3. **Firebase project** (optional, for Android notifications while the app is closed):
   https://console.firebase.google.com, add an Android app with package `com.openmercato.cezar.mobile`,
   download `google-services.json`. Without it the app notifies only while open. The relay then also
   needs its own `FCM_SERVICE_ACCOUNT_JSON` and `GRANT_SEAL_KEY` (`packages/mobile/README.md`, "Turning on
   real delivery").
4. **Hosting for the privacy policy page**, see [step 5](#5-privacy-policy).
5. **A small VPS and a DNS name** for the reviewer demo, see [step 6](#6-reviewer-demo).

## 2. Android, once

### 2.1 The upload key

Play App Signing keeps the key that signs what users install. You keep only an **upload key**, which
Google can reset if it is lost. Create it on your own machine, never in the repository (`*.jks` is
ignored there anyway):

```bash
keytool -genkeypair -v -keystore cezar-upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Open Mercato, O=Open Mercato"
base64 -i cezar-upload.jks | pbcopy        # macOS; Linux: base64 -w0 cezar-upload.jks
```

Keep the `.jks` file and both passwords in the team password manager.

### 2.2 The app in Play Console

1. **Create app**: name `cezar`, default language English (United States), App, Free. Accept the
   declarations.
2. **Policy and programs > App content**, every item:
   - Privacy policy: the URL from step 5.
   - App access: **All or some functionality is restricted**, add the instructions from
     `packages/mobile/store/reviewer-notes.md` ("Play Console: App access").
   - Ads: No. Content rating: answers in `store/age-rating.md`. Target audience: 18 and over.
   - Data safety: answers in `store/data-safety.md`.
   - News app, government app, financial features, health: No / none.
3. **Grow > Store presence > Main store listing**: text from `store/listing.md`; app icon
   `store/graphics/play-icon-512.png`; feature graphic `store/graphics/feature-graphic.png`; phone
   screenshots `store/screenshots/android/phone/*.png`. Category: Tools. Contact email.
4. **Setup > App signing**: leave **Use Google-generated key** (the default for a new app).

### 2.3 The service account for uploads

1. In Google Cloud (https://console.cloud.google.com), pick or create a project, enable the **Google
   Play Android Developer API**, create a service account and add a JSON key. Download the JSON.
2. In Play Console, **Users and permissions > Invite new users**: the service account's email. Under
   **App permissions** add `cezar` with **Release to testing tracks** and **Manage testing track
   releases** (nothing else).

### 2.4 GitHub secrets

Repository **Settings > Secrets and variables > Actions > New repository secret**:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The base64 of `cezar-upload.jks` from 2.1 |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | The key password (same as the keystore's if you pressed Enter) |
| `PLAY_SERVICE_ACCOUNT_JSON` | The whole JSON key file from 2.3 |
| `GOOGLE_SERVICES_JSON` | Optional: the whole `google-services.json` from Firebase |

### 2.5 The first upload

Google only accepts API uploads once the app exists, and a new app's first release must be a draft.

1. **Actions > Mobile release > Run workflow**: Android on, iOS off, `dry_run` off, `play_status`
   **draft**. The run signs the AAB and APK, checks them, attaches the APK to a **draft** GitHub
   Release `mobile-v0.1.0`, and creates a draft release on Play's **internal testing** track.
2. Play Console > **Test and release > Testing > Internal testing**: add a tester list (your own Google
   account), open the draft release, **Review release > Start rollout**. Rolling it out also enrolls the
   app in Play App Signing with the key from 2.1 as its upload key.
3. Install from the tester link on a real phone and run the [checklist](#7-store-review-checklist).
4. From then on, tags and manual runs use `play_status` **completed**, which rolls out to internal
   testing directly. Promote a tested build to closed, open or production testing in Play Console.

The APK on the GitHub Release is signed with the **upload** key, so it cannot update a Play install, or
be updated by one. Say that wherever the APK is linked. Publish the draft GitHub Release by hand.

## 3. iOS, once

1. **Identifier**: https://developer.apple.com/account/resources/identifiers > **+** > App IDs > App,
   explicit bundle ID `com.openmercato.cezar.mobile`, description `cezar`. Tick **Push Notifications**
   when iOS push lands.
2. **App record**: App Store Connect > **Apps > + > New App**: iOS, name `cezar` (if taken, `cezar:
   coding agents`), primary language English (U.S.), the bundle ID above, SKU `cezar-mobile`, full
   access.
3. **API key**: App Store Connect > **Users and Access > Integrations > App Store Connect API > Team
   Keys > +**, access **Admin** (automatic signing creates the cloud-managed distribution certificate
   and profile, which needs Admin). Download the `.p8` once. Note the **Key ID** and the **Issuer ID**
   above the table.
4. **Team ID**: https://developer.apple.com/account > Membership details.
5. **GitHub**: secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the whole `.p8` file, including the
   BEGIN and END lines); **variable** `APPLE_TEAM_ID` (Settings > Secrets and variables > Actions >
   Variables).
6. **First TestFlight build**: **Run workflow** with iOS on. It archives on a macOS runner with
   automatic signing, exports an `.ipa` (kept as a run artifact) and uploads it with `altool`.
   **The iOS app has never been compiled** (`packages/mobile/README.md`, "iOS status"): expect this
   first run, or the `iOS` leg of mobile-check, to show compile errors to fix first.
7. In App Store Connect > **TestFlight**: answer **export compliance** (see `store/data-safety.md`),
   add yourself as an internal tester, install through the TestFlight app and run the checklist.
8. **App Store tab**: App Privacy (`store/data-safety.md`), Age Rating (`store/age-rating.md`), the
   listing (`store/listing.md`), screenshots `store/screenshots/ios/iphone-6.9/` (also 6.5" and
   `ipad-13/`; the app targets iPad too), privacy policy URL, support URL, and **App Review
   Information** from `store/reviewer-notes.md`. Then **Add for Review**.

## 4. Every release

1. Bump `packages/mobile/package.json`, merge, tag `mobile-vX.Y.Z` (or `-rc.N`).
2. Watch **Actions > Mobile release**. Every skipped step says why in a notice.
3. Android: test the internal build, then promote it in Play Console. iOS: test in TestFlight, then
   submit the build for review.
4. Publish the draft GitHub Release.

## 5. Privacy policy

Both stores, and Apple's guideline 5.1.1 inside the app too, need a public privacy policy URL.

1. Fill every `[OPEN MERCATO TO CONFIRM: …]` in `packages/mobile/store/privacy-policy.md` (legal entity,
   contact, effective date, rights, relay hostname, Cloudflare terms, Firebase in the build). #1913's
   draft lists why each one is open.
2. `node packages/mobile/store/scripts/render-privacy.mjs --final` writes `privacy-policy.html`; it refuses
   while any open fact is left.
3. Host that single file at **`https://cezar.run/mobile/privacy`**: cezar.run is the project's own
   domain and already the listing's marketing URL, so the address survives a change of hosting.
   Serve it over HTTPS with no login. Any static host behind that domain works (the landing site's
   `public/` folder, Cloudflare Pages, GitHub Pages with a custom domain).
4. Put the URL in both consoles. The app already links to `https://cezar.run/mobile/privacy` from the
   connect screen (`packages/mobile/connect/index.html`, Apple 5.1.1); if you host it anywhere else,
   change that link in the same release.

## 6. Reviewer demo

Both stores must be able to use the app without our help. `packages/mobile/demo/README.md` sets up a
dry-run cezar on a small VPS, reset every night, with credentials a reviewer types into the app. Follow
it, then paste the URL and the credentials into Play Console (App access) and App Store Connect (App
Review Information > Sign-in required), as `store/reviewer-notes.md` shows.

## 7. Store review checklist

Before every submission, on a real phone with the store build (internal testing or TestFlight):

- [ ] Fresh install opens the connect screen; no crash on Android 7 (API 24) and the newest Android, and
      on the oldest supported iOS.
- [ ] Pair by QR code with a real cezar, and by typed code; the Manager opens.
- [ ] Add the demo server directly with the reviewer credentials from `store/reviewer-notes.md`, exactly
      as a reviewer would, and reach the Manager.
- [ ] Notifications: turn the switch on, leave the app, make cezar need you; the notification arrives
      (closed-app delivery only with Firebase).
- [ ] App lock on and off; Forget a server, and pair it again.
- [ ] Deny the camera: typed code still works. Deny notifications: nothing breaks.
- [ ] No debug UI, test server or placeholder text anywhere. `check-release.mjs` passed in the run.
- [ ] Listing, screenshots and description match this build (no feature it lacks, e.g. iOS pairing).
- [ ] Privacy policy URL loads without login and matches the build (Firebase, push, iOS).
- [ ] Data safety and App Privacy still match `store/data-safety.md`; nothing new was added (SDK,
      permission, network call).
- [ ] Demo server is up (`curl -fsS https://<demo-host>/api/v1/health` with the credentials) and was
      reset in the last 24 hours; credentials in both consoles are current.
- [ ] Content rating and target audience answered; export compliance answered (iOS).
- [ ] Version code and build number higher than every earlier upload (`release-version.mjs` does this
      as long as the version in `package.json` went up).
- [ ] Reviewer notes mention the relay, both pairing methods and the demo access.

Common rejections to pre-empt: **Apple 2.1** (reviewer could not sign in: demo down or wrong
credentials), **Apple 4.2** (minimum functionality: the notes explain the native parts, QR pairing,
keychain sign-in, end-to-end encrypted relay, notifications and app lock), **Apple 5.1.1** (privacy link
dead because the page is not hosted yet), **Play "App access"** (instructions missing), **Play Data safety mismatch** (an SDK
added since the form was filled).
