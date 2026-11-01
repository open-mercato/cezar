# RELAY_PROTOCOL.md — the cezar phone relay protocol

The complete wire contract between a cezar, a phone and the relay that joins them. A client can be
built from this file and `test-vectors/relay/` alone. It wins over every other document, including
the design spec `.ai/specs/2026-11-01-relay-qr-pairing.md`, which explains why it looks like this.

Relay contract version 1. Tunnel protocol version 1. The words MUST, MUST NOT and MAY are normative.

## 1. Model

```text
webview ─ loopback proxy ─ Noise ═══ relay ═══ Noise ─ dispatcher ─ cezar's app.fetch
        (on the phone)        ciphertext only        (on the computer)
```

The relay is assumed hostile. It is trusted for availability and nothing else: it can drop, delay and
inject, and every injected byte fails decryption. Nothing here depends on it for confidentiality or
for authorization of cezar's API. The relay implementation is private; this document describes its
behaviour only.

Terms: a **room** is the relay's per-cezar state, one per `cezarId`. A **rendezvous** is a short-lived
pipe between two parties with no allowlist entry yet. A **session** is one Noise `KK` run on one phone
socket. A **record** is one padded Noise transport plaintext. A **stream** is one HTTP exchange inside
a session.

## 2. Encoding

- All integers are unsigned big-endian, except Noise's own nonce.
- `base64url` means RFC 4648 §5 with no padding. Decoders MUST refuse padding, the `+` and `/`
  alphabet, and non-canonical trailing bits. A 32-byte value is 43 characters, a 16-byte value is 22.
- Control frames and JSON payloads are UTF-8. Readers ignore unknown keys.
- Hashes and keys are raw bytes before encoding.

