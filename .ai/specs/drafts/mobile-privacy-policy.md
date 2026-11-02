> **DRAFT for Open Mercato's approval. Not legal advice. Not in force.**
>
> Written by the project's manager from the code, as of branch `cez/72de188f` (forked from
> `cez/98f22e3d`, commit `6a976d15f`), on 2026-11-02. No lawyer has read it. Open Mercato approves and
> hosts the final text. Every `[OPEN MERCATO TO CONFIRM: ...]` is a fact that is not in the code.
> Remove this box, those markers and both appendices before publishing.
>
> The relay statements describe a private copy of the relay source (`patzick/rome`, commit `7c3f6fb`),
> not what is deployed. Nothing here proves that the deployed relay runs that commit.

# Cezar mobile app privacy policy

Effective date: [OPEN MERCATO TO CONFIRM: effective date]

Who this policy is from: [OPEN MERCATO TO CONFIRM: legal entity name, registered address and data
controller, if any]. Contact: [OPEN MERCATO TO CONFIRM: privacy contact address].

## What this policy covers

This policy covers the Cezar mobile app, the relay that connects the app to a computer, and push
notifications.

The app is available for Android. An iOS version is not built yet, and this policy does not describe
it. Before an iOS release this policy has to be checked again (see Appendix B).

The app is a small shell. It shows the Cezar cockpit from a Cezar server that you run or that someone
runs for you. It connects in one of two ways:

- **Through the relay**, after you pair the phone with Cezar on your computer.
- **Directly**, when you enter the HTTPS address of a server that is reachable on the internet.

## The short version

- You do not create an account with the app.
- The app contains no analytics, advertising or crash-reporting code, and sends no telemetry of its own.
- Your work, such as tasks, code and messages, is encrypted end to end between the phone and your
  computer when you use the relay. The relay cannot read it.
- The relay can still see some connection details, such as IP addresses, timing and data volume.
  These are listed below.
- Push notifications are not active yet.

## What stays on your phone

The app keeps the following in its private storage. Android's backup and device transfer are turned
off for this app, so this data is not copied to your cloud backup or to a new phone.

| Data | Why | How it is kept |
| --- | --- | --- |
| Your server list: name, address, and for direct servers the username and login realm | To reconnect | Plain JSON in app-private storage |
| For paired servers: relay address, Cezar's public identifiers and key, the phone's ID on that server, a local port number | To reconnect through the relay | Plain JSON in app-private storage |
| Your server password, if you saved one | To sign in to a direct server | Encrypted with a key in the Android Keystore that cannot be exported |
| The phone's private keys for each paired server | To prove the phone is yours and to encrypt the connection | Encrypted with the same Keystore key |
| Whether the phone lock is on | To apply the lock | An empty file. It holds no secret |
| Cookies, page storage and the browser cache of the server's pages | So the cockpit works | Android WebView's normal storage for this app |

**Removing a server.** When you forget a server, the app deletes its saved password or keys and its
entry in the list. It also clears the page storage for that server, and the cookies of a direct
server. It does not clear the WebView's HTTP cache, or cookies for a paired server, so these can stay on
the phone until you clear the app's storage or uninstall the app.

**Phone lock.** The optional lock is off by default. It uses Android's own prompt for your biometrics
or screen lock. The app never receives your fingerprint, face data or PIN. It only learns whether the
prompt succeeded. The lock hides the app, but it does not change how keys are stored. With the lock
on, the app's preview is hidden on the recent apps screen, although the app itself stays listed there.
On Android 12 and older this also blocks screenshots of the app.

## Permissions

| Permission | Why |
| --- | --- |
| Internet | To reach the relay or your server |
| Camera | Only to scan the pairing QR code, when you choose to. The app reads the code on the phone and does not save or send the images |
| Biometrics (`USE_BIOMETRIC`, `USE_FINGERPRINT`) | Only for the optional phone lock. These come from the Android biometric library |

If a cockpit page offers a file upload, Android's file picker opens. Only the file you pick is sent, and
it goes to your Cezar server.

The app asks for no location, contacts, microphone or advertising ID access.

## What Cezar on your computer keeps about your phone

This data is on your own computer, in `~/.cezar/relay/devices.json`, and is readable only by your
user account. It does not reach us through this mechanism.

