# Data safety (Google Play) and App Privacy (App Store)

Answers from the code at the top of the mobile stack (#1901 on #1883), checked against the release
APK's merged manifest (`aapt2 dump permissions`) on 2026-11-10. The longer reasoning, with a source for
each claim, is in #1913's draft (`.ai/specs/drafts/mobile-privacy-policy.md` on `cez/72de188f`,
Appendix A). Re-check this file whenever the app gains an SDK, a permission or a network call.

**What leaves the phone, and to whom:**

| Data | Goes to | When | Protection |
| --- | --- | --- | --- |
| Everything shown and typed in the cockpit | The user's own cezar | Always | Relay: Noise end-to-end encryption, the relay cannot read it. Direct: HTTPS to the user's server |
| Direct server password | The user's server only, as the Basic answer | Direct servers | HTTPS. Never reaches page JavaScript or the relay |
| Device ID (random, per pairing) and public keys | Relay (Open Mercato, on Cloudflare) | Relay servers | TLS. Stored on the relay until the phone is removed, or 90 days after cezar was last seen |
| IP address | Relay, as a salted hash for one-hour rate limits; Cloudflare, to carry traffic | Relay servers | Not stored in plain form by the relay's code |
| Firebase installation ID and FCM push token | Google (Firebase Cloud Messaging) | Only after the user turns notifications on, and only in a build with `google-services.json` | TLS. The relay seals the token into a grant and does not store it |
| Notification content | Google, Apple later | Each push | Fixed text "Cezar needs you" and cezar's ID only |
| Images in cockpit pages (GitHub avatars, Markdown images) | Their own hosts | When a page shows one | Ordinary HTTPS loads; the host sees the phone's IP |

No analytics, advertising, crash-reporting or attribution SDK. `firebase_analytics_collection_enabled`
and FCM auto-init are off in the manifest. No advertising ID, location, contacts, microphone, photos
or files are read by the app. The camera image is decoded on the phone and never stored or sent.

## Google Play: Data safety form

Play Console > **Policy and programs > App content > Data safety**.

**Overview**

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** |
| Which of the following methods of account creation does your app support? | **My app does not allow users to create an account** (no account exists; a direct server's login belongs to the user's own server) |
| Do you provide a way for users to request that their data is deleted? | **Yes**: removing the phone in cezar (Settings > Connect a phone) or forgetting the server in the app deletes the relay record. Give the privacy policy URL as the deletion route |

**Data types.** Declare exactly these:

| Category > type | Collected | Shared | Processed ephemerally | Required or optional | Purposes |
| --- | --- | --- | --- | --- | --- |
| Device or other IDs > Device or other IDs | Yes | No | No | Required (relay pairing). Push token: optional | App functionality |

For that row, the IDs are the relay device ID and public keys, the Firebase installation ID and the
FCM token. Firebase is Google acting as a service provider, which Play does not count as sharing.

**Declare as not collected**, with the reason to keep on file:

| Type | Why not |
| --- | --- |
| Messages, Files and docs, Other user-generated content, Emails | Sent only to the user's own cezar. Through the relay it is end-to-end encrypted, so the developer can never read it; directly it goes to a server the user runs. Play's guidance exempts end-to-end encrypted data; **confirm the direct case against the current form text** |
| Passwords / Credentials | Kept in the phone's Keystore; sent only to the user's own server |
| Photos and videos | The camera scans a QR code on the phone; no image is stored or sent |
| App activity, App info and performance (crash logs, diagnostics) | No telemetry or crash SDK. cezar's own opt-in telemetry is sent by the user's cezar, not by the app |
| Location, Personal info, Financial info, Health and fitness, Contacts, Calendar, Audio, Web browsing | Not accessed |
| IP address | Play has no IP data type. The relay keeps only a salted hash for rate limits and never derives a location |

## App Store Connect: App Privacy

App Store Connect > the app > **App Privacy**. Data collection: **Yes, we collect data from this app.**

| Data type | Collected | Linked to the user's identity | Used for tracking | Purposes |
| --- | --- | --- | --- | --- |
| Identifiers > Device ID | Yes | No | No | App Functionality |

Everything else: **not collected**, for the reasons in the Play table. Tracking: **No**; no data is
used to track across apps or websites, and the app never shows the App Tracking Transparency prompt.

Before the first iOS submission:

- These answers describe Android. iOS has no relay client or push until the iOS half of #1901
  lands; re-read its code and redo this table for the build you submit.
- Apple's privacy manifest is `ios/App/App/PrivacyInfo.xcprivacy`: no tracking, no tracking domains,
  and `UserDefaults` for the app's own flags (reason `CA92.1`). Its collected data types must match the
  table above; re-read it, and the manifest of any SDK the build adds, before each submission.
- **Export compliance** (asked for every build, or set `ITSAppUsesNonExemptEncryption` in
  `Info.plist`): the app implements end-to-end encryption with standard algorithms (Noise with
  X25519 and ChaCha20-Poly1305). That is "standard encryption algorithms", not exempt as HTTPS-only
  would be. It qualifies as mass-market under EAR 5A992/5D992, which in the US means a yearly
  self-classification report to BIS. Have the person responsible for compliance confirm the answer
  once; then set the `Info.plist` key so builds stop asking.