| Name | Value | Relay sees it |
| --- | --- | --- |
| `cezarId` | `base64url(SHA-256("cezar-relay-id-v1\n" ‖ ed25519Pub)[0..16])` | Yes |
| `deviceId` | The same formula over the phone's Ed25519 public key | Yes |
| `locator` | `base64url` of 32 derived bytes, [§9](#9-pairing) | Yes, for one rendezvous |
| `grant` | Opaque, sealed by the relay. Clients never parse it | Yes |
| `grantId` | `base64url` of 16 random bytes chosen by the relay | Yes |
| Command `id` | Any string of 1 to 64 characters chosen by cezar | Yes |

Ids are self-certifying, so no account or registry exists. Ed25519 keys are for the relay only. X25519
keys are end-to-end, and the relay never receives one in the clear or as an identifier. A phone
SHOULD generate a fresh pair of each for each server it pairs with, so that two cezars cannot
correlate it.

## 3. Relay endpoints

A relay address is an **origin**: `https://host[:port]`, or `http://` under the rule in
[§9.1](#91-qr-string). It has no path. Sockets use the same host and port, with `https` becoming
`wss` and `http` becoming `ws`. `CEZ_RELAY_URL` holds exactly this form. One trailing `/` is accepted
there and removed.

| Endpoint | Role | Proves | Lifetime |
| --- | --- | --- | --- |
| `GET /v1/cezar/<cezarId>` (upgrade) | One cezar | Holds the key behind `cezarId` | Long-lived, hibernated. A new authenticated socket closes the old one with 4409 |
| `GET /v1/phone/<cezarId>/<deviceId>` (upgrade) | One paired phone | Holds the key behind `deviceId`, on the room's allowlist | Foreground only. A new authenticated socket for the same `deviceId` closes the old one with 4409 |
| `GET /v1/pair/<locator>?role=cezar` (upgrade) | cezar pairing | Holds the key it sends | Creates the rendezvous |
| `GET /v1/pair/<locator>?role=phone` (upgrade) | Unpaired phone | Knows the locator. No headers | One phone |
| `POST /v1/push-grants` | Phone | A device key | Request |
| `POST /v1/push-grants/revoke` | Phone | The device key sealed in the grant | Request |
| `POST /v1/push` | cezar or a hosted server | The key sealed in the grant | Request |
| `GET /p` | Anyone | Nothing | A static page with no script saying how to get the app. Clients never call it |

One WebSocket message is one frame. There is no subprotocol, and clients MUST NOT offer
`permessage-deflate`. A client sends nothing until it has read `hello`.

### 3.1 Proofs

Every endpoint except `role=phone` and `GET /p` carries:

| Header | Value |
| --- | --- |
| `X-Cezar-Relay-Key` | `base64url` Ed25519 public key |
| `X-Cezar-Relay-Time` | Unix seconds, decimal, within ±120 s of the relay's clock |
| `X-Cezar-Relay-Sig` | `base64url` Ed25519 signature over the proof string |

The proof string is UTF-8 lines joined with `\n` and no trailing newline.

```text
socket                                   POST
cezar-relay-v1                           cezar-relay-post-v1
<cezar | phone | pair>                   <path, such as /v1/push>
<cezarId, or the locator for pair>       <lowercase hex SHA-256 of the raw body>
<deviceId, or - for cezar and pair>      -
<X-Cezar-Relay-Time>                     <X-Cezar-Relay-Time>
```

The relay recomputes the id from the key, compares it with the path, then verifies the signature. For
`role=cezar` on a rendezvous, it charges the `cezarId` of the proving key. A per-IP limit runs before
signature verification, because it is cheaper. Vector: `proof.json`.

### 3.2 Refusals

Before a socket exists, every refusal is an HTTP status with `{ "code": "<name>" }` and a `Date`
header. A client reads `code` when it can. A WebSocket library that hides the body falls back to the
status, using the first name listed for it that applies to that endpoint.

| Status | `code` | Meaning | Client does |
| --- | --- | --- | --- |
| 400 | `bad-frame` | Reserved for parity with 4400 | Stop and report |
| 400 | `upgrade-required` | Socket route without `Upgrade: websocket` | A bug. Stop and report |
| 400 | `bad-request` | Malformed `POST` body | A bug. Stop and report |
| 401 | `bad-proof` | Missing, stale or wrong proof | Retry once, correcting the time by `Date`, then stop and report |
| 403 | `device-removed` | Not on the allowlist | As 4403 |
| 404 | `no-rendezvous` | No such rendezvous, or expired | "Code not found or expired" |
| 404 | `no-route` | Unknown route, or a bad id or locator shape | A bug. Stop and report |
| 405 | `method-not-allowed` | Wrong method | A bug. Stop and report |
| 409 | `pair-taken` | A second phone or a second cezar on a rendezvous | As 4410. cezar picks a new secret |
| 426 | `protocol-unsupported` | Path version other than `v1` | As 4426 |
| 429 | `rate-limited` | A limit, with `Retry-After` | Reconnect after it. On a rendezvous, do not reconnect: see [§5](#5-rendezvous) |
| 503 | `relay-disabled` | Kill switch, on any `/v1` route, with `Retry-After: 300` | As 4503 |

A `POST` also answers 503 with no body when the relay cannot do the work, with a `Retry-After` when it
has one.

A phone over `phoneSockets`, or a first-seen `cezarId` over `newRoomsPerHour`, gets 429. The latter
has `Retry-After: 3600`. Two refusals need a socket, because their codes have no HTTP form. A phone over
`phoneSecondsPerDay` gets `hello`, `closing` and a 4430 close. A phone that reaches a rendezvous after
its claim window gets a 4408 close at once, with no `hello`.

### 3.3 Close codes

| Code | HTTP | Name | Client does |
| --- | --- | --- | --- |
| 1000 | | `normal` | Nothing |
| 1001 | | `going-away` | Reconnect with jitter. A relay deploy causes this |
| 4400 | 400 | `bad-frame` | Stop. A bug, reported in the UI |
| 4401 | 401 | `bad-proof` | As the 401 refusal |
| 4403 | 403 | `device-removed` | Phone: stop reconnecting and show that this phone was removed. Keep the keys and offer a manual retry, because the relay is untrusted and a lost room looks the same |
| 4404 | 404 | `no-rendezvous` | Phone: "code not found or expired" |
| 4408 | | `pair-expired` | Show a new code |
| 4409 | | `replaced` | cezar: do not reconnect. Another process owns this identity. Phone: this socket was replaced, so do nothing |
| 4410 | 409 | `pair-taken` | Phone: show a warning. Pairing has failed safe |
| 4413 | | `frame-too-large` | Stop. A bug, reported in the UI |
| 4426 | 426 | `protocol-unsupported` | Show "update the app" or "update cezar" |
| 4429 | 429 | `rate-limited` | Reconnect after `retryAfter`, except on a rendezvous |
| 4430 | | `quota-exhausted` | Reconnect after `retryAfter`, and say so in the UI |
| 4503 | 503 | `relay-disabled` | Back off 5 to 15 minutes. The operator's kill switch |

Any other close or network loss is treated like 1001. Reconnection uses full jitter: attempt `n`
waits a uniform random time from 1 s to `min(300 s, 2^n s)`, and `n` resets after 60 s connected.

## 4. Frames

**Binary frames are data and text frames are control.** The relay never parses a data payload beyond
its header.

```text
phone  → relay   0x01 ‖ ciphertext
relay  → cezar   0x01 ‖ deviceId (16 raw bytes) ‖ ciphertext
cezar  → relay   0x01 ‖ deviceId (16 raw bytes) ‖ ciphertext
relay  → phone   0x01 ‖ ciphertext
rendezvous, both directions   0x01 ‖ ciphertext
```

An unknown first byte closes the socket with 4400, so a later version can add frame types. Vector:
`frames.json`.

**Keepalive.** The text frame `ping` is answered with `pong` by the relay's runtime, without waking the
room. Every client sends one every 45 s, and never more than one per 20 s. The relay cannot enforce
that rate, because the runtime answers before any code runs: it is a client rule. No `pong` in 15 s
counts as network loss. An idle cezar sends nothing else. No other frame may be used as a keepalive,
because any other frame wakes the room.

**Control frames** are JSON objects with a string `t`. Unknown `t` values are ignored by clients and
answered by the relay with `error` code `unknown-frame`, including a phone sending a cezar command.
Text that is not a JSON object with a string `t` closes with 4400.

| Direction | Frame | Meaning |
| --- | --- | --- |
| relay → any | `{"t":"hello","protocol":1,"limits":{…}}` | First frame on a socket. Keys of `limits` are the [limit names](#8-limits), and their live values override the table. An absent `limits` or key falls back to the table |
| relay → cezar | `hello` also carries `"phones":["<deviceId>"]` | Phones connected now |
| relay → phone | `hello` also carries `"cezar":"online"\|"offline"` | Whether a cezar socket is present |
| relay → cezar | `{"t":"phone-joined","device":"<deviceId>"}` | A phone socket opened |
| relay → cezar | `{"t":"phone-left","device":"<deviceId>"}` | A phone socket closed, or a frame had no live target |
| relay → phone | `{"t":"cezar-online"}`, `{"t":"cezar-offline"}` | The cezar socket opened or closed, or a frame had no live target |
| cezar → relay | `{"t":"device-add","id":"<cmd>","device":"<deviceId>","key":"<ed25519Pub>"}` | Add to the allowlist. The relay recomputes `device` from `key` |
| cezar → relay | `{"t":"device-remove","id":"<cmd>","device":"<deviceId>","grants":["<grantId>"]}` | Remove, close that phone's socket with 4403, deny the listed grants. `grants` may be absent |
| cezar → relay | `{"t":"device-sync","id":"<cmd>","devices":[{"device":"…","key":"…"}]}` | Replace the allowlist, and close with 4403 any connected phone that fell off it |
| relay → cezar | `{"t":"ack","id":"<cmd>"}` | The command is durable |
| relay → sender | `{"t":"error","id":"<cmd>","code":"<name>"}` | The command failed. `id` is absent if the frame had no valid one |
| relay → any | `{"t":"closing","retryAfter":<seconds>}` | Sent before a 4429, 4430 or 4503 close |

`cezarId` is implied by the socket, so no control frame repeats it.

| `error` code | Meaning | cezar does |
| --- | --- | --- |
| `unknown-frame` | The relay does not know this `t`, or this role may not send it | A bug. Report it |
| `bad-command` | A required field is missing or malformed | A bug. Report it |
| `device-limit` | The allowlist is at `devices` | Fail the pairing, naming a full list |
| `device-key-mismatch` | `device` is not the id of `key` | A bug. Report it |
| `too-many-grants` | The phone **was** removed, but its grants were not denied, because the room holds 1,000 live denials | Keep the `grantId`s and warn in Settings. Do not resend, since the phone is already gone |

**cezar's obligations.** After each connect, once `hello` has arrived, cezar sends one `device-sync`
with every saved device, so a lost command converges. cezar tracks the `grantId`s of each device,
because `device-remove` must list them. A list that does not fit `controlBytes` is split across
several `device-remove` commands for the same device, which is idempotent. An unacknowledged
`device-remove` is kept and sent again after the next connect.

**Replacement.** When a phone socket replaces another for one `deviceId`, cezar gets `phone-left` then
`phone-joined`, both before the first data frame from the new socket. When a cezar socket replaces
another, phones get `cezar-offline` then `cezar-online`. Either way, a new handshake follows.

## 5. Rendezvous

The same flow for a QR code and a typed code, because only the locator differs.

| Rule | Value |
| --- | --- |
| Creation | The first `role=cezar` upgrade creates it. First cezar wins: a second is 409 `pair-taken`, even with the same key. A `role=phone` upgrade before creation is 404 `no-rendezvous` |
| Claim window | The phone must join within 120 s of creation, or the socket closes with 4408 |
| Hard lifetime | 300 s from creation, closing both sockets with 4408. Human approval happens inside this |
| Parties | One cezar and one phone. A second phone is 409 `pair-taken`, and cezar gets `{"t":"pair-contested"}` |
| Slot | A phone slot burns once used. A phone that disconnects cannot rejoin. Neither side can reconnect to a rendezvous |
| Control | `{"t":"peer-joined"}` goes to **both** sockets when the phone joins. `{"t":"peer-left"}` goes to the survivor, or to a sender with no peer |
| Volume | At most 32 frames per rendezvous, summed over both sockets, **text included**. `ping` alone does not count, because the runtime answers it. The 33rd sends `closing` and closes both sockets with 4429 |
| Frame size | 16,384 bytes including the header. `hello` on a rendezvous reports this as `frameBytes` |
| Storage | None. When both sockets are gone, nothing remains |

The relay does not know whether a pairing succeeded. Success is a `device-add` on the room.

**`peer-left`, `pair-contested`, and every close of a rendezvous socket end that code.** Neither side
can rejoin, so cezar discards the secret and code and shows a new one. A rendezvous is never
reconnected, whatever the close code says elsewhere.

`rendezvousPerHour` is charged once per `role=cezar` upgrade, and a rendezvous counts as first-seen for
`newRoomsPerHour`. A rate-limited one has `Retry-After: 3600`.

## 6. Relay behaviour

1. **Sleep.** With no phone socket in a room, the room hibernates. A hibernated cezar socket does not
   cost duration. No timer, alarm, outbound request or non-hibernating socket may hold a room awake.
   Rooms have no alarm at all: a daily cron deletes expired rooms. A rendezvous is a separate object
   and keeps one pending one-shot alarm of at most 300 s, which is the only way its 4408 can fire. It
   hibernates until then.
2. **No buffering.** A data frame with no live target is dropped, with `phone-left` to a cezar or
   `cezar-offline` to a phone. The relay queues nothing.
3. **No persistence.** Payloads are never written to storage, logs or analytics. Connection metadata
   is logged only in aggregate.
4. **Order.** Frames between two sockets stay in order, with no duplicates. Clients still treat
   reordering or loss as fatal to their session.
5. **Client half of the sleep rule.** cezar sends no data frame without a live session, except a `KK`
   reply to a first message. Only `ping`, the one `device-sync` after connecting, and device commands
   from the user cross an idle socket.
6. **Storage expiry.** The daily cron deletes a room's storage 90 days after its last authenticated
   cezar socket closed or its last signed `POST /v1/push`, and never while a denylist entry is still
   live. A Manual server never opens a socket, and losing its denylist would revive a revoked grant.
7. **Quotas are event-driven.** A timer is forbidden, so `phoneSecondsPerDay` and `bytesPerDay` are
   checked on the next frame from either side or the next connect. Over `phoneSecondsPerDay`, phones
   close with 4430 and cezar stays connected. A fully silent phone overruns only while the room
   sleeps, which costs nothing. `framesPerSecond` counts text frames too, since they wake the room.
   `bytesPerDay` counts each data frame once, on the way in.
8. **Kill switch.** New requests are refused with 503 `relay-disabled`. A live socket gets `closing` and
   4503 on its next frame.

## 7. Push

A grant ties one phone's push token to one cezar key, without either party's store holding the token.
Sealing keys live only in the relay's secrets. Delivery itself is built in a later phase, and this
section is the contract for it.

All `POST` bodies are at most `controlBytes`, share the `ipUpgradesPerMinute` counter, and are refused
with 400 `bad-request` if they have any key not listed here. A `/v1/push-grants` call is therefore
rate-limited even though any key may call it.

**Get a grant.** `POST /v1/push-grants`, signed by the device key:

```json
{ "platform": "ios", "token": "<apns or fcm token>", "cezarKey": "<ed25519Pub>" }
```

`platform` is `ios` or `android`. `token` is 1 to 1,024 characters. The answer is
`200 { "grant": "…", "grantId": "…", "expiresAt": 1801267200 }`. A grant lasts 90 days, and the phone
renews on app open once under 30 days remain. The phone hands it to cezar as an HTTP request inside
the session, so no tunnel frame exists for it.

**Send.** `POST /v1/push`, signed with the key sealed in the grant:

```json
{ "v": 1, "grant": "…", "kind": "attention", "count": 3, "id": "<22 characters>", "ts": 1793491200 }
```

| Field | Rule |
| --- | --- |
| `v` | `1` |
| `kind` | `attention` is the only value in v1 |
| `count` | Integer 0 to 99, the badge |
| `id` | `base64url` of 16 random bytes. Refused if seen in the last 10 minutes |
| `ts` | Unix seconds within ±120 s |

The relay sends a fixed notification and forwards nothing from the request except `count`: title
`Cezar`, body `Cezar needs you`, badge `count`, custom data `{ "s": "<cezarId>" }`, collapse key
`cezarId`, expiry 1 hour.

| Answer | Meaning | cezar does |
| --- | --- | --- |
| 202 `{ "ok": true }` | Handed to APNs or FCM | Nothing |
| 400 `bad-request` | Malformed | Logs it. A bug, never retried |
| 401 `bad-proof` | Bad signature, wrong key, or `ts` out of range | Logs it |
| 403 `grant-denied` | On the denylist | **Deletes the grant** |
| 409 `replay` | `id` already seen | Nothing |
| 410 `grant-gone` | Expired, unreadable, or the token is dead | **Deletes the grant** |
| 429 `rate-limited`, with `Retry-After` | Over a push limit | Drops this signal, keeps the grant |
| 503, no body | APNs, FCM or the relay failed, or a seal key is missing | Drops this signal, **keeps the grant** |

Only 403 and 410 delete a grant. Delivery is best effort. Neither side retries a dropped signal, and
the card stays in the chat.

**Revoke.** `POST /v1/push-grants/revoke`, signed by the device key sealed in the grant, with body
`{ "grant": "…" }`.

| Answer | Meaning | Phone does |
| --- | --- | --- |
| 204 | The denial is stored. **Only this means stored** | Done |
| 400 `bad-request`, 401 `bad-proof` | Malformed, or not this grant's key | Stops and logs it |
| 410 `grant-gone` | The relay cannot open the grant | Stops. Nothing is left to deny |
| 429 with `Retry-After` | Over a limit, including `newRoomsPerHour` for a revoke that creates a room | **Retries** after `Retry-After` |
| 503, with `Retry-After` when stored state failed | Not stored | **Retries** after `Retry-After`, or with full jitter |

The same grant can be denied by `device-remove`, where the denial lasts the full 90 days because that
command does not know the grant's expiry. A revoke's denial expires with the grant.

A room holds two pools of 1,000 live denials. cezar and allowlisted phones share one. Keys not on the
allowlist share the other, because any key can mint a grant for a room, and each such key holds at
most 8, where a ninth displaces its own oldest. A Manual server's phones are always in the second pool,
so its revokes can answer 503 while that pool is full.

## 8. Limits

Starting values. `hello` carries the live ones, and a client MUST obey them.

| Name | Scope | Value |
| --- | --- | --- |
| `frameBytes` | One binary frame, header included | 65,552 (16,384 on a rendezvous) |
| `controlBytes` | One text frame, and one `POST` body | 8,192 |
| `devices` | Allowlist per room | 10 |
| `phoneSockets` | Concurrent phone sockets per room | 3 |
| `framesPerSecond` | Frames per room, both directions, text included | 500 |
| `bytesPerDay` | Data bytes per room, per UTC day | 2 GiB |
| `phoneSecondsPerDay` | Summed phone-connected time per room, per UTC day | 28,800 |
| `connectsPerMinute` | Upgrades per `deviceId` or `cezarId` | 30 |
| `ipUpgradesPerMinute` | Upgrades and `POST`s per source IP | 60 |
| `newRoomsPerHour` | First-seen `cezarId` per source IP | 10 |
| `rendezvousPerHour` | Rendezvous per `cezarId` | 10 |
| `pushesPerMinute` | `POST /v1/push` per grant | 6 |
| `pushesPerDay` | `POST /v1/push` per room | 200 |

A phone's frame grows by 16 bytes on the way to cezar, so **ciphertext MUST stay at or under
`min(65,535, frameBytes − 17)`**. That one bound holds for both directions and for Noise's own message
limit. From it:

| Value | Formula | At 65,552 | At 16,384 |
| --- | --- | --- | --- |
| Largest ciphertext | `min(65535, frameBytes − 17)` | 65,535 | 16,367 |
| Largest record | `⌊(ciphertext − 16) / 256⌋ × 256` | 65,280 | 16,128 |
| Largest frame content | record − 2 | 65,278 | 16,126 |
| Largest `DATA` payload | record − 7 | 65,273 | 16,121 |

A `frameBytes` under 16,384 is a broken relay: the client closes with 1000 and reports it.

## 9. Pairing

### 9.1 QR string

```abnf
qr       = origin "/p#" version "." secret "." cezarkey
origin   = ("https" / "http") "://" host [":" port]
host     = 1*(%x61-7A / DIGIT / "-" / ".")   ; lowercase ASCII, punycode for IDN
         / "[::1]"
port     = %x31-39 *4DIGIT                   ; 1 to 65535
version  = 1*DIGIT                           ; "1" today
secret   = 43base64url                       ; 32 random bytes
cezarkey = 43base64url                       ; cezar's X25519 public key
```

There is no user info, no other path and no query. The parser is strict, and anything else is
refused. A browser never sends the fragment, so a system camera that opens the link reaches `GET /p`
with no secret. A hostile relay could serve script there, so a system-camera scan counts as a
photographed code. Any `version` other than 1 shows "Update the app".

| Scheme | Host | Release app | Debug app |
| --- | --- | --- | --- |
| `https` | Any | Yes | Yes |
| `http` | Exactly `127.0.0.1`, `localhost`, `[::1]` or `10.0.2.2` | **No** | Yes |
| `http` | Anything else | No | No |

`http` means `ws`. cezar applies the host rows to `CEZ_RELAY_URL` too. With `CEZ_RELAY_URL` unset or
invalid, `capabilities.phonePairing` is false. No relay host is built in.

### 9.2 Secrets

A pairing has two independent credentials, and each opens its own rendezvous. Whichever gets
`peer-joined` first wins, and cezar closes the other with 1000. So one pairing costs two of
`rendezvousPerHour`, and cezar's limit of 5 pairings an hour fits it exactly. If the second rendezvous
is refused, cezar shows the QR code alone.

**QR.** `secret` is 32 random bytes. With HKDF-SHA256 (RFC 5869), salt the 24 ASCII bytes
`cezar-relay-pair-salt-v1`, and output 32 bytes each:

```text
locatorBytes = HKDF(secret, salt, info = "cezar-pair-locator-v1")
psk          = HKDF(secret, salt, info = "cezar-pair-psk-v1")
```

**Typed code.** Twelve characters of Crockford base32, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`,
each one from 5 independent random bits, 60 bits in all. It is shown as `XXXX-XXXX-XXXX`.

To normalize what a user typed, in order: remove space, `-`, and U+2010 to U+2015. Uppercase ASCII
letters. Replace `O` with `0`, and `I` and `L` with `1`. The result MUST be exactly 12 characters of the
alphabet, otherwise refuse it. `U` is refused.

```text
okm          = PBKDF2-HMAC-SHA256(password = ASCII code, salt = "cezar-pair-code-v1",
                                  iterations = 200000, dkLen = 64)
locatorBytes = okm[0..32]
psk          = okm[32..64]
```

A typed code cannot carry the relay address, and no default host exists while QR1 is open. So desktop
shows the address beside the code, and the app's Enter code screen has a relay address field. The field
takes an `origin` under the table above, and `https://` is assumed if the user typed no scheme. The
same field may be prefilled, or hidden, the day a default host exists.

`locator = base64url(locatorBytes)`. Vectors: `qr.json`, `code.json`.

### 9.3 Handshake

`Noise_XXpsk3_25519_ChaChaPoly_SHA256` (Noise revision 34). The phone is initiator, cezar is
responder. Both carry the handshake in rendezvous data frames.

```text
prologue = "cezar-pair-v1" (13 ASCII bytes) ‖ locatorBytes (32 bytes)
psk      = from § 9.2

-> e                   payload empty                       48 bytes
<- e, ee, s, es        payload empty                       96 bytes
-> s, se, psk          payload = record(phone JSON)        48 + record + 16 bytes
```

The phone sends the first message after `peer-joined`.

**Nothing is sent to an unproven peer.** The second message reaches whoever joined, including a relay
that only knows the locator, so its payload is empty and cezar's relay key waits for `pending`.

**Pin.** After reading the second message, a QR phone compares the handshake's remote static key with
`cezarkey`, in constant time. On a mismatch it closes with 1000 and warns, and the third message is
never sent. A typed code has no key to pin, so the six digits carry that weight.

The third message's plaintext is one [record](#11-records) holding this JSON, at most 1,024 bytes:

```json
{ "name": "Pixel 9", "platform": "android", "relayKey": "<device ed25519Pub>", "tunnel": { "min": 1, "max": 1 } }
```

| Key | Rule |
| --- | --- |
| `name` | 1 to 64 UTF-8 bytes, no control characters. A phone truncates on a character boundary. Displayed as reported by the phone |
| `platform` | `android` or `ios` |
| `relayKey` | `base64url` device Ed25519 public key. `deviceId` comes from it |
| `tunnel` | The tunnel versions the phone speaks. Stored by nobody: it only proves a usable overlap now |

The device's X25519 public key is the `s` token, so it is not repeated. If the third message fails to
decrypt, cezar closes with 1000 and the phone sees `peer-left`.

An X25519 output of all zero bytes MUST be treated as a failed handshake, in this pattern and in `KK`.

**Six digits.** With `h` the final handshake hash:

```text
n = big-endian uint32 of HKDF(h, salt, info = "cezar-pair-sas-v1", 4 bytes)
digits = n mod 1000000, zero-padded to 6
```

The `salt` is the one in [§9.2](#92-secrets). Vectors: `handshake-xxpsk3.json`, `sas.json`.

### 9.4 Messages after the handshake

After `Split()`, each message is a Noise transport message, one [record](#11-records) of JSON at most
1,024 bytes, in a rendezvous data frame. **Only cezar sends them.** The phone sends nothing after the
third handshake message: it leaves by closing its socket.

| Message | Sent when |
| --- | --- |
| `{"t":"pending","relayKey":"<cezar ed25519Pub>","tunnel":{"min":1,"max":1},"label":"<computer>"}` | At once, on reading a valid third message. Both screens then show the six digits |
| `{"t":"approved"}` | After Approve, and after `ack` for `device-add` |
| `{"t":"denied"}` | After Deny |
| `{"t":"failure","reason":"<reason>"}` | The pairing cannot finish |

`label` is 1 to 64 UTF-8 bytes naming the computer, for the phone's server list. The phone derives
`cezarId` from `relayKey`, and keeps the origin, `cezarId`, the handshake's remote static key and
`deviceId`.

| `reason` | Meaning |
| --- | --- |
| `device-limit` | The allowlist is full |
| `relay-error` | `device-add` failed or got no `ack` in 10 s |
| `timeout` | Nobody decided before the rendezvous was ending |
| `cancelled` | The user closed the screen or asked for a new code |
| `contested` | `pair-contested` arrived |
| `bad-payload` | The phone's JSON broke [§9.3](#93-handshake) |
| `tunnel-unsupported` | No shared tunnel version. Carries `"tunnel":{"min":…,"max":…}`, cezar's range, instead of a `pending` |
| `internal` | Anything else |

An unknown `reason` reads as `internal`.

**Flow on Approve.** cezar saves the device, opens its relay socket if it has none, waits for `hello`,
sends `device-sync`, sends `device-add`, and waits for its `ack`, at most 10 s. Then it sends `approved`.
On failure, it deletes the row and sends `failure`. No device row exists before Approve.

**Who closes.** After `approved`, `denied` or `failure`, the phone closes with 1000. cezar closes with
1000 after 5 s if the phone has not. A `peer-left` after `approved` is not a failure. Otherwise a
`peer-left`, `pair-contested` or any close ends the code, under [§5](#5-rendezvous), and a phone that
lost its socket before reading an outcome reports the pairing as failed. If `approved` was lost, a
device row remains and Remove clears it.

After `approved`, the phone opens `/v1/phone/<cezarId>/<deviceId>` and starts a [session](#10-session).

## 10. Session

`Noise_KK_25519_ChaChaPoly_SHA256`, on the phone socket. The phone is initiator, cezar is responder,
and each uses the static keys pinned at pairing.

```text
prologue = "cezar-session-v1" (16 ASCII bytes) ‖ cezarId (16 raw bytes) ‖ deviceId (16 raw bytes)

-> e, es, ss     payload MUST be empty                exactly 48 bytes
<- e, ee, se     payload = record({"tunnel":{…}})     32 + record + 16 bytes
```

**No 0-RTT.** cezar MUST refuse a first message that is not exactly 48 bytes, and MUST act on nothing
until both ephemerals are mixed. The reply's JSON is cezar's tunnel range, for example
`{"tunnel":{"min":1,"max":1}}`, in a record.

The phone sends the first message when it has no session and the relay says cezar is present: `hello`
with `"cezar":"online"`, or `cezar-online`. cezar answers one first message per slot. A slot opens at
`phone-joined` or per entry in `hello.phones`, and it stays used until `phone-left`. A first message
from a device with no saved row, or with no open slot, is dropped with no answer. The phone waits 10 s
for the reply. On timeout, it closes the socket and reconnects with jitter. Frames that arrive from a
device with no session and no open slot are dropped.

Tunnel records then flow as Noise transport messages, in data frames. Vector: `session-kk.json`.

### 10.1 When a session ends

A session never outlives its socket on either side, and has no resumption. Everything below also
ends every stream in it. In-flight proxy requests fail with [502](#132-errors).

| Event | cezar | Phone |
| --- | --- | --- |
| `phone-left` | Ends that device's session | |
| Its own relay socket drops | Ends every session | |
| `cezar-offline` | | **Ends the session and keeps the socket.** Sends nothing until `cezar-online` |
| `cezar-online` | | Starts a new `KK`, also when `offline` and `online` arrived together. Frames are handled in order, so the session ends first |
| Any decryption failure, or a malformed record or frame | Sends `CLOSE` `protocol-error` if it can, ends the session | Sends `CLOSE` `protocol-error` if it can, then closes the socket with 1000 and reconnects with jitter |
| No `LEASE` for 60 s | Sends `CLOSE` `lease-expired`, ends the session | |
| No `LEASE` from cezar for 45 s | | Closes the socket with 1000 and reconnects with jitter |
| `CLOSE` received | Ends the session. `goodbye` also deletes the device row, then sends `device-remove` | Ends the session and closes the socket with 1000. `device-removed` shows nothing yet: 4403 decides. Otherwise it reconnects with jitter |
| Remove on desktop | Deletes the row, sends `CLOSE` `device-removed`, ends the session, sends `device-remove` | |
| App leaves the foreground | | Closes the socket with 1000 |
| Forget server | | Sends `CLOSE` `goodbye` if a session is live, then revokes grants and deletes keys |

cezar stays silent to a device whose session ended until the next `phone-joined`, so a phone that
missed `CLOSE` learns from the 45 s rule. A removed phone that the relay still admits gets no reply to
its first message.

## 11. Records

Every plaintext that this protocol encrypts, apart from the empty handshake payloads, is a record:

```text
content_len : uint16      length of content
content     : bytes
padding     : zero bytes, so the whole record is a multiple of 256 bytes
```

A sender MUST use the smallest multiple, and at least 256. A receiver MUST refuse a record whose
length is zero or not a multiple of 256, whose `content_len` runs past its end, or with a non-zero
padding byte. It need not refuse a longer record than necessary, so cover traffic stays possible.

## 12. Tunnel

Each record's content is exactly one tunnel frame. The first byte is the type, and a receiver MUST
refuse trailing bytes, an unknown type, or a frame its direction may not send, as a protocol error.
A later type needs a later tunnel version.

| Type | Name | From | Body after the type byte |
| --- | --- | --- | --- |
| `0x00` | `HELLO` | Phone | `min: u16`, `max: u16` |
| `0x01` | `OPEN` | Phone | `stream: u32`, `method: str8`, `target: str16`, `headers` |
| `0x02` | `HEAD` | cezar | `stream: u32`, `status: u16`, `headers` |
| `0x03` | `DATA` | Both | `stream: u32`, payload: the rest of the frame |
| `0x04` | `END` | Both | `stream: u32` |
| `0x05` | `RESET` | Both | `stream: u32`, `code: u16` |
| `0x06` | `WINDOW` | Both | `stream: u32`, `increment: u32` |
| `0x07` | `LEASE` | Both | None |
| `0x08` | `REKEY` | Both | None |
| `0x09` | `CLOSE` | Both | `code: u16` |

```text
str8    = length: u8  ‖ bytes
str16   = length: u16 ‖ bytes
headers = count: u16  ‖ count × (name: str8 ‖ value: str16)
```

`HEAD` is how a response begins. `OPEN` has no response frame of its own, so exactly one `HEAD` comes
before any `DATA` from cezar on that stream. It carries the final status, 200 to 599. Neither 1xx nor
101 is ever sent. There are no trailers.

Vector: `tunnel-frames.json`.

### 12.1 Order and streams

- The phone's first frame MUST be `HELLO` ([§14](#14-version-negotiation)), then `LEASE`, then anything.
  A first frame of any other type except `CLOSE` is a protocol error.
- **Only the phone opens streams.** cezar has no frame that starts one.
- Stream ids start at 1 and each `OPEN` uses the previous id plus 1. They are never reused, and 0 is
  invalid. An `OPEN` with any other id is a protocol error. Running out of ids ends the session.
- At most 32 streams are open in a session. One more is answered with `RESET` `too-many-streams`, which
  does not end the session.
- A frame for an id above the highest opened is a protocol error. A frame for a finished or reset stream
  is ignored, because it crossed in flight.
- A stream is finished when both directions have sent `END`, or when either side sends `RESET`. A `GET`
  is `OPEN`, `END` from the phone, then `HEAD`, `DATA`…, `END` from cezar.
- If cezar finishes a response while the request body is unfinished, it follows its `END` with
  `RESET` `cancelled`, and the proxy discards the rest of the body.

| `RESET` code | Name | Meaning |
| --- | --- | --- |
| 1 | `cancelled` | The reader went away |
| 2 | `flow-control` | The sender passed its window |
| 3 | `bad-request` | The `OPEN` broke [§13](#13-http-mapping) |
| 4 | `too-many-streams` | Over 32 |
| 5 | `head-too-large` | Headers would not fit in `HEAD` |
| 6 | `internal` | Anything else, and any unknown code |

| `CLOSE` code | Name | Meaning |
| --- | --- | --- |
| 1 | `normal` | Nothing is wrong |
| 2 | `goodbye` | Forget server. Delete this device |
| 3 | `lease-expired` | 60 s passed with no `LEASE` |
| 4 | `protocol-error` | A malformed or disallowed frame |
| 5 | `tunnel-unsupported` | No shared tunnel version |
| 6 | `device-removed` | Remove on desktop |

An unknown `CLOSE` code reads as `protocol-error`. A side sends nothing after `CLOSE`.

### 12.2 Flow control

Each direction of each stream has a window of 262,144 bytes (256 KiB), and only `DATA` payload bytes
count. A sender subtracts each payload from the window, and MUST NOT send with too little window left.
A receiver that gets more than the window answers `RESET` `flow-control`.

The receiver gives credit with `WINDOW` as its consumer takes the bytes, MAY do so at any time, and
MUST do so by the time 131,072 unacknowledged bytes have been consumed. `increment` is 1 to 262,144, and
a `WINDOW` that takes the window over 262,144 is `RESET` `flow-control`. A stalled SSE stream therefore
holds at most 256 KiB. There is no session window.

`DATA` payloads are at most the largest `DATA` payload from [§8](#8-limits), and a longer body is split
in order. A sender MUST NOT send an empty `DATA`, and a receiver ignores one. A proxy forwards bytes as
they arrive and never waits to fill a frame, which is what keeps SSE live.

### 12.3 Lease

The phone sends `LEASE` right after `HELLO`, then every 20 s. cezar answers each `LEASE` with one
`LEASE`. Only `LEASE` renews, on either side. After 60 s without one, cezar ends the session and every
stream. The clock starts when `KK` completes. After 45 s without one, the phone ends it. Together these
bound how long a vanished peer can keep traffic flowing, and how long a silent one can go unnoticed.

### 12.4 Rekey

Each direction rekeys on its own, after 1 hour or 2^32 messages since that direction's last key,
whichever comes first. The sender checks before each send. It sends `REKEY` as its last frame under the
old key, then calls Noise's `Rekey()` on its sending cipher. The receiver calls `Rekey()` on its
receiving cipher right after reading that frame. `Rekey()` keeps the nonce counter: only the key changes.
Vector: `rekey.json`.

## 13. HTTP mapping

### 13.1 Requests

`method` is one of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`. `target` is origin-form,
path and query, at most 8,192 bytes of ASCII. It starts with exactly one `/`. An `OPEN` or `HEAD` frame
is at most 16,000 bytes of content, which fits in any legal `frameBytes`. Beyond that, the proxy answers
431 itself, and cezar sends `RESET` `head-too-large`.

Header names are lowercase. Repeats are allowed, and order is kept. Values MUST NOT contain CR, LF or
NUL. cezar answers any `OPEN` that breaks these with `RESET` `bad-request`. Vectors: `negative.json`.

The proxy and the dispatcher both remove these request headers, so a modified app cannot look local:

| Group | Headers |
| --- | --- |
| Identity | `host`, `origin`, `cookie`, `authorization` |
| Forwarding | every `x-forwarded-*`, `forwarded`, `x-real-ip` |
| Fetch metadata | every `sec-fetch-*` |
| Hop-by-hop | `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade` |

The proxy adds `user-agent: CezarMobile/<version>`, replacing the webview's. It decodes a chunked
request body before framing it. It keeps `content-length` if the webview sent it, and a body that does
not match is `RESET` `bad-request`. `Upgrade` is refused, with 400 from the proxy and `RESET` `bad-request`
from cezar, so no WebSocket crosses the tunnel. The dispatcher sets its own `host`. Identity comes from
the session, never from a header.

**The proxy's gate.** It serves only on `127.0.0.1`, and a request needs its per-listener `HttpOnly`,
`SameSite=Strict` cookie, `Host` exactly `127.0.0.1:<port>`, any `Origin` equal to that authority, and any
`Sec-Fetch-Site` equal to `same-origin` or `none`. Otherwise it answers 403 and nothing enters the tunnel.

### 13.2 Responses

The dispatcher sends whatever `app.fetch` answers, in `HEAD` and `DATA`, minus the hop-by-hop group. The
proxy also removes `set-cookie`, because a response must not reach the gate cookie, and
`www-authenticate`, because a relay server has no challenge. Without a `content-length`, the proxy uses
chunked encoding. A 204 or 304 is `HEAD`, then `END`.

<a id="132-errors"></a>

| Tunnel event | What the webview gets |
| --- | --- |
| No session | 503 with `retry-after: 1` |
| `RESET` or a lost session before `HEAD` | 502 |
| `RESET` `too-many-streams` before `HEAD` | 503 with `retry-after: 1` |
| `RESET` or a lost session after `HEAD` | The connection is aborted, so the read fails |

**The proxy never retries a write.** A lost connection during a `POST` is a 502, and the `decision`
route's pins cover a user's second tap. A `GET` is not retried by the proxy either.

## 14. Version negotiation

| Layer | How |
| --- | --- |
| Relay contract | `/v1` in the path, `protocol` in `hello`, and 426 or 4426 if retired. A `protocol` other than 1 is handled as 4426 |
| QR string | The leading `version`, [§9.1](#91-qr-string) |
| Tunnel | Each side states `{ min, max }`, and both use the highest version they share |

cezar states its tunnel range in the `KK` reply. The phone cannot state its own in a first message that
must be empty, so it states it in `HELLO`, the same bytes in every version. Both then compute
`min(phone.max, cezar.max)`, valid when it is at or above `max(phone.min, cezar.min)`. With no shared
version, the phone sends `CLOSE` `tunnel-unsupported` instead of `HELLO`, and shows "Update the app" when
`phone.max < cezar.min`, otherwise "Update cezar". cezar shows nothing. `HELLO` and `CLOSE` keep this
layout in every later version.

During pairing, `tunnel` in the third message and `pending` only prove an overlap exists, and the live
session negotiates afresh, since either side may update later.

## 15. Timers

| Timer | Value | Owner | On expiry |
| --- | --- | --- | --- |
| Proof clock skew | ±120 s | Relay | `bad-proof` |
| `ping` | Every 45 s, never over one per 20 s | Every client | |
| `pong` wait | 15 s | Every client | Network loss |
| Reconnect | Full jitter, 1 s to 5 min | Every client | |
| QR and code life, claim window | 120 s from creation | Relay, cezar's countdown | 4408, "Show a new code" |
| Rendezvous hard life | 300 s from creation | Relay | 4408 |
| `device-add` `ack` | 10 s | cezar | `failure` `relay-error` |
| Rendezvous close after an outcome | 5 s | cezar | Close 1000 |
| `XXpsk3` completion | 30 s from `peer-joined` | Both | Close 1000. The code ends |
| `KK` reply | 10 s | Phone | Close socket, reconnect |
| `LEASE` send | Every 20 s | Phone | |
| `LEASE` from phone | 60 s | cezar | `CLOSE` `lease-expired` |
| `LEASE` from cezar | 45 s | Phone | Close socket, reconnect |
| Rekey | 1 hour or 2^32 messages, per direction | Each sender | `REKEY` |
| Grant life, renewal | 90 days, under 30 days left | Relay, phone | |
| Push replay window | 10 minutes | Relay | 409 `replay` |
| Room expiry | 90 days | Relay's daily cron | Storage deleted |

## 16. Crypto requirements

Primitives come from audited libraries only: X25519, ChaCha20-Poly1305, SHA-256, Ed25519, HKDF and
PBKDF2. The Noise state machine is thin over them where no maintained library has `XXpsk3`, `KK` and
`Rekey`. It MUST pass `test-vectors/relay/noise-published/` and the shared vectors.

ChaCha20-Poly1305 nonces are Noise's: four zero bytes, then the counter as a little-endian `uint64`.
Associated data for transport messages is empty. Ephemeral keys are never reused. Fixed ephemerals
exist in test vectors only.

## 17. Test vectors

`test-vectors/relay/` holds the shared vectors, their generator and how to consume them. Every client
MUST pass them in its own language.