- The phone's name, taken from the phone's model name, which you can rename
- The platform (`android`)
- The phone's public keys and its device ID
- When it was added and when it was last seen
- Push grant IDs, once push exists

You can remove a phone in Cezar's Settings. Cezar deletes the entry and tells the relay to remove the
phone. If you forget a server in the app while Cezar is reachable, the entry is deleted as well.
Otherwise it stays until you remove it on the computer.

## What the relay does

The relay passes encrypted data between your phone and your computer. Nothing reaches the relay until
you click **Test** or **Connect a phone** in Cezar on your computer. Your computer keeps a connection
to the relay only while a phone is paired.

The app's default relay on this version is `https://rome.patzick.workers.dev`. This is a test address
and is expected to change: [OPEN MERCATO TO CONFIRM: production relay hostname]. If you set a different
relay address, whoever runs that relay is responsible for it, and this section does not apply to them.

**What the relay cannot see.** Requests, responses, your code, tasks, messages, files and passwords.
These are encrypted with the Noise protocol between your phone and your computer, and the relay never
has the keys. It also never sees the pairing QR code.

**What the relay can see while it works:**

- Your IP address and your computer's IP address
- The public keys and identifiers used to connect: Cezar's ID, the phone's device ID and, during
  pairing, a one-time locator and the public keys in the handshake
- When each side connects and disconnects, and whether the other side is online
- How much data passes and when. Messages are padded to multiples of 256 bytes, which hides exact
  sizes but not overall volume
- How many phones are connected to a computer

**What the relay stores:**

| Data | How long |
| --- | --- |
| Cezar's ID, when it was last connected, and the list of paired phones (device ID and public key, at most 10) | Until the phone is removed, or until the relay's daily cleanup deletes the record 90 days after Cezar was last seen |
| Daily and hourly usage counters for abuse limits: data volume, phone connection time, pairing and push counts | Overwritten each period, deleted with the record above |
| Cezar's ID and the last-seen day, in an index used by the cleanup | Until the cleanup deletes the record |
| A salted hash of your IP address, used only for rate limits | The stored limit is removed after one hour |
| Pairing state | Not stored. It ends when both sides disconnect, within five minutes at most |

The relay does not store your IP address in plain form, or keep any message it forwards. It holds no
undelivered messages. The relay's code writes no logs, and Cloudflare's Workers logging is off in its
configuration. It reports one aggregate usage figure with no ID in it: time awake, phone-connected
time and the number of wake-ups.

