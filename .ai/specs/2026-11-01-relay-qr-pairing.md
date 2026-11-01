# Phone connection through a relay, with QR pairing

Refs `.ai/specs/2026-10-31-mobile-apps-manager-first.md` (the parent spec), PR #1879, PR #1883.

Stacked on PR #1879. Nothing in this PR is built.

Status: draft. **The wire contract now lives in [`RELAY_PROTOCOL.md`](../../RELAY_PROTOCOL.md)**, which
wins over this file. Any change to it is a separate commit and a line in the [changelog](#changelog).

## TLDR

A phone connects to a user's cezar with no server, domain, tunnel or password. Desktop Settings shows
a QR code, the app scans it, the user confirms the phone on desktop, and the phone opens on Manager.
Traffic crosses a Cloudflare relay as ciphertext. The relay can drop traffic. It cannot read it.

| Question | Decision |
| --- | --- |
| How the cockpit loads | **A small decrypting proxy inside the app, on `127.0.0.1`**, under the same plain webview #1883 built. Each cezar serves its own cockpit through the tunnel, so app and cockpit cannot drift. Bundling is rejected |
| Encryption | Noise over X25519, ChaCha20-Poly1305 and SHA-256. Each phone has its own keys |
| Pairing | One flow for QR and typed code, confirmed on desktop with a 6-digit match |
| Authorization | A relay request is a **hosted** request inside cezar, even on a laptop. A phone's requests never get local-only powers, a shell or the right to pair another phone. A task it starts still runs as the user |
| Sleep | cezar sends only runtime-answered pings while no phone is connected. Everything else starts from a phone's request |
| Push | One signed, text-free signal through the same relay. Replaces the separate relay in M11 |
| Cost | About $0.18 per cezar per month at 1 hour a day, from memory. Staying awake by mistake makes it $4 |
| Before the relay | The Manual path in #1883, the PWA, all Manager phone work and Web Push all ship without it |

The relay implementation lives in the private repository `patzick/rome`, not `open-mercato/cezar-relay`
as first planned. The contract, the cezar client and the app client stay public here, so the claim
that the relay cannot read traffic can be checked without seeing the relay.

## Evidence and its limits

Markers follow the parent spec: **[V]** was read in this repository or run here. **[M]** is from
memory and must be confirmed before anyone relies on it.

`WebFetch` and `WebSearch` were both denied in this session, so **no Cloudflare, Apple or Google page
was read**. Every Cloudflare price and limit, and every platform API claim, is [M]. Task R0 and
[Cost](#cost) say how each is confirmed. Node's `chacha20-poly1305`, X25519, Ed25519, HKDF and PBKDF2
were run locally [V], and the contract's test vector was generated with them.

Corrections to what the work assumed:

| Assumed | Found |
| --- | --- |
| The relay needs a mapping onto the host guard | The guard needs a one-line change. **The real exposure is `localHandoff`**, see [Authorization](#authorization-on-the-cezar-side) |
| Bundling would remove the tunnel problem | It moves assets only. Every API call still needs a tunnel, see [Decision 1](#decision-1-how-the-cockpit-loads) |
| #1883 can be built on | Yes, but its iOS code has never been compiled, and R0 needs a working iOS build |
| A public listing can use the demo server as is | QR pairing cannot be reviewed by scanning alone, see [App Store](#app-store-impact). Custom encryption also adds an export question |

## Problem statement

The parent spec makes a phone reach cezar over `https://` with a Basic gate, which means running
`server-install`, a tunnel or a VPS. A default cezar is a loopback process on a laptop and answers
403 to anything else (`server.ts:1765`). Most users have no public server, so the app does nothing
for them. A hosted relay removes that step, but it must not become a place where prompts and code can
be read, and it must cost nothing while nobody is looking.

## Goals and non-goals

Goals: pairing in under a minute with nothing to configure, end-to-end encryption against a hostile
relay, a relay that sleeps when no phone is connected, one key per phone with removal per phone, and
the Manual path unchanged under Advanced.

Non-goals: a relay account or login, relaying to a browser, using the phone as a terminal, waking a
sleeping laptop, delivering work while a phone is offline, multi-user access to one cezar, and any
relay implementation in this repository.

This reverses the parent spec's non-goal "a relay that tunnels traffic to the server". See
[Changes to the parent spec](#changes-to-the-parent-spec).

## Decision 1: how the cockpit loads

**Decision: an in-app decrypting proxy on loopback.** #1883 assumes that a page's origin is its
server. With a relay there is no `https://` origin to load from, so something on the phone must turn
webview requests into tunnel frames.

### Bundle, or proxy

| | Bundle the cockpit in the app | In-app decrypting proxy |
| --- | --- | --- |
| API traffic | **Still needs a tunnel.** Page JavaScript cannot hold the keys (see below), so a native proxy or bridge is needed anyway | The tunnel |
| Assets | Shipped in the app | Fetched from cezar through the tunnel, then cached by the webview |
| App and cezar versions | **A new matrix.** One app build must talk to every cezar in use, but the HTTP contract is versioned in lockstep with the server and says it cannot model skew (`packages/contract/src/health.ts:83`) [V] | None. The page always matches its cezar. Only the small tunnel protocol is negotiated |
| A UI fix reaches phones | Through store review | With the cezar update, as the parent spec promises |
| Multiple servers | One bundle against several versions | Each serves its own |
| Cold start | Instant shell, then an API wait | First load sends the whole bundle over the relay. Hashed assets are then cached as immutable (`server.ts:1932`) [V] |
| Guideline 2.5.2 | Cleanest | Same stance as the parent spec: it shows the user's own server |
| Origin guard and CORS | Needs a tunnel or a widened guard, which the parent spec rejected | No widening |

Bundling buys a faster first paint and costs the version matrix, the store delay and the parent
spec's central promise. Since it still needs the proxy for data, it is rejected.

**Keys cannot live in the page.** The cockpit renders agent output. The parent spec's rule is that page
script has no path to credentials, and a tunnel written in JavaScript would break it. The proxy sits
below the webview: the page sees an ordinary origin and never touches a key.

### Which proxy

| | Scheme or request interception | Loopback HTTP server in the app |
| --- | --- | --- |
| Mechanism | `WKURLSchemeHandler`, `shouldInterceptRequest` | `127.0.0.1:<port>`, one small native class per platform |
| Android `POST` body | **Not available** in `WebResourceRequest` [M]. Every write would need injected script | Available |
| `EventSource` and streaming | Varies by platform [M] | Plain HTTP |
| Secure context | Custom schemes may not count [M] | `127.0.0.1` counts [M] |
| Same code path on both platforms | No | Yes |
| Other apps on the phone | Unreachable | **Can reach the port**, so it needs the gate below |
| Cleartext rules | Unchanged | Needs one exception for `127.0.0.1` |

The missing Android `POST` body decides it, since every approval is a `POST`. R0 tests this on real
devices. If the loopback listener fails on iOS, the fallback is scheme handling on iOS and loopback on
Android. If both fail, stop and return this decision to the maintainer.

### The proxy's rules

- Binds `127.0.0.1` only, on a port saved per server, so each server keeps its own origin, storage and
  HTTP cache across launches.
- **Only the server on screen has a listener.** Opening another server closes the first. Cookies and
  `SameSite` ignore ports, so two listeners would share one cookie and each could be reached from the
  other's page.
- Each time a listener opens, native code puts a new random 256-bit `HttpOnly`, `SameSite=Strict` cookie
  in the webview store. A request without it gets 403, which keeps other apps out. It never appears in a
  URL.
- `Host` must be exactly `127.0.0.1:<port>`, which stops DNS rebinding.
- `Origin`, if present, must be that same authority, and `Sec-Fetch-Site`, if present, must be
  `same-origin` or `none`. A page on another loopback port sends `same-site`, not `cross-site`
  (`server.ts:1798`) [V]. iOS 15 may not send the header [M], so the single listener is what holds
  there. This is where CSRF is stopped, because the only browser involved is on the phone.
- The proxy then **drops** `Host`, `Origin`, `Cookie`, `Authorization`, `Sec-Fetch-*` and `X-Forwarded-*`
  and adds only the `CezarMobile/` User-Agent. It refuses `Upgrade`. No WebSocket crosses the tunnel:
  in the hosted view the cockpit uses HTTP and SSE already (`global-events.tsx`) [V].
- When the app leaves the foreground, the listener stops serving, and SSE dies with it, which is already
  the normal phone case and the existing reconnect path handles it. On Android it keeps the port bound
  and answers 503, so no other app can take it while the process lives. iOS suspends the app, so it
  closes the port and reopens it on return, before the webview resumes.
- **A taken port is hostile, not busy.** The page in the webview would send its cookie and request bodies,
  approvals included, to whoever holds that port. So a failed rebind tears the page down first, then loads
  a new port with a new cookie. Only that origin's storage is lost.

### What changes in #1883

**Survives unchanged:** the separate plain server webview and "no bridge on server pages", all
framework-free classes and `check-framework-free.mjs`, `KeystoreCipher` and the credential stores,
`cezar://servers`, the User-Agent token, external links, Android back, renderer-death handling, Forget
server's process restart, and all Basic code for the Manual path.

| File or area in #1883 | Change |
| --- | --- |
| `ServerRecord` | Becomes two kinds. `manual` keeps today's fields. `relay` holds `cezarId`, relay host, pinned key, `deviceId` and port, with no URL or password |
| `ServerOrigin` | Unchanged for Manual, where `parse` still refuses `http`. A new `ProxyOrigin` type gives gates the exact `http://127.0.0.1:<port>`, not a general `http` allowance |
| `NavigationPolicy`, and `RequestGate` on Android | Take the common origin type. The SSO `https` redirect branch applies to Manual only |
| `HealthProbe`, and `HttpGet` on Android | Gain a tunnel transport. `HealthClassifier` reads the same JSON |
| `StartDecision` | The table stays. New routes: `CEZAR_OFFLINE`, `RELAY_DOWN`, `DEVICE_REMOVED`, `PROTOCOL_MISMATCH`. Basic routes cannot occur on a relay server |
| `ServerActivity`, `ServerViewController` | Load the proxy origin for a relay server, and show the native [connection banner](#how-a-failure-appears-in-the-app) over the page |
| `BasicChallengeResponder` | Not used for relay servers, which get no challenge |
| Connect page | First screen becomes Scan QR code and Enter code. The URL form moves under Advanced, word for word |
| `network_security_config.xml`, `Info.plist` | One cleartext exception for `127.0.0.1`, and `NSCameraUsageDescription` plus Android's `CAMERA`. Remote cleartext stays refused |
| New native code | Noise, tunnel, proxy and scanner, as framework-free classes. Android's `minSdkVersion` 24 predates platform X25519 [M], so it needs one crypto library. iOS 15 has CryptoKit [M] |
| `README.md`, BACKWARD_COMPATIBILITY.md §6b | §6b arrives with #1883, so its clause is R4's to add. §6b keeps every clause and gains the tunnel protocol version. Its rule that any shell must work with any cezar holds through negotiation, see [Version mismatch](#version-mismatch) |

The password rules, one-answer rule and Android restart logic stay on the Manual path only, because a
relay server has no password.

### Version mismatch

| Layer | Handling |
| --- | --- |
| Cockpit | Cannot drift. It comes from cezar |
| Tunnel protocol | Each side states `{ min, max }` when a session starts, cezar in the `KK` reply and the phone in `HELLO`, and they use the highest shared version |
| No shared version, app too old | "Update the app", with a store link |
| No shared version, cezar too old | "Update cezar on your computer" |
| Relay contract | `/v1` in the path, and 4426 if retired. cezar and the app each read `hello` limits rather than build them in |
| New cockpit features | Capabilities, as the parent spec requires |
| A cezar older than this feature | Has no Connect a phone screen, so it cannot be paired. Manual still works |

## Relay contract

**Moved to [`RELAY_PROTOCOL.md`](../../RELAY_PROTOCOL.md), with vectors in `test-vectors/relay/`.** Endpoints,
proofs, frames, control frames, rendezvous, relay behaviour, the push signal, limits and close codes
are there, restated and closed. Protocol version stays 1. This spec keeps the reasoning.

The relay is built in the private repository `patzick/rome` and assumed hostile. It is trusted for
availability and nothing else.

Maintainer decisions on the conflicts `patzick/rome#1` raised, applied to rules 1 and 6 of
[§6 Relay behaviour](../../RELAY_PROTOCOL.md#6-relay-behaviour):

| Rule | Was | Now |
| --- | --- | --- |
| 1 Sleep | Alarms allowed to expire storage, at most once a day | **Rooms have no alarm.** `RendezvousObject` keeps one one-shot alarm of at most 300 s, the only way a 4408 can fire |
| 6 Storage expiry | Timing unstated | **A daily cron deletes expired rooms.** The 90-day rule and the live-denylist exception stand |

### What rome#1 changed

Every flaw, assumption and client change from that PR's body, adopted or rejected. "Adopted" means it
is normative in `RELAY_PROTOCOL.md`.

| Item | Verdict | Where, and why |
| --- | --- | --- |
| Flaw 1: `POST /v1/push-grants` unlimited and not tied to the allowlist | Adopted | §7. Shares the per-IP counter; denials from keys off the allowlist have their own pool, 8 per key |
| Flaw 2: `frameBytes` asymmetric | Adopted | §8. Ciphertext at most `min(65,535, frameBytes − 17)` |
| Flaw 3: one `ping` per 20 s cannot be enforced | Adopted | §4. A client rule, and the text says the relay cannot enforce it |
| Flaw 4: `phoneSecondsPerDay` only checked on an event | Adopted | §6 rule 7 |
| Flaw 5: no mechanism for the demo's raised `rendezvousPerHour` | **Rejected as written** | `hello` reports limits, it cannot set them. No wire change. The relay needs a per-`cezarId` override, which R6 must ask of `patzick/rome` |
| Flaw 6: phones hear nothing when a cezar socket is replaced | Adopted | §4 Replacement, §10.1 |
| Departure: rooms have no alarm, daily cron | Adopted | Owner decision, §6 rules 1 and 6 |
| Departure: rendezvous keeps one alarm | Adopted | Owner decision, §6 rule 1 |
| Departure: `too-many-grants` | Adopted | §4 `error` table |
| Ordering: per-IP limit before signature | Adopted | §3.1. Not observable to a client |
| Unknown route or bad shape, 404 `no-route` | Adopted | §3.2 |
| Other version, 426 `protocol-unsupported` | Adopted | §3.2 |
| Socket route without `Upgrade`, 400 `upgrade-required` | Adopted | §3.2 |
| Wrong method, 405 `method-not-allowed` | Adopted | §3.2 |
| Malformed `POST`, 400 `bad-request` | Adopted | §3.2 |
| Bad proof on a `POST`, 401 | Adopted | §3.2, §7 |
| Kill switch, 503 `relay-disabled` with `Retry-After: 300` | Adopted | §3.2 |
| Phone over `phoneSockets`, 429 | Adopted | §3.2 |
| `device-sync` closes phones that fell off, 4403 | Adopted | §4 |
| First-seen `cezarId` over `newRoomsPerHour`, 429 with 3600 | Adopted | §3.2 |
| `framesPerSecond` counts text | Adopted | §6 rule 7, §8 |
| A closing cezar socket counts as a sighting | Adopted | §6 rule 6 |
| Over `phoneSecondsPerDay`, phones close with 4430 and cezar stays | Adopted | §6 rule 7 |
| `bytesPerDay` counts each frame once, inbound | Adopted | §6 rule 7 |
| Kill switch on a live socket: `closing`, 4503 on the next frame | Adopted | §6 rule 8 |
| Phone sending a cezar command gets `unknown-frame` | Adopted | §4 |
| Non-object text closes with 4400 | Adopted | §4 |
| First cezar wins, a second is 409 | Adopted | §5 |
| A phone slot burns once used | Adopted | §5 |
| Second phone refused by HTTP 409 | Adopted | §5. Equal to 4410 |
| `peer-joined` to both; late phone accepted then 4408 | Adopted | §3.2, §5 |
| 33rd frame closes both with 4429, `ping` excepted | Adopted | §5, which also forbids reconnecting |
| Rendezvous `hello` reports 16,384, header included | Adopted | §5 |
| `rendezvousPerHour` charged to the proving key | Adopted | §3.1, §5 |
| A rendezvous counts for `newRoomsPerHour` | Adopted | §5 |
| `platform` values | Adopted | §7 |
| `POST` capped at `controlBytes`, shares the IP counter, token at most 1,024 | Adopted | §7 |
| Unopenable grant answers 410 | Adopted | §7 |
| Failed `/v1/push` answers 503 with no body | Adopted | §7 |
| `device-remove` denial lasts 90 days | Adopted | §7 |
| Revoke that creates a room is charged, 429 | Adopted | §7 |
| Missing seal key answers 503, never 410 | Adopted | §7 |
| Unstored revoke answers 503 with `Retry-After: 60` | Adopted | §7 |
| `device-remove` removes the phone first | Adopted | §4 `too-many-grants` |
| Two denial pools, 1,000 each, 8 per stranger key | Adopted | §7 |
| Usage metric shape, 10 s idle tail | Rejected for the contract | Operations, with no wire effect. It stays in `patzick/rome` |
| IPv6 /64 buckets, rate-limit binding, `wrangler.jsonc` duplication | Rejected for the contract | Relay internals. Stays in `patzick/rome` |
| Cap phone ciphertext at 65,535 bytes | Adopted | §8 |
| `peer-left` and `pair-contested` end the code | Adopted | §5, §9.4 |
| Track `grantId`s per device, at most 1,000 live denials | Adopted | §4 cezar's obligations. R3 keeps a `grants` list, empty until R5 |
| Accept `no-route`, `upgrade-required`, `method-not-allowed`, `bad-request`, `too-many-grants` | Adopted | §3.2, §4 |
| Phone ends the session on `cezar-offline`, re-handshakes after `cezar-online`, also together | Adopted | §10.1 |
| Keep a grant on 503, only 403 and 410 delete | Adopted | §7 |
| Retry a revoke on 429 or 503, only 204 means stored | Adopted | §7 |
| Every rendezvous frame counts, text included | Adopted | §5 |
| Relay host in the QR | Adopted | §9.1, with scheme and port |
| `GET /p` is live | Adopted | §3 |
| Update spec rule 1 | Adopted | Above |

### What R1 added

Gaps the design left, closed there. Each is a decision a later reader should know about.

| Addition | Why |
| --- | --- |
| Tunnel frames `HELLO` and `HEAD` | The spec's list had no way to return a status, and `KK`'s first message must be empty, so the phone's range needs a frame |
| `pending`, `approved`, `denied`, `failure` | Step 6 said "tells the phone" and no more |
| `XXpsk3` messages 1 and 2 carry nothing, and cezar's relay key waits for `pending` | Message 2 reaches anyone who knows the locator, which includes the relay. The phone's data rides message 3, under the PSK |
| cezar echoes `LEASE`, and the phone gives up after 45 s | With no echo, a phone cannot tell that cezar dropped its session, because nothing else tells it |
| Records around handshake payloads and pairing messages | The phone's name length would otherwise reach the relay |
| Two rendezvous per pairing, one for each credential | The QR and the code have different locators. So one pairing costs two of `rendezvousPerHour`, and cezar's 5 an hour exactly fits the relay's 10 |
| Response headers dropped by the proxy, `set-cookie` and `www-authenticate` | A response must not reach the proxy's gate cookie |

## Decision 2: keys, pairing and replay

### Keys

| Key | Holder | Stored | Used for |
| --- | --- | --- | --- |
| cezar Ed25519 | cezar | `~/.cezar/relay/`, through the existing secret keyring (`workspace/secret-keyring.ts`) with its `0600` fallback | `cezarId`, relay proofs, push signatures |
| cezar X25519 | cezar | Same | End-to-end handshakes |
| Device Ed25519 | One phone | Keychain or Keystore-wrapped, `WhenUnlockedThisDeviceOnly`, no backup | `deviceId`, relay proofs |
| Device X25519 | One phone | Same | End-to-end handshakes |

Keys are generated on the first Connect a phone click, and on the phone at pairing. On the Manual path,
cezar generates its Ed25519 key when the shell registers for push (parent Decision 5), and the phone
generates its device key before its first grant. Only the X25519 keys protect content. If the relay learned every Ed25519 public key, it would learn nothing new.

### Pairing

1. The user opens **Settings > Connect a phone**. cezar generates a 32-byte secret and a code, and
   opens a [rendezvous](../../RELAY_PROTOCOL.md#5-rendezvous). The QR code lasts 2 minutes, and it does not rotate by itself. When
   it expires the screen offers **Show a new code**, so a forgotten tab shows nothing usable.
2. The QR holds `<relay origin>/p#1.<secret>.<cezar X25519 key>`, and the origin comes from
   `CEZ_RELAY_URL`, under the grammar in [§9.1](../../RELAY_PROTOCOL.md#91-qr-string). A browser does not send the
   fragment, and a system camera that opens the link reaches a page explaining how to get the app. That
   page has no script, but a hostile relay could serve one that reads the fragment and pair as a phone
   itself. That is worse than a [photo](#what-if-the-qr-code-is-photographed): see [QR9](#qr9-should-the-qr-code-be-something-a-browser-does-not-open).
3. The app scans it, derives the locator and pre-shared key, and joins the rendezvous.
4. The two run `Noise_XXpsk3_25519_ChaChaPoly_SHA256`, with the phone as initiator. The phone checks
   that the key from the handshake equals the one in the QR.
5. Both screens show a 6-digit number from the handshake hash. Desktop shows the phone's name and
   platform, labelled as reported by the phone, with **Approve** and **Deny**.
6. On Approve, cezar saves the device, opens its relay socket if it has none, sends `device-add`, waits
   for `ack`, then tells the phone inside the encrypted channel. The phone connects to `/v1/phone`, and
   the normal start table opens Manager. If `device-add` fails or no `ack` arrives in 10 s, cezar deletes
   the row and both screens say the pairing failed, naming a full list for `device-limit`.
7. Deny, a timeout or a closed tab discards everything. No device row exists until step 6.

**Typed code.** The Connect a phone screen also shows, after a click, a code such as `QRFX-7KMD-2NVB`: 12 Crockford
base32 characters, 60 bits, same 2-minute life. The app runs PBKDF2-HMAC-SHA256 with 200,000 iterations
over it, and splits the output into locator and pre-shared key. A QR secret uses HKDF instead, because
it is already 256 bits. Steps 3 to 7 are identical, except that no key can be pinned in step 4, so the
6-digit match matters more.

**A typed code needs a relay address while [QR1](#qr1-what-is-the-relays-hostname-and-who-owns-its-accounts)
is open.** A code cannot carry the address and no default host exists, so desktop shows the address
beside the code, and the app's Enter code screen has a relay address field. The field goes away the day
a default host ships. Exact labels and derivations are in [§9](../../RELAY_PROTOCOL.md#9-pairing).

PBKDF2 was chosen because Node, CommonCrypto and the JDK all have it [M for the last two].

`psk3` means a passive observer of the handshake learns nothing it can test a guess against. The
locator can be tested, which is why the 60 bits sit behind a slow hash and a 2-minute life.

### What if the QR code is photographed

The QR is a one-use, 2-minute secret that opens a request, not a door. **Approval on desktop is what
grants access.**

| Scenario | Result |
| --- | --- |
| Photo used after 2 minutes | 4408, or 4404 once the rendezvous is gone. Nothing happens |
| Photo used after the real phone paired | 4404. The rendezvous is gone |
| Attacker scans first, then the user's phone tries | The phone gets 4410 and a warning, and `pair-contested` makes desktop cancel the pairing and warn, so it fails safe |
| Attacker joins while the user's phone is pairing | 4410 for the attacker and `pair-contested` on desktop, with the same result |
| Attacker scans first, the user's phone has not tried, and the user approves without looking | **Access is granted.** The 6-digit number and the phone's name are the only defence. The device then sits in the list, where Remove ends it |
| Photo plus a hostile relay, QR flow | Cannot impersonate cezar: the phone pins the key, and the attacker lacks its private half |
| Typed code read in time, plus a hostile relay | **Residual risk.** No pinned key, and an attacker on both legs could grind ephemeral keys until the 6 digits match. It needs the code within 2 minutes and control of the relay. Accepted for a fallback, and the UI says to prefer the QR code |
| Screen recording or screen share | Same as a photo |
| System camera opens the link, hostile relay reads the fragment | **Not the same as a photo.** The relay's page script has the secret and cezar's key, runs `XXpsk3`, reaches Approve and shows the same six digits, so they warn nobody. Only the user's attention at Approve stands against it, and Approve adds a device that can start tasks. Open question [QR9](#qr9-should-the-qr-code-be-something-a-browser-does-not-open) |

A code is shown only after a click, and never appears in a notification, log or `.ai/cezar/`. At most one
pairing is pending, and cezar allows 5 per hour. Each opens two rendezvous, so that exactly fits the relay's
`rendezvousPerHour`. The typed-code rendezvous opens only when the user asks to show the code, so an expired QR nobody scanned costs one.

### Sessions and replay

Each connection runs `Noise_KK_25519_ChaChaPoly_SHA256`, phone first, since each side knows the other's
key. The prologue is `cezar-session-v1 ‖ cezarId ‖ deviceId`, so a session cannot be spliced into
another room.

| Threat | Protection |
| --- | --- |
| Replayed first handshake message | cezar answers with a fresh ephemeral key, and the replayer cannot complete. **No 0-RTT**: the first message's payload must be empty, so nothing is acted on until both ephemerals are mixed |
| Replayed, reordered or dropped data frame | Noise's implicit counter makes decryption fail, and the session ends. There are no explicit nonces to reuse |
| Reflection | Each direction has its own key |
| Old traffic recorded, device key stolen later | Forward secrecy from the ephemeral keys |
| Relay replays a `POST` by repeating a session | Impossible: a session's keys are never reused and there is no resumption |
| Lost connection during a `POST` | The proxy answers 502. It **never retries a write**. The `decision` route's pins cover a user's second tap |
| Traffic analysis | Frames are padded to a multiple of 256 bytes. Timing and volume stay visible, and the privacy policy says so |

Rekey after 1 hour or 2^32 messages. Each direction rekeys on its own: the sender sends `REKEY` as its
last frame under the old key, then calls Noise's `Rekey`. A session ends with its socket.

### Noise libraries

Evaluated for R1 on 2026-11-01. **No maintained library on any of the three platforms has `XXpsk3`, `KK` and
`Rekey`, so each client carries a thin, unaudited state machine over audited primitives.** That is a finding,
not a footnote: it is what [QR8](#qr8-should-the-noise-code-be-independently-reviewed-before-a-public-listing)
exists for. `test-vectors/relay/generator/noise.mjs` is the reference.

| Platform | Candidate | Result |
| --- | --- | --- |
| Node | **`node:crypto` with a thin state machine** | **Chosen.** OpenSSL has every primitive, so the published CLI gains no dependency. R3 ports `noise.mjs` to TypeScript |
| Node | `noise-handshake` 4.2.0 | Rejected [V]: `NN`, `XX`, `IK`, `XXpsk0` and `NNpsk0` only, with `psk0` the one supported position, and no `KK` or `Rekey` |
| Node | `@chainsafe/libp2p-noise` 17 | Rejected [M]: `XX` for libp2p only |
| Node | `noise-protocol` 3.0.2, `noise-c.wasm` 0.4.0 | Rejected: last published 2023 and 2022, and native or WASM baggage for what OpenSSL has |
| Android, minSdk 24 | `org.signal.forks:noise-java` 0.1.1, `rweather/noise-java` | Rejected [V]: `KK` yes, but only the old `NoisePSK` prefix, so no `psk3` modifier, and it carries its own primitives |
| Android | **BouncyCastle `bcprov-jdk18on` 1.86, lightweight API, with a thin Kotlin state machine** | **Chosen for R4.** The API 24 platform lacks X25519 and ChaCha20-Poly1305, and PBKDF2-HMAC-SHA256 arrived at API 26 [M], so one library covers all of it. X25519, Ed25519, ChaCha20-Poly1305, HKDF and PBKDF2 are all public classes [M]. Call them directly, not through the JCA provider |
| Android | Tink `tink-android` 1.24.0 | Fallback. It has the primitives [M], but no PBKDF2, and its raw X25519 sits in `subtle` |
| iOS 15 | **CryptoKit with a thin Swift state machine, CommonCrypto for PBKDF2** | **Chosen for R4.** Platform code, with no dependency. Its Ed25519 signatures are randomized [M], so Swift verifies signature vectors and does not compare them |
| iOS | `swift-libp2p-noise` | Rejected: libp2p's handshake only. It has no `psk` or `KK` that a code search can find [V] |

### Inside the tunnel

The encrypted payload is a small stream protocol, in [§12](../../RELAY_PROTOCOL.md#12-tunnel) with test
vectors: `HELLO`, `OPEN`, `HEAD`, `DATA`, `END`, `RESET`, `WINDOW`, `LEASE`, `REKEY`, `CLOSE`.

| Rule | Value |
| --- | --- |
| Streams per session | 32 |
| Flow control | 256 KiB per stream. A stalled SSE holds no unbounded memory, and a stream over its window is reset |
| Lease | The phone sends `LEASE` every 20 s. After 60 s without one, cezar ends the session and every stream |
| Who opens streams | **Only the phone.** cezar can answer a stream, and has no frame that starts one |

The last two rows carry the [sleep requirement](#keeping-the-relay-asleep). The lease bounds how long
a phone that vanished without a close can keep traffic flowing.

## Authorization on the cezar side

### One new principal

A decrypted `OPEN` is dispatched in-process through `app.fetch`, not over a TCP socket, inside an
`AsyncLocalStorage` scope holding the device. This scope cannot be forged from the network: no header
creates it, and it exists only for a request from an authenticated session.

The design rule is short: **a relay request is a hosted request.** That matters on a laptop, where
cezar runs in local mode and `localHandoff` is true. Routes use `localHandoff` as a security boundary.
It is what closes the agent-config hooks RCE path (`server.ts:7662`), and it gates the open-in routes,
filesystem browsing and some path trimming. Had the phone arrived as a loopback request, every one of those would
open to it, and `CEZ_TERMINAL` follows the same value (`capabilities.ts:233`) [V], which would mean an
interactive shell.

So the closure at `server.ts:1606` becomes the one place that narrows:

```ts
const capabilities = () => narrowForRelay(resolveCapabilities(process.env, bindHost));
```

`narrowForRelay` returns the input outside a relay scope. Inside one it sets `localHandoff`, `terminal`,
Design Mode, system notifications and `phonePairing` to false. That covers the 69 lines reading
`capabilities()` in `server.ts` [V] in one line, and `CEZ_TERMINAL=1` on a hosted server does not reach phones either.

**Two local-only reads do not pass through that closure** [V], and each needs its own change:

| Read | Why the closure misses it | Change |
| --- | --- | --- |
| Agent accounts | `agentAccountsEnabled(process.env, bindHost)` reads the boundary directly, at eight checks in the agent-profile routes (`server.ts:2331` to `:2907`). A phone could otherwise create an account with any `configDir` | One closure that answers false in a relay scope, even with `CEZ_REMOTE_AGENT_ACCOUNTS=1`. Account management needs the machine |
| Health | `GET /health` answers from the process-wide `healthCache` (`:2037`), and `healthSnapshot` computes `capabilities` and `repoRoot` once (`:1976`, `:1992`). A phone would read the desktop's local view and full path, and a phone's refresh would publish the narrowed view to the desktop | The cache keeps only fields that do not depend on scope. The route, the topic snapshot and `refreshHealth`'s `publishHealth` (`:2053`) each add `capabilities` and `repoRoot` as they send, since a desktop that receives a push without `capabilities` drops the topic (`packages/web/src/api/queries.ts:1048`). `refreshHealth` runs outside any relay scope, so what it publishes is always the desktop's view |

### Host and origin guards

| Guard | Relay request |
| --- | --- |
| Check 1, Host allowlist (`server.ts:1765`) | Skipped, as for any hosted request, once `isHostedMode` at `:1759` reads the narrowed `capabilities()`. There is no Host to rebind: no socket was accepted |
| Check 2, Origin equals Host | No `Origin` arrives, so it takes the non-browser branch, like #1883's native probe. CSRF is stopped in the [proxy](#the-proxys-rules) |
| `Sec-Fetch-Site` | Dropped by the proxy, and by the dispatcher too |
| `verifyWsUpgrade` | Never reached. The tunnel has no upgrade |
| CORS | Not involved |
| Body limit | Applies, because the request goes through `app.fetch` |

**The guard's code changes by one line, and no check is widened.** The dispatcher removes the same
headers as the proxy, so a modified app cannot send `Host: 127.0.0.1` to look local. That would not help
it anyway, because the scope decides.

`server.ts:8421`, `:8472`, `:8533` and `:8609`, `index.ts:346` and `:349`, `workflows/run.ts:2664` and
`automations/builtin-skill.ts:26` call `resolveCapabilities` directly, but none is in a relay request
path: they are process-level state, the WebSocket upgrade, or fields `narrowForRelay` leaves alone.
`index.ts:346` still matters, because it fixes the webhook mode, covered [below](#what-a-phone-can-do).
`index.ts:378` also does, for self-update path trimming, and must move to the narrowed value. A test
walks the source so that any new direct call to `resolveCapabilities`, `agentAccountsEnabled` or
`localHandoffEnabled` in a request path fails.

**The scope follows the async chain, not the subscriber.** A `RunStore` listener runs in the context of
whoever emitted the event (`onRunEvent`, `server.ts:6511`) [V for the call site, M for Node's behaviour].
So code inside a stream's event callback must not call `capabilities()`: it would read the emitter's
scope, showing a phone's stream the local view or a desktop stream the narrowed one. A stream captures the
value once when it opens, and R3 audits every SSE handler for this.

**The scope must end with the request.** Work a request starts keeps its async context for life, and that
includes runs, timers, Manager turns and lazily started publishers. Left alone, an `alert` timer armed
under a phone's message would read the narrowed value at `server.ts:8265` and silently drop the desktop
notification, and `ManagerEngine.forward` would run narrowed or local depending on who started the turn.
So every point where work leaves a request calls `outsideRelayScope(fn)`, a thin
`AsyncLocalStorage.exit`. That means at least starting a run, `ManagerEngine.enqueue`, `refreshHealth`,
topic publishers, automation launches and lazily built project contexts, and R3's audit makes the list
complete. Work that outlives a request therefore reads the unscoped value, as it would had the desktop started it.

### What a phone can do

| A phone's requests can | A phone's requests cannot |
| --- | --- |
| Everything a hosted cockpit can, except the right-hand column: Manager, approvals, start and answer tasks, read diffs | Open a shell, edit agent config or agent accounts, use open-in routes, browse outside the browse root |
| | Use any `/workspace/phones` route. They answer 403 in a relay scope, and `phone-pairing` events are not sent to one |
| | Set `browseRoot` or `projectsDir`, or write webhooks. See below |

**Two hosted routes need their own refusal in a relay scope** [V], because hosted mode does not gate them:

| Route | Why | Change |
| --- | --- | --- |
| `PUT /workspace/config` (`server.ts:3722`) | It has no `localHandoff` check, and the browse containment at `:3384` reads the `browseRoot` it writes, so a request could move its own boundary | Answers 403 if the body sets `browseRoot` or `projectsDir`. Other fields stay |
| `/webhooks` write routes (`server/webhooks.ts`) | The coordinator captures `mode` from `index.ts:346` as `local` (`webhooks/coordinator.ts:49`), and `webhooks/destination.ts:51` and `:68` then allow `http` and private addresses | Answer 403. Webhooks are set up from the machine |

**These limits bind a phone's requests, not what a task does.** Starting a task is running code as the
user, as the guard's own comment says, and a default task has unrestricted `Bash`. So a stolen unlocked
phone can ask a task to open a shell, edit agent config, write `~/.cezar/relay/devices.json` or call the
pairing routes over loopback. The narrowing stops a compromised page or a bug from reaching local powers
directly. It does not contain a phone in the wrong hands. Only Remove does that, and a lock would. See
[QR3](#qr3-does-a-phone-need-its-own-lock).

**Full local paths are not hidden.** Hosted mode trims `repoRoot` and self-update paths, but `worktreePath`,
a project's `root` and health's `repo.root` are always sent, because a hosted reader was never on that machine. A phone will see
them. That is accepted for v1, since those paths belong to the phone's owner, and no privacy claim may say
otherwise.

### Device store and routes

Devices live in `~/.cezar/relay/devices.json`, an own file like `agent-accounts.json`, never a key in
`config.json`: `deviceId`, `label`, `platform`, both public keys, `addedAt`, `lastSeenAt`, and any sealed
grant. Deleting the directory loses pairings, and the user pairs again. That is state, not configuration.

Only `cezar serve` runs the client, never `cez run`. Identity is per home, so when a second process on the
same home connects, the first gets 4409 and stops, and Settings says which situation it is in.

New routes, contract first, in one chained workspace-level family and listed in BACKWARD_COMPATIBILITY.md §2:

| Route | Purpose |
| --- | --- |
| `GET /workspace/phones` | List, with relay status |
| `POST /workspace/phones/pairing` | Start. Returns the QR string and expiry |
| `POST /workspace/phones/pairing/:id/code` | Opens the typed code's rendezvous and returns the code (RELAY_PROTOCOL.md §9.2) |
| `POST /workspace/phones/pairing/:id/approve` and `/deny` | Decide |
| `PATCH /workspace/phones/:deviceId` | Rename |
| `DELETE /workspace/phones/:deviceId` | Remove |

A `phone-pairing` event on `/workspace/events` drives the screen. `capabilities.phonePairing` hides the
section, and it lives in Settings' global side, since a phone reaches the whole workspace.

### Removal

Remove acts on cezar first and is complete from that moment. cezar deletes the device row, ends the
session and its streams, then sends `device-remove`. If that frame is lost, the phone still fails its
next handshake, and `device-sync` repairs the relay on the next connect.

**The relay's allowlist is a cost filter, not a security boundary.** A hostile relay ignoring it gains
nothing, because cezar refuses the handshake. One phone's removal touches no other phone.

Forget server in the app is the other direction: it deletes the phone's keys, revokes its grant and, if
cezar is reachable, sends `CLOSE` with a goodbye so the row disappears. Otherwise the row stays until
the user removes it. A lost phone is handled by Remove on desktop. While cezar is off, nothing can reach
it anyway.

### Settings UI

```text
Settings › Connect a phone
┌──────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓    Scan with the Cezar app      │
│ ▓▓ QR ▓▓    Or show a typed code         │
│ ▓▓▓▓▓▓▓▓    Expires in 1:42              │
├──────────────────────────────────────────┤
│ Your phones                              │
│ Pixel 9       Connected          Remove  │
│ iPhone        Seen 2 days ago    Remove  │
├──────────────────────────────────────────┤
│ Relay: connected                         │
└──────────────────────────────────────────┘
```

Approval is a blocking dialog over Settings. It repeats the 6 digits at a large size and says plainly
that this phone can run tasks on this computer. The list stays usable from any non-relay cockpit.

### Consent and zero config

Connecting a cezar to a relay widens exposure, so it needs a recorded decision under AGENTS.md
§ Zero config. Nothing reaches the relay until the user clicks **Connect a phone**, apart from `POST /v1/push`
on a Manual server, which has its own per-server toggle and `CEZ_PUSH=0`. The socket exists
from the first Approve, while at least one device is paired, and it closes when the last is removed. `CEZ_RELAY=0` blocks
all of it. `CEZ_RELAY_URL` sets the relay origin, which goes in the QR. No host is built in while QR1 is
open, so with it unset `capabilities.phonePairing` is false. Both go in `.env.example` and
`docs/reference.md` in the commit that adds them, and the click-to-enable exception goes in AGENTS.md in
the same commit. See [QR2](#qr2-does-a-click-satisfy-the-network-opt-in-rule).

## Reachability and failure

### Keeping the relay asleep

The rule follows from the design, instead of depending on anyone remembering it:

1. An idle cezar sends only `ping`, every 45 s. `ping` has its own code path, and no other sender exists.
2. Only phones open streams, so with no session there is nothing to send.
3. `ManagerEngine.alert` reaches the push sink, which uses HTTPS and not the socket.
4. An app in the background closes its socket, and the lease catches a phone that could not.

**Guards, all required:**

| Guard | Where | Fails when |
| --- | --- | --- |
| Quiet test | Public, `packages/cezar/src/relay/` | With a fake socket and a running Manager and tasks, any frame is sent while no session exists, other than `ping` and the one `device-sync` after connecting. A device command from the user is excluded |
| Stream-origin test | Public | cezar can emit a data frame for a stream the phone did not open |
| Lease test | Public | Streams survive 60 s without `LEASE` |
| Hibernation test | `patzick/rome`, against real `workerd` | A room with one cezar socket and no phone is still in memory after the idle window, or wakes on `ping` |
| Awake ratio metric | `patzick/rome`, production | Awake seconds exceed 1.2 times phone-connected seconds, plus 60 s per wake, across all rooms for a day |

The test is what stops a bad change, and the metric catches what a test cannot, such as a platform change.

### Failure behaviour

| What failed | cezar | Phone |
| --- | --- | --- |
| Relay unreachable | Backs off, retries, and shows `Relay: unreachable` in Settings. Everything else is unaffected | See below |
| Worker deploy | 1001, jittered reconnect | Banner for seconds |
| Laptop asleep or cezar stopped | Nothing runs | `cezar-offline` |
| cezar restarts while a phone is open | Sessions end | Reconnects with a new handshake and reloads streams |
| Phone loses network | Lease ends the session in 60 s | Reconnects on return |
| Corporate network blocks `wss` | `Relay: unreachable`, with the Advanced path noted | |
| Quota or rate limit | Status line | Banner naming it |
| Push lost | Dropped. No retry | The card waits in the chat |
| Keychain locked at cezar boot | Stays disconnected and reports it. Boot continues | `cezar-offline` |

cezar never fails to boot because of the relay. No relay means a smaller cockpit.

### How a failure appears in the app

The page stays on screen. A **native** banner covers its top edge, because the cockpit cannot reliably
describe its own transport, and the proxy answers requests with 503 meanwhile. The webview is not
navigated away, so a half-written reply is not lost.

| State | Banner | Actions |
| --- | --- | --- |
| Reconnecting, under 5 s | None | |
| Relay unreachable | "Can't reach the Cezar relay. Your computer is fine. Retrying…" | Retry, Servers |
| cezar offline | "Your computer is asleep or cezar isn't running." | Retry, Servers |
| Quota | "Too much traffic today. Back in N minutes." | Servers |
| Protocol mismatch | "Update the app" or "Update cezar" | Store link |
| Device removed | Full screen: "This phone was removed from cezar." | Try again, Pair again, Forget |

On a cold launch, the same states are native screens from `StartDecision`. **A relay outage must never
read as a problem with the user's computer**, so the app distinguishes "no relay" from `cezar-offline`.
Users who need independence from the relay have the Advanced path.

## Abuse controls

The numbers are in [§8 Limits](../../RELAY_PROTOCOL.md#8-limits). This is what each one is for.

| Abuse | Control |
| --- | --- |
| Random traffic waking rooms | Signature checked in the Worker, then per-IP and per-id limits, before a room is touched |
| Free tunnel for strangers | `bytesPerDay`, `phoneSecondsPerDay`, `framesPerSecond`, 3 phone sockets. A room is useless as a CDN |
| Mass room creation | `newRoomsPerHour`, 90-day expiry, global budget alert |
| Removed phone knows `cezarId` | Rate-limited, refused by the allowlist, refused again by cezar |
| Rendezvous spam | Signed by a key, `rendezvousPerHour`, 16 KiB frames, 300 s life, no storage |
| Push spam | Grant plus signature, `pushesPerMinute`, `pushesPerDay`, fixed text, collapse key. cezar sends at most one per minute itself |
| Bug or attack raising the bill | Kill switch (4503), and a Cloudflare budget alert in `patzick/rome` |
| Compromised relay | Sees what it always saw. It can drop, delay or send junk that fails decryption. It can send **generic pushes** with its APNs key, which is why the keys stay in Cloudflare secrets, never in a repository |

App attestation is left out of v1. It would tie the relay to Apple and Google and block the Manual
users' grants, and these limits bound the cost without it.

## Cost

**All prices are from memory [M], not verified:** Durable Objects $12.50 per million GB-s with 400,000
included, $0.15 per million requests with 1 million included, incoming WebSocket messages billed 20:1,
128 MB billed per active object, hibernation free, outgoing messages and egress free, all on the $5
Workers paid plan. R2 confirms these against Cloudflare's pricing page before any budget depends on them.

At 1 hour a day, 30 days, assuming 5 frames a second on average and 20 pushes a day:

| Item | Working | Per month |
| --- | --- | --- |
| Awake time | 108,000 s × 0.125 GB = 13,500 GB-s | $0.169 |
| WebSocket messages | 540,000 ÷ 20 = 27,000 requests | $0.004 |
| Push wakes | 600 × about 10 s × 0.125 GB = 750 GB-s | $0.009 |
| **Total** | | **About $0.18** |

This agrees with the estimate of about $0.20. Frames arriving from cezar count too, since they are
incoming on its socket. Duration is over 90% of the cost, and traffic volume barely matters.

| Scenario | Per cezar, per month | Note |
| --- | --- | --- |
| Paired, phone never opened | About $0 | Hibernated socket, `ping` only |
| 1 hour a day | $0.18 | Base case |
| 4 hours a day | $0.70 | |
| At `phoneSecondsPerDay`, 8 hours a day | $1.35 | Normal traffic |
| At every limit at once | About $3.10 | 8 hours awake plus `bytesPerDay` in minimum-size frames, about 12 million billed requests. The most one room can cost by design |
| **Hibernation broken, awake all month** | **$4.05** | 24 times the base case. Also what a 5-second keepalive frame would cause |

Scale: about 28 cezars at the base case fit in the included 400,000 GB-s, so the first bill is the flat $5.
1,000 cezars cost about $182 a month, at about $0.18 each. The same 1,000 with hibernation broken cost
about $4,050, which is why the metric and test are requirements.

**Not in those figures:** Apple's $99 a year, a domain, and on-call ownership. The parent spec already
counts these.

## Push through the relay

This replaces the "Relay and native push" half of M11. The parent spec's trust model carries over, and
what changes is where it lives.

| Parent spec | Here |
| --- | --- |
| A separate Worker | The same relay |
| Server's keypair in `~/.cezar/` | The cezar Ed25519 key, so one key, not two |
| Shell registers over its native connection | The phone hands the grant over the encrypted session. A Manual server still gets it through its native authenticated connection |
| Denylist and counters in a small store | In the room |
| Payload: generic text, opaque key, count | Unchanged, and the request schema now has nowhere to put text |
| `alert`'s body discarded by the sink | Unchanged |
| Toggle per server on the shell's list, `CEZ_PUSH=0` | Unchanged |

The sink skips a device with a live session, since that phone is already looking. A sleeping phone gets
one signal. Tapping it opens the app, which reconnects and fetches state from cezar. **cezar never
queues work for a phone, and neither does the relay.**

A Manual hosted server sends the same `POST /v1/push` with no socket. See
[QR4](#qr4-may-manual-servers-use-the-relay-for-push).

## App Store impact

| Guideline | Change from the parent spec |
| --- | --- |
| 4.2 Minimum Functionality [V in parent] | **Better.** QR pairing, native scanning, keychain device keys, and an E2E transport are native value, and setup no longer needs a server |
| 2.5.2 [V in parent] | Same stance, and weaker exposure than bundling a downloaded UI. A reviewer may ask about the loopback server. Review notes say it only serves the user's own cezar |
| 2.1 demo access [V in parent] | **Harder.** See below |
| 5.1.1 privacy | Policy must name the relay, Cloudflare, APNs and FCM, and state what the relay sees: IP address, `cezarId`, `deviceId`, timing and volume. Camera purpose string needed |
| Encryption export | **New.** The app ships its own encryption. `ITSAppUsesNonExemptEncryption` must be answered. Standard algorithms likely need the App Store Connect declaration and possibly a yearly self-classification report [M]. See [QR7](#qr7-who-owns-export-compliance) |
| Play data safety | Declare the device identifier and push token. Encrypted in transit, yes |
| Background modes | None. Plain alert push only |

### How a reviewer pairs

A reviewer has no desktop cezar to scan from, so the parent spec's demo VPS (Q10) gains relay access.

1. The demo keeps `CEZ_DRY_RUN=1` and `CEZ_TERMINAL=0`, and sets `CEZ_RELAY_URL` so a dry-run server may
   use the real relay.
2. New `CEZ_RELAY_DEMO_CODE`, **honoured only with `CEZ_DRY_RUN=1`**, makes one fixed code stay valid and
   approves automatically, without the 2-minute limit. Its devices expire after 24 hours and are capped,
   and the nightly reset clears the rest.
3. Review notes hold the code, plus a QR image the reviewer can scan from another screen.
4. The demo reopens its rendezvous each time the 120 s claim window lapses, 30 times an hour. `patzick/rome`
   has no way to raise `rendezvousPerHour` for one `cezarId`, since `hello` only reports limits, so R6 must
   ask it for a per-`cezarId` override. cezar skips its own limit of 5 an hour under the demo code. The
   contract does not change.
5. Notes also include a short video of a real desktop pairing, since the desktop half cannot be seen.
6. As a backup, Advanced with the demo's URL and throwaway Basic login still works, and already exists.

The typed code covers a simulator with no camera. A test proves the demo flag does nothing without
`CEZ_DRY_RUN=1`.

## Phased plan

Sizes follow the parent spec. Each task is one PR unless noted. `patzick/rome` work is outside this
repository.

| # | Task | Ships | Depends on | Size |
| --- | --- | --- | --- | --- |
| R0 | **Transport spike** on real iPhones and Android phones: the questions below | Go or no-go report | A working iOS build from #1883 | M |
| R1 | **Public protocol.** `RELAY_PROTOCOL.md`, shared test vectors, parent spec amendments, BC entries | The contract other work builds on | This spec | S |
| R2 | **Relay in `patzick/rome`.** Contract, conformance against R1's vectors, hibernation test, metric, staging. Confirms Cloudflare pricing and limits | Staging relay | R1. Already started on the contract above | L |
| R3 | **cezar client.** `narrowForRelay`, keys, device store, dispatcher, routes, Settings UI, quiet tests | Desktop half, behind `capabilities.phonePairing` until R4 | R1. Stubbed sockets until R2 | L |
| R4 | **App client.** Noise, tunnel, proxy, scanner, connect screens, banners | Pairing on test builds | R0, R2, R3, M7 | L |
| R5 | **Push through the relay.** Replaces M11's relay half | Native notifications | R2, R4, M10 | M |
| R6 | **Public release additions.** Demo code, privacy policy, export answers. Extends M12 | Reviewable build | R5, Q10, QR7 | M |

**Ships before the relay, unchanged:** M1 installable PWA, M4 phone chat, M5 approvals, M6 Manager first,
M7 shell with the Manual path, M8 CI, M9 test tracks, and M10 Web Push. Testers with a hosted server need
nothing here. R3's `narrowForRelay` seam changes nothing until a relay scope exists, so it can land early.

**R1 and R2 run in parallel with everything.** R0 should start as soon as an iOS build exists, because a
no on it changes Decision 1. M12 depends on R5, since the parent spec requires native push before a public
listing.

**R0 must answer, on real devices:**

1. Does a loopback listener serve the webview on both platforms, including `POST`, `EventSource` and streaming?
2. Does a natively set `HttpOnly` cookie reach the first request, with no race?
3. Does iOS let the listener return on the same port after backgrounding?
4. Is a stale `WKWebView` process recovered after that?
5. Does Android's interception really lack `POST` bodies? This confirms the reason for the choice.
6. How long does a first cockpit load take over a real relay on mobile data?
7. Does `ws` stay connected to a hibernating room for 24 hours with `ping` alone?
8. Does App Transport Security accept the loopback exception in a release build?
9. On return from the background, does the iOS listener rebind before the webview's first request?

| Answer | Then |
| --- | --- |
| No on 1 on iOS | Scheme handling on iOS, loopback on Android, then repeat |
| No on 1 on both | Stop R4. Return Decision 1 to the maintainer. The Manual path is unaffected |
| No on 2 | Load a one-time native redirect path, then set the cookie from it |
| No on 3 or 4 | Accept a new port and full reload on return, if storage loss is tolerable |
| No on 5 (bodies are available) | Compare again. Loopback may still win on sharing one path |
| 6 over 10 s | Pre-cache assets natively by hash. Do not bundle |
| No on 7 | Change `ping` per `patzick/rome`'s finding, keeping the test |
| No on 8 | Fall back as for 1 |
| No on 9 | Hold the page with a native cover until the rebind result, and reload it |

## Risks

| Risk | Likelihood | Effect | Response |
| --- | --- | --- | --- |
| Loopback proxy fails on iOS | Medium | Decision 1 changes | R0 first, fallback named |
| A change wakes rooms | Medium | Bill rises 24 times | Test plus metric |
| New route reads `localHandoff` outside the closure | Medium | Phone gains a local power | Source-walking test |
| Stolen unlocked phone | Medium | Tasks run on the user's computer, with everything a task can do | Remove, [QR3](#qr3-does-a-phone-need-its-own-lock) |
| Hand-written Noise has a bug | Medium | Loss of confidentiality | No maintained library has `XXpsk3`, `KK` and `Rekey` on our platforms, so all three clients carry a thin, unaudited state machine over audited primitives. Published vectors, shared vectors, a second implementation (`snow`), and external review before public listing, see [QR8](#qr8-should-the-noise-code-be-independently-reviewed-before-a-public-listing) |
| Relay becomes a free tunnel | Low | Cost | Daily quotas, kill switch |
| One private key across all relay users | Low | Generic push spam, not content | Cloudflare secrets, rotation in `patzick/rome` |
| Single relay is a single dependency | Medium | Phones lose access | Advanced path, honest banners |
| Laptop sleeps, so Manager stops | High | User is surprised | The banner says so. Hosted cezar remains the answer for always-on |
| Private relay reduces trust | Low | Harder to believe the claim | The claim rests on public clients only |

## Backward compatibility

- Additive: new routes, a `phonePairing` capability, a `phone-pairing` event, new `~/.cezar/relay/` files.
- BACKWARD_COMPATIBILITY.md §6c is the relay contract and tunnel protocol, with versioning rules. R1 added
  it. R3 adds the §2 and §9 entries with the routes and files they describe. A breaking relay change needs a new path version and old clients served
  until a release of each has been in the wild.
- §6b from #1883 gains the tunnel protocol. Every existing clause stands.
- A server with this feature behaves identically when no phone is paired and no push grant exists, with no
  socket and no call out.
- Manual users see only the connect screen's new order.
- New env vars `CEZ_RELAY`, `CEZ_RELAY_URL` and `CEZ_RELAY_DEMO_CODE` go in `.env.example` and
  `docs/reference.md`. A new feature page goes under `docs/site`.

## Changes to the parent spec

R1 made these edits in `.ai/specs/2026-10-31-mobile-apps-manager-first.md`.

| Parent section | Change |
| --- | --- |
| Non-goals | Remove "a relay that tunnels traffic to the server" |
| TLDR, "On a hosted server" | A hosted server becomes the Advanced path |
| Decision 1, why not bundle | Keep, and link Decision 1 here |
| Decision 2, adding a server | Moves under Advanced. "HTTP is refused" stays for remote traffic |
| Decision 5, relay trust and M11 | Point at the contract here. Grants stay, in the room |
| Q9 | Extended by [QR2](#qr2-does-a-click-satisfy-the-network-opt-in-rule) |
| Q12 | Reopened by [QR3](#qr3-does-a-phone-need-its-own-lock) |
| Plan | M11 narrows to the sink's relay output, delegated to R5. M12 depends on R5 and R6 |

## Testing

- **Crypto:** Noise's published vectors in all three languages, plus the shared vectors in
  `test-vectors/relay/`, read by the Node, Swift and Kotlin tests. Tampering, reorder and replay each end
  a session. The first handshake message with a payload is refused.
- **Pairing:** expiry, single use, contested join, Deny, closed tab, no device row before approval, pinned
  key mismatch, typed code, and the limit of 5 pairings per hour.
- **Authorization:** each narrowed capability inside a relay scope. An agent-config `PUT`, open-in, terminal
  and phone routes refused. A forged `Host: 127.0.0.1` over the tunnel stays hosted. A concurrent loopback
  request stays local, and an event emitted from a relay request reaches a desktop SSE stream with desktop
  capabilities, proving that the scope does not leak. Agent-profile routes are refused, with and without
  `CEZ_REMOTE_AGENT_ACCOUNTS=1`. `/health` in a relay scope is narrowed when the cache holds the desktop's
  view, and a refresh from a relay scope changes nothing a desktop reads or receives on the `health` topic.
  A run, timer or Manager turn started from a relay request reads the unscoped value. `PUT /workspace/config`
  with `browseRoot` and every `/webhooks` write are refused, while other config fields still save. The source-walking
  test. Prove each fails without its change, by the AGENTS.md rule.
- **Empty input:** no devices means no socket, an empty `device-sync`, and absent `hello` limits fall back
  to the table.
- **Sleep:** the [guards](#keeping-the-relay-asleep).
- **Proxy:** missing cookie, wrong `Host`, foreign `Origin`, cross-site, same-site from another port,
  `Upgrade` refused, headers dropped, no write retried. Opening a second server closes the first listener,
  and a taken port tears the page down before a request goes out.
- **Push:** no text field reaches the request. A live session skips the sink.
- **Contract:** `contract-parity`, `typed-bodies`, `route-parity` and `bc-route-inventory` for the new routes.
- **Relay double:** tests here use a plain fake socket. No relay implementation enters this repository.
- **Manual:** pairing on real devices for each test-track build. An emulator proves none of the keychain,
  suspension or camera behaviour.

## Open questions for the maintainer

Each has a recommendation, and the work proceeds on it unless told otherwise.

### QR1: What is the relay's hostname, and who owns its accounts?

**Recommended: a hostname on an Open Mercato domain, and move `patzick/rome` and its Cloudflare account to
Open Mercato before a public listing.** The host ends up in QR codes and shipped apps, so it is hard to
change. The parent spec says Open Mercato owns the store accounts and the relay (Q3, Q6), while a personal
repository is what exists now. That is fine for staging.

### QR2: Does a click satisfy the network opt-in rule?

**Recommended: yes, record it in AGENTS.md § Zero config as an owner-approved exception,** like Q9: nothing
connects before the Connect a phone click, the socket lasts only while a device is paired, and `CEZ_RELAY=0`
blocks it. A separate env opt-in would defeat zero-setup pairing.

### QR3: Does a phone need its own lock?

**Recommended: reopen Q12, and ship an optional biometric or device-passcode lock before a public listing,
off by default.** The parent spec deferred it when a phone needed a hosted password. Now a phone unlocked for
a moment can run tasks on a personal laptop, with no password anywhere. Keys already need the phone to be
unlocked. The list's Remove covers loss but not a borrowed phone.

### QR4: May Manual servers use the relay for push?

**Recommended: yes.** They hold the same grant and send `POST /v1/push` with no socket, at almost no cost.
Otherwise Manual users have no native push at all, and the parent spec requires it to be available.

### QR5: Accept the loopback proxy, pending R0?

**Recommended: yes.** Rejecting it reopens bundling, and bundling still needs a transport.

### QR6: Are these quotas right for a free service?

**Recommended: keep 2 GiB and 8 hours a day, with no paid tier.** They cost at most about $3.10 per room per month.
The `hello` frame lets them change without a release.

### QR7: Who owns export compliance?

**Recommended: Open Mercato answers it as standard encryption, and someone qualified confirms that before
R6.** It is a legal filing. Everything said about it here is [M].

### QR8: Should the Noise code be independently reviewed before a public listing?

**Recommended: yes, a focused review of the handshake, tunnel and proxy.** End-to-end encryption is the
promise of this feature, and the claim that anyone can check it is only as good as someone having done so.

### QR9: Should the QR code be something a browser does not open?

**Recommended: yes, a non-https scheme such as `cezar-pair:1.<origin>.<secret>.<key>`, before any relay the user does not run.**
A system camera that opens `https://<relay>/p#secret` hands the secret to a page the relay serves, and a
hostile relay's script can pair as a phone and show the same six digits (R1 review F1). The user's
attention at Approve is then the only defence. The trade-off: a system camera no longer reaches `GET /p`,
so someone with no app gets no "how to get the app" page, and the code works only inside the app's
scanner. Until decided, the string stays as in [§9.1](../../RELAY_PROTOCOL.md#91-qr-string), which is
acceptable only for a relay the user runs. It changes QR bytes, so decide before the public relay.

## Changelog

- 2026-11-01: Relay contract, protocol version 1. Relay repository is `patzick/rome`.
- 2026-11-01: Added the design around the contract. The contract text did not change.
- 2026-11-01: Contract additions from review, protocol version still 1: one socket per `deviceId`, `GET /p`,
  named `error` codes, `Date` on `bad-proof`, 4403 keeps the keys, and room expiry counts `POST /v1/push`.
- 2026-11-01: Review corrections outside the contract: authorization reads the closure misses, scope ending
  with the request, proxy listener and port rules, the worst-case cost, and refusals for browse and webhook
  writes. The contract did not change.
- 2026-11-01: R1. The wire contract moved to `RELAY_PROTOCOL.md`, with vectors in `test-vectors/relay/`.
  Protocol version stays 1. Everything in `patzick/rome#1` is adopted or rejected above. Rooms have no alarm,
  a daily cron deletes expired rooms, and a rendezvous keeps one alarm of at most 300 s. A typed code needs a
  relay address while QR1 is open. Added `HELLO` and `HEAD`, the pairing messages, the `LEASE` echo and one
  rendezvous per credential. Applied the parent spec amendments.
- 2026-11-01: R1 review. `device-add` is idempotent for a listed device, a failed pairing also sends
  `device-remove`, a `failure` in place of `pending` uses nonce 0, and a phone with no shared tunnel version
  closes and waits. Protocol version stays 1.
- 2026-11-01: R1 review fixes. `qr.json` moved `10.0.2.2` from accepted to refused. Corrected the claim that nothing depends on
  the relay for authorization and the "photographed" row for a system-camera scan, and opened QR9. Added
  frame pacing, stale-frame handling, `RESET` after `END`, `device-removed` reconnects, the 60-a-minute command
  limit, `bytesPerDay` closing cezar, the rendezvous kill-switch exception, absent `hello` keys, public keys
  seen by a rendezvous relay, typed-code rendezvous on request, no `10.0.2.2`, `x-cezar-runtime-handoff`
  and "MUST NOT use" `permessage-deflate`.
- 2026-11-01: R3. The start route returns no code: `POST /workspace/phones/pairing/:id/code` opens that rendezvous on request. `outsideRelayScope` sits at run start, `ManagerEngine.enqueue` and its timers, `refreshHealth`, topic start, automation reschedule, webhook service resolution and lazy context builds. Audit: the only values a scope changes are `localHandoff`, `terminal`, `designMode`, `managerSystemNotifications`, `phonePairing`, the accounts closure and `isHostedMode`, so a site matters only if deferred work can reach one of those. A phone's rendezvous-side rollback also removes the row when the phone left before hearing `approved`.
