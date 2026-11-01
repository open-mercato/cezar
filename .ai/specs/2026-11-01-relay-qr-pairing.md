# Phone connection through a relay, with QR pairing

Refs `.ai/specs/2026-10-31-mobile-apps-manager-first.md` (the parent spec), PR #1879, PR #1883.

Stacked on PR #1879. Nothing in this PR is built.

Status: draft. The [relay contract](#relay-contract) is stable enough to build against. Any change to
it is a separate commit and a line in the [changelog](#changelog).

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
| `NavigationPolicy`, `RequestGate` | Take the common origin type. The SSO `https` redirect branch applies to Manual only |
| `HealthProbe`, `HttpGet` | Gain a tunnel transport. `HealthClassifier` reads the same JSON |
| `StartDecision` | The table stays. New routes: `CEZAR_OFFLINE`, `RELAY_DOWN`, `DEVICE_REMOVED`, `PROTOCOL_MISMATCH`. Basic routes cannot occur on a relay server |
| `ServerActivity`, `ServerViewController` | Load the proxy origin for a relay server, and show the native [connection banner](#how-a-failure-appears-in-the-app) over the page |
| `BasicChallengeResponder` | Not used for relay servers, which get no challenge |
| Connect page | First screen becomes Scan QR code and Enter code. The URL form moves under Advanced, word for word |
| `network_security_config.xml`, `Info.plist` | One cleartext exception for `127.0.0.1`, and `NSCameraUsageDescription` plus Android's `CAMERA`. Remote cleartext stays refused |
| New native code | Noise, tunnel, proxy and scanner, as framework-free classes. Android's `minSdkVersion` 24 predates platform X25519 [M], so it needs one crypto library. iOS 15 has CryptoKit [M] |
| `README.md`, BACKWARD_COMPATIBILITY.md §6b | §6b keeps every clause and gains the tunnel protocol version. Its rule that any shell must work with any cezar holds through negotiation, see [Version mismatch](#version-mismatch) |

The password rules, one-answer rule and Android restart logic stay on the Manual path only, because a
relay server has no password.

### Version mismatch

| Layer | Handling |
| --- | --- |
| Cockpit | Cannot drift. It comes from cezar |
| Tunnel protocol | Each side sends `{ min, max }` in the handshake and they use the highest shared version |
| No shared version, app too old | "Update the app", with a store link |
| No shared version, cezar too old | "Update cezar on your computer" |
| Relay contract | `/v1` in the path, and 4426 if retired. cezar and the app each read `hello` limits rather than build them in |
| New cockpit features | Capabilities, as the parent spec requires |
| A cezar older than this feature | Has no Connect a phone screen, so it cannot be paired. Manual still works |

## Relay contract

Protocol version 1. The relay is built in the private repository `patzick/rome`. This section is the
whole interface between that relay and the public clients. It describes behaviour only.

The relay is assumed hostile. It is trusted for availability and nothing else, so nothing here may
depend on it for confidentiality or authorization of cezar's API.

### Connection roles

All endpoints live on one host and carry the version in the path. Sockets are `wss://`.

| Endpoint | Role | Proves | Lifetime |
| --- | --- | --- | --- |
| `GET /v1/cezar/<cezarId>` (upgrade) | One cezar | Holds the key behind `cezarId` | Long-lived, hibernated. One per room. A new authenticated socket closes the old one with 4409 |
| `GET /v1/phone/<cezarId>/<deviceId>` (upgrade) | One paired phone | Holds the key behind `deviceId`, and `deviceId` is on the room's allowlist | Only while the app is in the foreground. One per `deviceId`. A new authenticated socket closes the old one with 4409 |
| `GET /v1/pair/<locator>?role=cezar` (upgrade) | cezar during pairing | Holds the key behind the `X-Cezar-Relay-Key` it sends | Created here. See [Rendezvous](#rendezvous) |
| `GET /v1/pair/<locator>?role=phone` (upgrade) | Unpaired phone | Knows the locator | One phone. A second gets 4410 |
| `POST /v1/push-grants` | Phone | Holds a device key | Request |
| `POST /v1/push-grants/revoke` | Phone | Holds the device key sealed in the grant | Request |
| `POST /v1/push` | cezar or a hosted server | Holds the key sealed in the grant | Request |
| `GET /p` | Anyone | Nothing | Request. A static page saying how to get the app, with no script. Clients never call it |

When a phone socket replaces another for the same `deviceId`, the relay sends cezar `phone-left` and then
`phone-joined`, both before the first data frame from the new socket. cezar ends a device's session on
`phone-left`, so the data after every `phone-joined` starts with a new handshake.

A **room** is the per-cezar state on the relay, one Durable Object per `cezarId`. The room holds the
device allowlist, the grant denylist and rate counters. It never holds a payload, a device token or
queued work.

### Routing identifiers

Everything is base64url with no padding. Hashes and keys below are raw bytes before encoding.

| Name | Value | Visible to relay |
| --- | --- | --- |
| `cezarId` | `SHA-256("cezar-relay-id-v1\n" ‖ ed25519Pub)[0..16]`, 22 characters | Yes |
| `deviceId` | The same formula over the phone's Ed25519 public key | Yes |
| `locator` | 32 bytes derived from the pairing secret, 43 characters. It reveals nothing without that secret | Yes, for one rendezvous |
| `grant` | Opaque, sealed by the relay. Clients never parse it | Yes |
| `grantId` | 16 random bytes chosen by the relay, returned with the grant | Yes |

Both ids are self-certifying, so a cezar needs no account and the relay needs no registry to accept
one. The Ed25519 keys here are for the relay only. The end-to-end keys are separate, and the relay
never sees them in the clear or as an identifier.

### Upgrade and request proof

Every endpoint except `role=phone` rendezvous and `GET /p` carries three headers:

| Header | Value |
| --- | --- |
| `X-Cezar-Relay-Key` | Ed25519 public key |
| `X-Cezar-Relay-Time` | Unix seconds, within ±120 s of the relay's clock |
| `X-Cezar-Relay-Sig` | Ed25519 signature over the proof string |

The proof string for a socket is UTF-8, joined with `\n`, with no trailing newline:

```text
cezar-relay-v1
<role: cezar | phone | pair>
<cezarId, or the locator for role pair>
<deviceId, or - for cezar and pair>
<X-Cezar-Relay-Time>
```

The relay recomputes the id from the key, compares it with the path, then verifies the signature. A
`POST` replaces the first line with `cezar-relay-post-v1`, the role with the request path, and the
id lines with the hex SHA-256 of the raw body and `-`.

Test vector. The Ed25519 seed is 32 bytes of `0x01`, role `cezar`, time `1793491200`:

```text
key    iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w
id     JG0cluinRjn-lvNKCdLU5w
sig    V68ncyA98yXD5r524pXn17WZs8PNJKCytyw41XCAcEceSEkQJyYg99SHobPMZKg_qtS2VVmoblfOyvCV9eY4Dg
```

A rejected upgrade may answer before the socket exists, with the HTTP status from
[Close codes](#close-codes) and `{ "code": "<name>" }`. Both forms mean the same to a client. A
`bad-proof` rejection is always this HTTP form and carries a `Date` header, so a client with a wrong
clock can correct it.

### Frames

**Binary frames are data and text frames are control.** The relay never parses a data payload beyond
its header.

```text
phone  → relay   0x01 ‖ ciphertext
relay  → cezar   0x01 ‖ deviceId (16 raw bytes) ‖ ciphertext
cezar  → relay   0x01 ‖ deviceId (16 raw bytes) ‖ ciphertext
relay  → phone   0x01 ‖ ciphertext
```

Rendezvous data has no `deviceId`: `0x01 ‖ ciphertext` in both directions. An unknown first byte
closes the socket with 4400, so a later version can add frame types.

**Keepalive.** The text frame `ping` is answered with `pong` by the runtime, without waking the room.
A client sends at most one per 20 s. This is the only traffic an idle cezar sends. A client must
never use any other frame as a keepalive, because any other frame wakes the room.

**Control frames** are JSON objects with a `t` key. Unknown `t` values are ignored by clients and
answered by the relay with `error` code `unknown-frame`, so a command the relay lacks fails visibly.

| Direction | Frame | Meaning |
| --- | --- | --- |
| relay → any | `{"t":"hello","protocol":1,"limits":{…}}` | First frame on a socket. `limits` has the [limit names](#limits) with live values, which override the table |
| relay → cezar | `hello` also carries `"phones":["<deviceId>"]` | Phones connected now, for a cezar that reconnected |
| relay → phone | `hello` also carries `"cezar":"online"\|"offline"` | Whether a cezar socket is present |
| relay → cezar | `{"t":"phone-joined","device":"<deviceId>"}` | A phone socket opened |
| relay → cezar | `{"t":"phone-left","device":"<deviceId>"}` | A phone socket closed |
| relay → phone | `{"t":"cezar-online"}`, `{"t":"cezar-offline"}` | The cezar socket opened or closed |
| cezar → relay | `{"t":"device-add","id":"<cmd>","device":"<deviceId>","key":"<ed25519Pub>"}` | Add to the allowlist. The relay recomputes `device` from `key` |
| cezar → relay | `{"t":"device-remove","id":"<cmd>","device":"<deviceId>","grants":["<grantId>"]}` | Remove, close that phone's socket with 4403, deny the listed grants |
| cezar → relay | `{"t":"device-sync","id":"<cmd>","devices":[{"device":"…","key":"…"}]}` | Replace the allowlist. Sent once after each connect, so a lost command converges |
| relay → cezar | `{"t":"ack","id":"<cmd>"}` | The command is durable |
| relay → sender | `{"t":"error","id":"<cmd>","code":"<name>"}` | The command failed. `id` is absent for a frame without one |
| relay → any | `{"t":"closing","retryAfter":<seconds>}` | Sent before a 4429, 4430 or 4503 close |

`cezarId` is implied by the socket, so no control frame repeats it.

| `error` code | Meaning |
| --- | --- |
| `unknown-frame` | The relay does not know this `t` |
| `bad-command` | A required field is missing or malformed |
| `device-limit` | The allowlist is at `devices` |
| `device-key-mismatch` | `device` is not the id of `key` |

### Rendezvous

A rendezvous joins two parties that have no allowlist entry yet. It is the same flow for a QR code
and a typed code, because only the locator differs.

| Rule | Value |
| --- | --- |
| Creation | The first `role=cezar` upgrade creates it. A `role=phone` upgrade before that closes with 4404 |
| Claim window | The phone must join within 120 s of creation, or the socket closes with 4408 |
| Hard lifetime | 300 s from creation, closing both sockets with 4408. The human approval happens inside this |
| Parties | One cezar and one phone. A second phone closes with 4410, and the cezar gets `{"t":"pair-contested"}` |
| Control | `{"t":"peer-joined"}`, `{"t":"peer-left"}` |
| Volume | At most 32 data frames of 16 KiB each |
| Storage | None. When both sockets are gone, nothing remains |

The relay does not know whether a pairing succeeded. Success is a `device-add` on the room.

### Relay behaviour

These rules exist because awake time is what drives cost.

1. **Sleep.** With no phone socket in a room, the room hibernates. A hibernated cezar socket must not
   cost duration. No timer, outbound request or non-hibernating socket may hold the room awake.
   Alarms are allowed only to expire storage, at most once a day.
2. **No buffering.** A data frame with no live target is dropped, with `phone-left` to a cezar or
   `cezar-offline` to a phone. The relay queues nothing, and a client recovers by asking again.
3. **No persistence.** Payloads are never written to storage, logs or analytics. Connection metadata
   is logged only in aggregate.
4. **Order.** Frames between two sockets stay in order, with no duplicates. Clients still treat
   reordering or loss as fatal to their session.
5. **Metric.** The relay reports room awake seconds and phone-connected seconds per day, so their
   ratio can be watched. The alert and test live in `patzick/rome`. The client half of this guard is
   in this repository: cezar sends no data frame without a live end-to-end session.
6. **Storage expiry.** A room's storage is deleted 90 days after its last authenticated cezar socket or
   signed `POST /v1/push`, and never while a denylist entry is still live. A Manual server never opens
   a socket, and losing its denylist would revive a revoked grant.

### Push signal

A grant ties one phone's push token to one cezar key, without either party's store holding the token.
Grants are sealed with an AEAD key held only in Cloudflare secrets, alongside the APNs and FCM keys.

**Get a grant.** `POST /v1/push-grants`, by the phone:

```json
{ "platform": "ios", "token": "<apns or fcm token>", "cezarKey": "<ed25519Pub>" }
```

`200 { "grant": "…", "grantId": "…", "expiresAt": 1801267200 }`. A grant lasts 90 days. The phone
renews on app open once under 30 days remain. The sealed grant holds the token, platform, `cezarKey`,
the phone's device key and the expiry. The phone gives it to cezar inside the encrypted session.

**Send.** `POST /v1/push`, by cezar, signed with the key sealed in the grant:

```json
{ "v": 1, "grant": "…", "kind": "attention", "count": 3, "id": "<16 random bytes>", "ts": 1793491200 }
```

| Field | Rule |
| --- | --- |
| `kind` | `attention` is the only value in v1. Any other is 400 |
| `count` | Integer 0 to 99, the badge |
| `id` | Refused if seen in the last 10 minutes, as replay protection |
| `ts` | Within ±120 s |
| Anything else | 400. There is no free-text field, so user text has nowhere to go |

The relay sends a fixed notification and never forwards anything from the request except `count`:

| Field | Value |
| --- | --- |
| Visible text | Title `Cezar`, body `Cezar needs you` |
| Badge | `count` |
| Custom data | `{ "s": "<cezarId>" }`, so the tap opens that server |
| Collapse key | `cezarId`, so a phone holds one notification per server |
| Expiry at APNs or FCM | 1 hour |

| Answer | Meaning | cezar does |
| --- | --- | --- |
| 202 `{ "ok": true }` | Handed to APNs or FCM | Nothing |
| 400 | Malformed | Logs it. A bug, never retried |
| 401 | Bad signature, wrong key, or `ts` out of range | Logs it |
| 403 `{ "code": "grant-denied" }` | On the denylist | Deletes the grant |
| 409 `{ "code": "replay" }` | `id` already seen | Nothing |
| 410 `{ "code": "grant-gone" }` | Expired, or APNs or FCM reports the token dead | Deletes the grant |
| 429 with `Retry-After` | Over a push limit | Drops this signal |
| 503 | APNs, FCM or the relay failed | Drops this signal |

Delivery is best effort. The relay never retries and cezar does not retry a dropped signal. The card
stays in the chat.

**Revoke.** `POST /v1/push-grants/revoke`, by the phone, `{ "grant": "…" }`, answers 204. The same
grant can also be denied by `device-remove`. Denylist entries expire with the grant.

### Limits

Starting values. The `hello` frame carries the live ones, so the relay can change them without a
client release. A client must obey the `hello` values.

| Name | Scope | Value |
| --- | --- | --- |
| `frameBytes` | One binary frame, header included | 65,552 |
| `controlBytes` | One text frame | 8,192 |
| `devices` | Allowlist per room | 10 |
| `phoneSockets` | Concurrent phone sockets per room | 3 |
| `framesPerSecond` | Data frames per room, both directions | 500 |
| `bytesPerDay` | Data bytes per room, per UTC day | 2 GiB |
| `phoneSecondsPerDay` | Summed phone-connected time per room, per UTC day | 28,800 |
| `connectsPerMinute` | Upgrades per `deviceId` or `cezarId` | 30 |
| `ipUpgradesPerMinute` | Upgrades per source IP | 60 |
| `newRoomsPerHour` | First-seen `cezarId` per source IP | 10 |
| `rendezvousPerHour` | Rendezvous per `cezarId` | 10 |
| `pushesPerMinute` | `POST /v1/push` per grant | 6 |
| `pushesPerDay` | `POST /v1/push` per room | 200 |

Rejected upgrades should be refused in the Worker where possible, so that junk never wakes a room.

### Close codes

| Code | HTTP | Name | Client does |
| --- | --- | --- | --- |
| 1000 | | `normal` | Nothing |
| 1001 | | `going-away` | Reconnect with jitter. A relay deploy causes this |
| 4400 | 400 | `bad-frame` | Stop. A bug, reported in the UI |
| 4401 | 401 | `bad-proof` | Retry once, correcting the time by the response's `Date`, then stop and report |
| 4403 | 403 | `device-removed` | Phone: stop reconnecting and show that this phone was removed. Keep the keys and offer a manual retry, because the relay is untrusted and a lost room looks the same |
| 4404 | 404 | `no-rendezvous` | Phone: "code not found or expired" |
| 4408 | | `pair-expired` | Show a new code |
| 4409 | | `replaced` | cezar: do not reconnect. Another process owns this identity. Phone: this socket was replaced by a newer one, so do nothing |
| 4410 | 409 | `pair-taken` | Phone: show a warning. Pairing has failed safe |
| 4413 | | `frame-too-large` | Stop. A bug, reported in the UI |
| 4426 | 426 | `protocol-unsupported` | Show "update the app" or "update cezar" |
| 4429 | 429 | `rate-limited` | Reconnect after `retryAfter` |
| 4430 | | `quota-exhausted` | Reconnect after `retryAfter`, and say so in the UI |
| 4503 | 503 | `relay-disabled` | Back off 5 to 15 minutes. The operator's kill switch |

Reconnect uses full jitter, from 1 s up to 5 minutes, so a deploy does not bring every cezar back at
once. Any other close or network loss is treated like 1001.

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
   opens a [rendezvous](#rendezvous). The QR code lasts 2 minutes, and it does not rotate by itself. When
   it expires the screen offers **Show a new code**, so a forgotten tab shows nothing usable.
2. The QR holds `https://<relay host>/p#1.<secret>.<cezar X25519 key>`. A browser does not send the
   fragment, and a system camera that opens the link reaches a page explaining how to get the app. That
   page has no script, but a hostile relay could serve one that reads the fragment, so a system-camera
   scan counts as a [photo](#what-if-the-qr-code-is-photographed).
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

**Typed code.** The Connect a phone screen also shows a code such as `QRFX-7KMD-2NVB`: 12 Crockford
base32 characters, 60 bits, same 2-minute life. The app runs PBKDF2-HMAC-SHA256 with 200,000 iterations
over it, and splits the output into locator and pre-shared key. A QR secret uses HKDF instead, because
it is already 256 bits. Steps 3 to 7 are identical, except that no key can be pinned in step 4, so the
6-digit match matters more. The code uses the default relay host, so a custom `CEZ_RELAY_URL` needs the
QR code. PBKDF2 was chosen because Node, CommonCrypto and the JDK all have it [M for the last two].

`psk3` means a passive observer of the handshake learns nothing it can test a guess against. The
locator can be tested, which is why the 60 bits sit behind a slow hash and a 2-minute life.

### What if the QR code is photographed

The QR is a one-use, 2-minute secret that opens a request, not a door. **Approval on desktop is what
grants access.**

| Scenario | Result |
| --- | --- |
| Photo used after 2 minutes | 4404. Nothing happens |
| Photo used after the real phone paired | 4404. The rendezvous is gone |
| Attacker scans first, then the user's phone tries | The phone gets 4410 and a warning, and `pair-contested` makes desktop cancel the pairing and warn, so it fails safe |
| Attacker joins while the user's phone is pairing | 4410 for the attacker and `pair-contested` on desktop, with the same result |
| Attacker scans first, the user's phone has not tried, and the user approves without looking | **Access is granted.** The 6-digit number and the phone's name are the only defence. The device then sits in the list, where Remove ends it |
| Photo plus a hostile relay, QR flow | Cannot impersonate cezar: the phone pins the key, and the attacker lacks its private half |
| Typed code read in time, plus a hostile relay | **Residual risk.** No pinned key, and an attacker on both legs could grind ephemeral keys until the 6 digits match. It needs the code within 2 minutes and control of the relay. Accepted for a fallback, and the UI says to prefer the QR code |
| Screen recording or screen share | Same as a photo |
| System camera opens the link, hostile relay reads the fragment | Same as a photo plus a hostile relay: the phone-side pin holds, and Approve still decides |

A code is shown only after a click, and never appears in a notification, log or `.ai/cezar/`. At most one
pairing is pending, and cezar allows 5 per hour, below the relay's `rendezvousPerHour`.

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

### Inside the tunnel

The encrypted payload is a small stream protocol, published in `RELAY_PROTOCOL.md` with test vectors:
`OPEN` (id, method, path, headers), `DATA`, `END`, `RESET`, `WINDOW`, `LEASE`, `REKEY`, `CLOSE`.

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
| Health | `GET /health` answers from the process-wide `healthCache` (`:2037`), and `healthSnapshot` computes `capabilities` and `repoRoot` once (`:1976`, `:1992`). A phone would read the desktop's local view and full path, and a phone's refresh would publish the narrowed view to the desktop | The cache keeps only fields that do not depend on scope. The route and the topic snapshot add `capabilities` and `repoRoot` when they read, and `refreshHealth` runs outside any relay scope |

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
`AsyncLocalStorage.exit`: starting a run, `ManagerEngine.enqueue`, `refreshHealth`, and topic publishers.
Work that outlives a request therefore reads the unscoped value, as it would had the desktop started it.

### What a phone can do

| A phone's requests can | A phone's requests cannot |
| --- | --- |
| Everything a hosted cockpit can: Manager, approvals, start and answer tasks, read diffs | Open a shell, edit agent config or agent accounts, use open-in routes, browse outside the browse root |
| | Pair, approve or remove a phone. Those routes answer 403 in a relay scope |

**These limits bind a phone's requests, not what a task does.** Starting a task is running code as the
user, as the guard's own comment says, and a default task has unrestricted `Bash`. So a stolen unlocked
phone can ask a task to open a shell, edit agent config, write `~/.cezar/relay/devices.json` or call the
pairing routes over loopback. The narrowing stops a compromised page or a bug from reaching local powers
directly. It does not contain a phone in the wrong hands. Only Remove does that, and a lock would. See
[QR3](#qr3-does-a-phone-need-its-own-lock).

**Full local paths are not hidden.** Hosted mode trims `repoRoot` and self-update paths, but `worktreePath`
and a project's `root` are always sent, because a hosted reader was never on that machine. A phone will see
them. That is accepted for v1, since those paths belong to the phone's owner, and no privacy claim may say
otherwise.

### Device store and routes

Devices live in `~/.cezar/relay/devices.json`, an own file like `agent-accounts.json`, never a key in
`config.json`: `deviceId`, `label`, `platform`, both public keys, `addedAt`, `lastSeenAt`, and any sealed
grant. Deleting the directory loses pairings, and the user pairs again. That is state, not configuration.

Only `cezar serve` runs the client, never `cez run`. Identity is per home, so a second process on the
same home gets 4409 and stops, and Settings says which situation it is in.

New routes, contract first, in one chained workspace-level family and listed in BACKWARD_COMPATIBILITY.md §2:

| Route | Purpose |
| --- | --- |
| `GET /workspace/phones` | List, with relay status |
| `POST /workspace/phones/pairing` | Start. Returns the QR string, code and expiry |
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
│ ▓▓ QR ▓▓    Or type: QRFX-7KMD-2NVB      │
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
§ Zero config. Nothing leaves the machine until the user clicks **Connect a phone**. The socket exists
from the first Approve, while at least one device is paired, and it closes when the last is removed. `CEZ_RELAY=0` blocks
all of it. `CEZ_RELAY_URL` overrides the host for development. Both go in `.env.example` and
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
| Quiet test | Public, `packages/cezar/src/relay/` | With a fake socket and a running Manager and tasks, any frame but `ping` is sent while no session exists |
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

The numbers are in [Limits](#limits). This is what each one is for.

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
4. The demo reopens its rendezvous each time it expires, 12 times an hour, so `patzick/rome` raises
   `rendezvousPerHour` for that one `cezarId` through its `hello` limits, and cezar skips its own limit of 5
   an hour under the demo code. The contract does not change.
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
| Hand-written Noise has a bug | Medium | Loss of confidentiality | Published vectors, Noise test vectors, external review before public listing |
| Relay becomes a free tunnel | Low | Cost | Daily quotas, kill switch |
| One private key across all relay users | Low | Generic push spam, not content | Cloudflare secrets, rotation in `patzick/rome` |
| Single relay is a single dependency | Medium | Phones lose access | Advanced path, honest banners |
| Laptop sleeps, so Manager stops | High | User is surprised | The banner says so. Hosted cezar remains the answer for always-on |
| Private relay reduces trust | Low | Harder to believe the claim | The claim rests on public clients only |

## Backward compatibility

- Additive: new routes, a `phonePairing` capability, a `phone-pairing` event, new `~/.cezar/relay/` files.
- BACKWARD_COMPATIBILITY.md gains a section for the relay contract and tunnel protocol, with versioning
  rules, and §2 and §9 entries. A breaking relay change needs a new path version and old clients served
  until a release of each has been in the wild.
- §6b from #1883 gains the tunnel protocol. Every existing clause stands.
- A server with this feature behaves identically when no phone is paired, with no socket and no call out.
- Manual users see only the connect screen's new order.
- New env vars `CEZ_RELAY`, `CEZ_RELAY_URL` and `CEZ_RELAY_DEMO_CODE` go in `.env.example` and
  `docs/reference.md`. A new feature page goes under `docs/site`.

## Changes to the parent spec

R1 makes these edits in `.ai/specs/2026-10-31-mobile-apps-manager-first.md`. They are left out of this PR
so that it stays one spec.

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

- **Crypto:** Noise's published vectors in all three languages, plus shared cross-language vectors
  generated by the Node client and read by Swift and Kotlin tests. Tampering, reorder and replay each end
  a session. The first handshake message with a payload is refused.
- **Pairing:** expiry, single use, contested join, Deny, closed tab, no device row before approval, pinned
  key mismatch, typed code, and the limit of 5 pairings per hour.
- **Authorization:** each narrowed capability inside a relay scope. An agent-config `PUT`, open-in, terminal
  and phone routes refused. A forged `Host: 127.0.0.1` over the tunnel stays hosted. A concurrent loopback
  request stays local, and an event emitted from a relay request reaches a desktop SSE stream with desktop
  capabilities, proving that the scope does not leak. Agent-profile routes are refused, with and without
  `CEZ_REMOTE_AGENT_ACCOUNTS=1`. `/health` in a relay scope is narrowed when the cache holds the desktop's
  view, and a refresh from a relay scope changes nothing a desktop reads or receives on the `health` topic.
  A run, timer or Manager turn started from a relay request reads the unscoped value. The source-walking
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

## Changelog

- 2026-11-01: Relay contract, protocol version 1. Relay repository is `patzick/rome`.
- 2026-11-01: Added the design around the contract. The contract text did not change.
- 2026-11-01: Contract additions from review, protocol version still 1: one socket per `deviceId`, `GET /p`,
  named `error` codes, `Date` on `bad-proof`, 4403 keeps the keys, and room expiry counts `POST /v1/push`.
- 2026-11-01: Review corrections outside the contract: authorization reads the closure misses, scope ending
  with the request, proxy listener and port rules, and the worst-case cost.