A hashed IP address can still count as personal data, because someone holding the salt could test
guesses against it. [OPEN MERCATO TO CONFIRM: how this is classified, and the lawful basis for the
relay's processing]

## Third parties

- **Cloudflare** runs the relay, using Workers and Durable Objects. Because Cloudflare carries the
  traffic, it handles the connection details above, including IP addresses. What Cloudflare itself
  keeps is set by its own terms, not by the relay's code. [OPEN MERCATO TO CONFIRM: Cloudflare account
  holder, data processing agreement, regions, Cloudflare's retention]
- **The Cezar server you connect to.** It receives everything you do in the cockpit. If you run it,
  that is you. If someone else runs it, their own terms apply.
- **The coding agents your Cezar runs** are chosen and configured by you on your computer. The app does
  not process that data and does not contact those services.
- **Hosts of images shown in the cockpit.** Cockpit pages can show images stored elsewhere: GitHub
  profile pictures, images inside issue, pull request and tracker text, images in your agents' messages,
  and a project picture set by its address. Your phone loads each one directly from its host, so that
  host can see your phone's IP address and the time. The relay does not hide this. Whoever wrote the
  text chooses the host, and that can be someone you do not know.
- **Your phone's browser.** Links that lead away from your server open in your browser, which has its
  own policy. A direct server that uses single sign-on shows that provider's login page in the app.

We do not sell data. The app contains no advertising. [OPEN MERCATO TO CONFIRM: the "we do not sell"
statement as a company commitment]

## Telemetry

The app sends no telemetry and has no analytics or crash-reporting library. The relay's code sends none
either, apart from the aggregate usage figure above.

The cockpit inside the app can report usage to Cezar on your computer. Your Cezar forwards it to Open
Mercato only if you opted in. That is Cezar's own opt-in telemetry, described in Cezar's telemetry
documentation. An answer to that question given on the phone is saved as your Cezar's answer.

## Push notifications (not active)

**Push is not part of the app today.** The app has no push code, requests no notification permission,
and sends no push token anywhere.

The relay source already contains push code that has never delivered a real notification. The following
describes that plan. It may change, and it does not apply until a release says so:

- The phone would obtain a token from Firebase Cloud Messaging (Google), or from Apple Push Notification
  service on iOS, and send it to the relay. The relay would encrypt it into a grant and hand the grant
  back, without storing the token.
- A notification would carry the fixed text "Cezar needs you", a count, and Cezar's ID. It would hold no
  task, project or message text. Google or Apple would see that notification, the token and the time.
- The relay would keep a grant's ID if the grant is revoked, for up to 90 days, so it cannot be reused.
  It would keep push IDs for about 10 minutes to stop replays.

## Your choices

- Forget a server in the app, or remove a phone on your computer. Either one stops the connection.
- Turn the phone lock on or off.
- Uninstalling the app removes its data from the phone.
- Deny the camera permission and pair by typing a code instead.

Records on the relay contain no name or email. They hold keys and IDs. To ask about your data:
[OPEN MERCATO TO CONFIRM: how to make a request, which rights apply, response time, supervisory
authority].

## Other terms

- Children: [OPEN MERCATO TO CONFIRM: children's clause and minimum age]
- International transfers: [OPEN MERCATO TO CONFIRM: transfer basis and countries, given Cloudflare]
- Changes to this policy: [OPEN MERCATO TO CONFIRM: how changes are announced]
- Governing law: [OPEN MERCATO TO CONFIRM: jurisdiction]

---

# Appendix A: claims and their sources (remove before publishing)

Paths are relative to the repository root. `A/` means
`packages/mobile/android/app/src/main/java/com/openmercato/cezar/mobile/`, `R/` means
`packages/mobile/android/app/src/main/res/`, and `rome/` means the private relay copy at commit
`7c3f6fb`. The third column quotes the cited line, and every
quote was checked by a script against the file. A "nothing found" claim was checked by searching, as
noted in the table after this one.

| # | Claim | Source | Text at that line |
| --- | --- | --- | --- |
| 1 | Backup is off | `packages/mobile/android/app/src/main/AndroidManifest.xml:6` | `android:allowBackup="false"` |
| 2 | Cloud backup excludes every domain | `R/xml/data_extraction_rules.xml:3` | `<cloud-backup>` |
| 3 | Device transfer excludes every domain | `R/xml/data_extraction_rules.xml:4` | `<device-transfer>` |
| 4 | App state lives in the no-backup directory | `A/shell/ShellServices.java:28` | `getNoBackupFilesDir()` |
| 5 | Server list is one JSON file | `A/shell/ServerListStore.java:17` | `"servers.json"` |
| 6 | Direct server fields, in plain JSON | `A/shell/ServerListStore.java:109` | `.put("url", server.url)` |
| 7 | Username and realm are saved | `A/shell/ServerListStore.java:110` | `"username"` |
| 8 | Relay server fields | `A/shell/ServerListStore.java:105` | `"cezarKey"` |
| 9 | Passwords are sealed blobs | `A/shell/CredentialStore.java:29` | `cipher.seal` |
| 10 | Keystore key, AES-GCM, non-exportable | `A/shell/KeystoreCipher.java:13` | `non-exportable Android Keystore key` |
| 11 | Device keys sealed with the same cipher | `A/shell/ShellServices.java:71` | `new KeystoreCipher()` |
| 12 | Lock setting is an empty file | `A/shell/LockSetting.java:6` | `as an empty file's presence` |
| 13 | Page storage is on in the WebView | `A/shell/ServerActivity.java:280` | `setDomStorageEnabled(true)` |
| 14 | Forget deletes keys, password and list entry | `A/shell/ShellConnector.java:188` | `credentials.delete(id)` |
| 15 | Forget clears relay page storage | `A/ConnectionPlugin.java:97` | `deleteOrigin` |
| 16 | Forget clears a direct server's cookies and storage | `A/ConnectionPlugin.java:256` | `clearWebsiteData` |
| 17 | Lock is optional, off by default, 60 s | `packages/mobile/README.md:27` | `Optional and off by default` |
| 18 | Lock uses the system prompt, biometric or credential | `A/shell/AppLock.java:32` | `BIOMETRIC_WEAK` |
| 19 | Lock is a UI gate, not a key gate | `.ai/specs/2026-11-01-relay-qr-pairing.md:945` | `UI gate, not a key-release gate` |
| 20 | Lock hides the recents preview, Android 13 and later | `A/shell/AppLock.java:180` | `setRecentsScreenshotEnabled` |
| 21 | Internet permission | `packages/mobile/android/app/src/main/AndroidManifest.xml:68` | `android.permission.INTERNET` |
| 22 | Camera permission | `packages/mobile/android/app/src/main/AndroidManifest.xml:69` | `android.permission.CAMERA` |
| 23 | Camera is the QR scanner | `A/ConnectionPlugin.java:123` | `ScanOptions.QR_CODE` |
| 24 | Only the decoded text leaves the scanner | `A/ConnectionPlugin.java:137` | `startQr(contents)` |
| 25 | Biometric library is a dependency | `packages/mobile/android/app/build.gradle:45` | `androidx.biometric:biometric` |
| 26 | File picker only on a page's request | `A/shell/ServerActivity.java:503` | `onShowFileChooser` |
| 27 | Phone name is the model name | `A/shell/ShellServices.java:44` | `Build.MODEL` |
| 28 | Phone sends name, platform, key in the handshake | `A/shell/relay/PairingClient.java:246` | `.put("platform", "android")` |
| 29 | cezar's device file path | `packages/cezar/src/relay/devices.ts:7` | `~/.cezar/relay/devices.json` |
| 30 | Device record fields | `packages/cezar/src/relay/devices.ts:17` | `label: z.string().max(200)` |
| 31 | Added and last-seen times | `packages/cezar/src/relay/devices.ts:22` | `lastSeenAt` |
| 32 | Grants are tracked, empty until R5 | `packages/cezar/src/relay/devices.ts:23` | `Sealed grants arrive with push (R5)` |
| 33 | File mode 0600, directory 0700 | `packages/cezar/src/workspace/config.ts:466` | `openSync(tmp, 'w', 0o600)` |
| 34 | A phone can be renamed on the computer | `packages/cezar/src/relay/service.ts:554` | `this.devices.update(deviceId, { label })` |
| 35 | Remove deletes the row and queues the relay command | `packages/cezar/src/relay/devices.ts:115` | `Deletes the row and remembers the relay command` |
| 36 | Forget sends goodbye, which deletes the row | `RELAY_PROTOCOL.md:606` | `goodbye` |
| 37 | Row stays if cezar is unreachable | `.ai/specs/2026-11-01-relay-qr-pairing.md:575` | `Otherwise the row stays until` |
| 38 | Nothing reaches a relay before a click; socket only while paired | `AGENTS.md:27` | `Nothing reaches a relay before **Test**` |
| 39 | Socket closes when no phone is left | `packages/cezar/src/relay/service.ts:129` | `this.devices.list().length === 0` |
| 40 | Default relay, app | `A/shell/relay/RelayOrigin.java:19` | `https://rome.patzick.workers.dev` |
| 41 | Default relay, cezar | `packages/cezar/src/relay/wire.ts:68` | `https://rome.patzick.workers.dev` |
| 42 | Payload is ciphertext only, relay assumed hostile | `RELAY_PROTOCOL.md:13` | `ciphertext only` |
| 43 | Relay never sees the QR string | `RELAY_PROTOCOL.md:18` | `the relay never sees the string` |
| 44 | Relay sees `cezarId` | `RELAY_PROTOCOL.md:38` | `cezarId` |
| 45 | Relay sees `deviceId` | `RELAY_PROTOCOL.md:39` | `deviceId` |
| 46 | Relay sees `locator` for one rendezvous | `RELAY_PROTOCOL.md:40` | `locator` |
| 47 | A relay sees public static keys, never a private one | `RELAY_PROTOCOL.md:47` | `sees public static keys` |
| 48 | Ed25519 public key sent on each proof | `RELAY_PROTOCOL.md:78` | `X-Cezar-Relay-Key` |
| 49 | Records pad to multiples of 256 bytes | `RELAY_PROTOCOL.md:622` | `multiple of 256 bytes` |
| 50 | Spec's list of what the relay sees | `.ai/specs/2026-11-01-relay-qr-pairing.md:750` | `state what the relay sees` |
| 51 | Relay reads the source IP | `rome/src/app.ts:157` | `CF-Connecting-IP` |
| 52 | Limits key on a salted hash of the IP, never stored raw | `rome/src/app.ts:155` | `The relay never stores an address` |
| 53 | Salt is the grant seal key | `rome/src/app.ts:158` | `GRANT_SEAL_KEY` |
| 54 | IPv6 counts by /64 | `rome/src/app.ts:141` | `/64` |
| 55 | Hash limiter row deleted after an hour | `rome/src/ip-limiter.ts:30` | `deleteAll()` |
| 56 | Hour window | `rome/src/ip-limiter.ts:4` | `3_600_000` |
| 57 | Room record holds id and last sighting | `rome/src/room.ts:43` | `interface Meta` |
| 58 | Allowlist row is device id to public key | `rome/src/room.ts:271` | ``kv.put(`dev:${entry.device}`, entry.key)`` |
| 59 | At most 10 devices | `rome/src/limits.ts:5` | `devices: 10` |
| 60 | Removal deletes the row | `rome/src/room.ts:281` | ``kv.delete(`dev:${device}`)`` |
| 61 | Rooms expire after 90 days | `rome/src/limits.ts:25` | `ROOM_LIFETIME_DAYS = 90` |
| 62 | Daily cron deletes expired rooms | `rome/src/app.ts:162` | `Deletes rooms whose cezar has been gone` |
| 63 | Cron schedule | `rome/wrangler.jsonc:30` | `17 3 * * *` |
| 64 | Purge deletes all room storage | `rome/src/room.ts:378` | `deleteAll()` |
| 65 | Usage counters: bytes | `rome/src/room.ts:522` | `use:bytes` |
| 66 | Usage counters: phone time | `rome/src/room.ts:554` | `use:phone` |
| 67 | Usage counters: rendezvous | `rome/src/room.ts:320` | `use:rendezvous` |
| 68 | Registry holds id and day | `rome/src/room-registry.ts:20` | `cezar_id TEXT PRIMARY KEY, day INTEGER` |
| 69 | Rendezvous keeps nothing once sockets are gone | `rome/src/rendezvous.ts:22` | `nothing remains` |
| 70 | Rendezvous hard limit, 300 s | `rome/src/limits.ts:20` | `RENDEZVOUS_LIFETIME_MS = 300_000` |
| 71 | Relay buffers nothing | `RELAY_PROTOCOL.md:245` | `No buffering` |
| 72 | Payloads never persisted | `RELAY_PROTOCOL.md:247` | `No persistence` |
| 73 | Workers logs are off | `rome/wrangler.jsonc:7` | `"observability": { "enabled": false }` |
| 74 | Aggregate metric, no id | `rome/src/room.ts:110` | `writeDataPoint({ doubles: [awakeMs, phoneMs, wakes] })` |
| 75 | Metric points carry no room id | `rome/src/metrics.ts:16` | `Points carry no room id` |
| 76 | Cloudflare objects used | `rome/wrangler.jsonc:10` | `RoomObject` |
| 77 | Avatars load from a URL the server gives | `packages/web/src/routes/github/github.tsx:1756` | `<Avatar url={comment.avatarUrl}` |
| 78 | Off-origin subresources are not blocked | `A/shell/NavigationPolicy.java:20` | `if (!mainFrame) return Action.ALLOW` |
| 79 | Other links open in the browser | `A/shell/ServerActivity.java:319` | `Intent.ACTION_VIEW` |
| 80 | SSO stays in the app for direct servers | `A/shell/NavigationPolicy.java:21` | `An SSO login leaves the origin` |
| 81 | Cockpit telemetry goes to the user's server | `packages/web/src/lib/telemetry.ts:27` | `/api/v1/telemetry/*` |
| 82 | Server drops telemetry without consent | `packages/cezar/src/telemetry.ts:74` | `consent === 'granted'` |
| 83 | Consent route has no relay-scope gate | `packages/cezar/src/server/server.ts:8360` | `/telemetry/consent` |
| 84 | Shell telemetry: none now | `.ai/specs/2026-10-31-mobile-apps-manager-first.md:549` | `Shell telemetry` |
| 85 | Capacitor logging is off | `packages/mobile/capacitor.config.json:13` | `"loggingBehavior": "none"` |
| 86 | Push not built in the app | `packages/mobile/README.md:6` | `push` |
| 87 | Relay push never delivered for real | `rome/README.md:43` | `Real delivery to APNs and FCM has never been` |
| 88 | Relay answers 503 on push without credentials | `rome/README.md:93` | `/v1/push` |
| 89 | Grant seals the token | `rome/src/push/routes.ts:69` | `token: token as string` |
| 90 | Grant is AES-GCM sealed and handed back | `rome/src/push/routes.ts:74` | `sealGrant(env, claims)` |
| 91 | Grant holds no party's stored token | `RELAY_PROTOCOL.md:272` | `without either party's store holding the token` |
| 92 | Fixed text | `rome/src/push/types.ts:20` | `Cezar needs you` |
| 93 | No field can hold user text | `rome/src/push/types.ts:3` | `There is no field that could hold user text` |
| 94 | FCM payload carries `cezarId` | `rome/src/push/fcm.ts:34` | `data: { s: cezarId }` |
| 95 | APNs payload carries `cezarId` | `rome/src/push/apns.ts:38` | `s: cezarId` |
| 96 | Denied grants last 90 days | `rome/src/limits.ts:23` | `GRANT_LIFETIME_SECONDS = 90 * 86_400` |
| 97 | Push ids kept 10 minutes | `rome/src/limits.ts:24` | `PUSH_REPLAY_SECONDS = 600` |
| 98 | Typed code exists as a fallback | `A/shell/relay/PairingFlow.java:64` | `startCode` |
| 99 | Direct servers need HTTPS | `R/xml/network_security_config.xml:3` | `cleartextTrafficPermitted="false"` |
| 100 | Fresh device keys for each pairing | `A/shell/relay/PairingFlow.java:84` | `DeviceKeys.generate()` |
| 101 | Lock uses `FLAG_SECURE` on older Android | `A/shell/AppLock.java:182` | `FLAG_SECURE` |
| 102 | Markdown keeps Streamdown's default sanitising plugins | `packages/web/src/routes/task-thread/markdown.tsx:174` | `Object.entries(defaultRehypePlugins)` |
| 103 | Forge comment text renders through Markdown | `packages/web/src/routes/github/github.tsx:1779` | `<Markdown>{comment.body}</Markdown>` |
| 104 | Tracker text renders through Markdown | `packages/web/src/routes/tracker/tracker.tsx:229` | `<Markdown>{item.body.trim()` |
| 105 | The IP hash has no salt without the secret | `rome/src/app.ts:158` | `env.GRANT_SEAL_KEY ?? ""` |

**Claims based on a search that found nothing:**

| Claim | Check |
| --- | --- |
| No analytics, crash or Firebase code | `build.gradle:42-58` lists appcompat, biometric, coordinatorlayout, splashscreen, Capacitor, BouncyCastle, OkHttp, zxing. `capacitor.build.gradle` adds no plugin. No `google-services.json` is committed, so the conditional at `build.gradle:62-69` does nothing |
| No `android.util.Log` calls in the app's Java | Searched `A/` for `Log.x(`, no match |
| No location, contacts, microphone or ad ID | Absent from the manifest, and from a debug merged manifest built in a sibling worktree on this tree, where `USE_BIOMETRIC` and `USE_FINGERPRINT` appear through the biometric library. That merged manifest was not rebuilt on this branch. `onPermissionRequest` is not overridden, so a page cannot be granted the microphone or camera |
| No WebView HTTP cache clearing | Searched `A/` for `clearCache`, no match |
| No logging in the relay | Searched `rome/src` for `console.`, no match |
| No push in app or cezar | No Firebase dependency, no `POST_NOTIFICATIONS`, no token call. No grant-handover route in `packages/cezar/src/relay` |
| Connect screen stores nothing itself | Searched `packages/mobile/connect` for `localStorage`, `sessionStorage`, `indexedDB`, `fetch(`, no match |
| Avatars are a direct load | `github.tsx` passes `comment.avatarUrl` to an `<img>`. It is GitHub's `avatar_url` (`packages/cezar/src/server/forge/github.ts:1086`), and no CSP blocks it. Not tested on a phone. The policy names no host |
| Markdown images are a direct load | Streamdown 2.5.0's default `harden` plugin sets `allowedImagePrefixes: ["*"]`, and `markdown.tsx` does not narrow it. The `content-security-policy` headers in `packages/cezar/src` are on sandboxed file responses and the Design Mode proxy, not the cockpit page. Not tested on a phone |

# Appendix B: what Open Mercato must confirm, and store forms (remove before publishing)

## B1. Facts not in the code

1. Legal entity, registered address, and whether it is a data controller for the relay.
2. Privacy contact address.
3. Effective date, and how policy changes are announced.
4. Lawful basis for the relay's processing, and how a salted IP hash is classified.
5. Data-subject rights text, request route, response time, supervisory authority.
6. Children's clause and minimum age.
7. Jurisdiction and governing law.
8. International transfers.
9. Production relay hostname. The code still ships `rome.patzick.workers.dev`, a personal `workers.dev`
   address (spec QR1). The policy's relay section must be corrected when it changes.
10. Who holds the Cloudflare account, the data processing agreement, regions, and Cloudflare's own
    retention of request logs and Analytics Engine data.
11. That the deployed relay matches commit `7c3f6fb`, that `observability` stays off there, and that
    `GRANT_SEAL_KEY` is set. Without that secret the IP hash has no salt, and the policy's "salted hash"
    is false (claim 105). Only the copy was read.
12. Whether the 90-day and one-hour periods may be promised. They are what the code does, not a
    commitment anyone has made. The sweep reads 100 rooms per shard per day, so a backlog can run past 90
    days, and a room with a live denial stays until the denial ends.
13. The "we do not sell data" statement.
14. Where the policy is hosted, and the link inside the app and store listings (spec 5.1.1 requires both).
    The app has no such link yet.

## B2. Things found while reading, for a decision

- **Consent from a phone.** `PUT /telemetry/consent` is not gated in a relay scope, so a phone can set
  the telemetry answer for the whole Cezar (claim 83). The policy says so. The alternative is a gate
  like `requirePhones`, which is a code change outside this task.
- **Page data after Forget.** The WebView HTTP cache is not cleared, and for relay servers only page
  storage is cleared, not cookies. The policy says so. A fuller clear on forget would allow a stronger
  statement.
- **Off-origin subresources.** A cockpit page can load images from any host, because the shell only
  gates its own host (claim 78) and Markdown allows every image address (claims 102 to 104). The cases
  found are GitHub avatars, images in Markdown from forges, trackers and agents, and a pasted project
  avatar URL (`create-project-dialog.tsx`). A stranger's issue can therefore make a phone reveal its IP
  address to a host of their choosing. The policy says so. A narrower image allowlist or an image proxy
  on Cezar would allow a stronger statement. Fonts are bundled. This was a search of `packages/web/src`,
  not a network capture, so other cases may exist.
- **WebView defaults.** The manifest sets neither `android.webkit.WebView.MetricsOptOut` nor
  `android.webkit.WebView.EnableSafeBrowsing`, and `ServerActivity` does not configure Safe Browsing, so
  Android System WebView's defaults apply. These belong to the WebView, not to the app's code, and were
  not examined. Confirm whether the policy and the Play form need to mention them.
- **Relay `/p` page.** `rome/src/app.ts:19` still serves the landing page. On this branch the QR code is
  `cezar-pair:` and no longer points there (QR9), so the page is unused. The policy does not mention it.
- **Typed codes.** The protocol notes one residual risk for a typed code against a hostile relay
  (`RELAY_PROTOCOL.md:19`, spec threat model). It is an authorization risk, not a data collection, so the
  policy leaves it out.
- **Plain JSON server list.** `servers.json` is not encrypted, only app-private. The policy says so.
  Addresses and usernames would be readable from a rooted phone.

## B3. What this draft depends on

| Later change | What to update |
| --- | --- |
| Relay hostname (QR1) | "What the relay does" and items 9 to 11 above |
| Push, R5 | Rewrite "Push notifications". See below |
| Shell telemetry, planned for later (spec Q14) | "Telemetry", and the store forms |
| iOS release | See below |
| Moving `patzick/rome` to Open Mercato | The commit reference at the top, and re-read the source |

**To confirm when R5 ships:** Firebase and APNs are actually used; whether the app adds the Firebase
SDK, and whether that SDK sends anything else; the `POST_NOTIFICATIONS` permission and how it is asked;
the final payload, which today is fixed text, `count` and `cezarId`, and whether `cezarId` must go to
Google and Apple at all; where the sealed grant is kept on cezar (`grants` in `devices.ts` holds IDs
today); the token lifetime and revocation path; the per-server toggle; that a Manual server's
`POST /v1/push` behaves the same; and a real delivery test, which has never been run.

**To check for iOS:** none of the iOS code has been compiled (`packages/mobile/README.md:8`). iOS has
no relay client and no phone lock yet. It has a camera purpose string (`ios/App/App/Info.plist:70`) and
no `PrivacyInfo.xcprivacy` manifest. Check storage (Keychain accessibility, file protection, iCloud and
device backup exclusion), WKWebView data, required-reason APIs, any SDK manifests, and the camera and
network behaviour.

## B4. Draft store answers

These are drafts from the code. They were not checked against the current wording of either form, so
each answer needs a reading of the form's guidance. In particular, confirm how each form treats
end-to-end encrypted data and data processed only briefly.

### Google Play Data safety

| Question | Draft answer | Code basis |
| --- | --- | --- |
| Does the app collect or share user data? | Yes, device identifiers. Push token later | Claims 44, 45, 58 |
| Encrypted in transit? | Yes. HTTPS or WSS for everything off the phone, with Noise on top through the relay | Claims 42, 99 |
| Can users request deletion? | [OPEN MERCATO TO CONFIRM]. Removing the phone deletes its relay entry, and the room expires after 90 days | Claims 60, 61 |
| Device or other IDs | Collected: the phone's `deviceId`, and its public key. Purpose: app functionality. Required for the relay, not for direct servers. Not shared. Fresh per pairing | Claims 45, 58, 100 |
| IP address | Handled by Cloudflare to deliver traffic, and held by the relay only as a salted hash for one hour for abuse limits. Purpose: security, app functionality. Confirm whether this is declared as collected | Claims 51 to 56 |
| Files, messages, code | Not collected: end-to-end encrypted between the user's phone and the user's own server. Confirm against the form's end-to-end guidance | Claim 42 |
| Passwords | Stay on the phone. A direct server's password goes only to that server | Claims 9, 10 |
| Photos or camera | Not collected. The camera scans a QR code locally | Claims 23, 24 |
| App activity, crash logs, diagnostics | Not collected by the app. If the user opts in to Cezar's telemetry, their Cezar sends usage events to Open Mercato, some caused by use on the phone. Confirm whether this needs declaring | Claims 81 to 84 |
| Location, contacts, financial, health, advertising ID | Not collected | Search table above |
| Push token | Not collected today. Declare when R5 ships | Claim 86, spec line 752 |

### Apple privacy labels (provisional)

iOS is not built and has no relay client, so these describe the intended Android-equivalent behaviour and
must be redone against a real iOS build.

| Category | Draft answer | Code basis |
| --- | --- | --- |
| Identifiers: Device ID | Collected for app functionality, not linked to identity, no tracking. Applies once iOS has the relay client | Claims 45, 58 |
| Identifiers: User ID | Not collected. No account exists | `RELAY_PROTOCOL.md:45`, "no account or registry exists" |
| Contact info, financial, health, location, contacts | Not collected | Search table above |
| User content | Not collected: end-to-end encrypted to the user's own server | Claim 42 |
| Diagnostics, usage data | Not collected by the app. Same telemetry question as Play | Claims 81 to 84 |
| Device token (push) | Not collected today. Revisit at R5 | Claim 86 |
| Tracking | No tracking | No SDK, search table above |
