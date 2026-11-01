# Phone connection through a relay, with QR pairing

Refs `.ai/specs/2026-10-31-mobile-apps-manager-first.md` (the parent spec), PR #1879, PR #1883.

Status: draft. The rest of the design follows in later commits. The [relay contract](#relay-contract)
below is stable enough to build against. Any change to it is a separate commit and a line in the
[changelog](#changelog).

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
| `GET /v1/phone/<cezarId>/<deviceId>` (upgrade) | One paired phone | Holds the key behind `deviceId`, and `deviceId` is on the room's allowlist | Only while the app is in the foreground |
| `GET /v1/pair/<locator>?role=cezar` (upgrade) | cezar during pairing | Holds the key behind the `X-Cezar-Relay-Key` it sends | Created here. See [Rendezvous](#rendezvous) |
| `GET /v1/pair/<locator>?role=phone` (upgrade) | Unpaired phone | Knows the locator | One phone. A second gets 4410 |
| `POST /v1/push-grants` | Phone | Holds a device key | Request |
| `POST /v1/push-grants/revoke` | Phone | Holds the device key sealed in the grant | Request |
| `POST /v1/push` | cezar or a hosted server | Holds the key sealed in the grant | Request |

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

Every endpoint except `role=phone` rendezvous carries three headers:

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
[Close codes](#close-codes) and `{ "code": "<name>" }`. Both forms mean the same to a client.

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
6. **Storage expiry.** A room's storage is deleted 90 days after its last authenticated cezar socket.

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
| 4401 | 401 | `bad-proof` | Retry once after re-reading the clock, then stop and report |
| 4403 | 403 | `device-removed` | Phone: stop for good and show that this phone was removed |
| 4404 | 404 | `no-rendezvous` | Phone: "code not found or expired" |
| 4408 | | `pair-expired` | Show a new code |
| 4409 | | `replaced` | Do not reconnect. Another cezar process owns this identity |
| 4410 | 409 | `pair-taken` | Phone: show a warning. Pairing has failed safe |
| 4413 | | `frame-too-large` | Stop. A bug, reported in the UI |
| 4426 | 426 | `protocol-unsupported` | Show "update the app" or "update cezar" |
| 4429 | 429 | `rate-limited` | Reconnect after `retryAfter` |
| 4430 | | `quota-exhausted` | Reconnect after `retryAfter`, and say so in the UI |
| 4503 | 503 | `relay-disabled` | Back off 5 to 15 minutes. The operator's kill switch |

Reconnect uses full jitter, from 1 s up to 5 minutes, so a deploy does not bring every cezar back at
once. Any other close or network loss is treated like 1001.

## Changelog

- 2026-11-01: Relay contract, protocol version 1. Relay repository is `patzick/rome`.
