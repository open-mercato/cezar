# Relay test vectors

Shared vectors for [RELAY_PROTOCOL.md](../../RELAY_PROTOCOL.md). The Node client, the Kotlin and Swift
app clients and the relay each test against these files. Keep them byte-identical: a change here is a
protocol change.

Bytes are lowercase hex unless a field is a wire string, which stays `base64url` or text as on the wire.

| File | Covers |
| --- | --- |
| `proof.json` | Ids and relay proofs for sockets and `POST`s. Its first case is the spec's vector |
| `qr.json` | QR parsing, accepted per app build, refused with a reason, and the HKDF derivations |
| `code.json` | Typed code normalization and PBKDF2 |
| `sas.json` | The six digits |
| `handshake-xxpsk3.json` | One full pairing, with fixed keys and ephemerals, and the messages after it |
| `session-kk.json` | One `KK` handshake and one health request, with the wire bytes for each hop |
| `frames.json` | Data frames per hop, and exact control frames |
| `tunnel-frames.json` | Every tunnel frame with its fields, content and padded record; padding sizes; limits; chunking |
| `rekey.json` | One direction across two rekeys |
| `negative.json` | Cases that must fail |

## Consuming them

- **Ephemerals.** A client needs a test-only way to inject `ephemeralSecret`. Production code must not
  expose it.
- **Ed25519.** Verify `sig`. A deterministic signer must also reproduce it. CryptoKit signs with
  randomness, so Swift verifies only.
- **Handshakes.** Replay `messages` from both roles. Compare each message, `handshakeHash`, the digits
  and `transportKeys`, then decrypt what follows.
- **`transportKeys`.** `phoneToCezar` is Noise's first split key. Each transcript entry gives its `nonce`.
- **Pairing failures.** `failuresWithoutPending` replace `pending`, so they use nonce 0. `outcomesAtNonce1`
  follow it.
- **`negative.json`.**
  - `transport`: start one receiver at `key`, nonce 0, and deliver in order. `fail` must be a decryption
    failure, which ends the session.
  - `afterRekey`: at `key` and `nonce`, decryption must fail.
  - `handshake`: `refuse` must stop the handshake before anything is acted on. Start from
    `handshake-xxpsk3.json` or `session-kk.json`, with their keys and ephemerals. For the wrong-PSK case,
    read `messagesBefore`, write cezar's own second message, then read `message`. The KK-with-payload
    case passes Noise itself: the 48-byte rule is what refuses it.
  - `record`: must be refused by the record reader.
  - `tunnel`: must be refused by the frame reader or the `OPEN` and `HEAD` checks.

## Reproducing them

Node 20 or later, with no install. The generator uses `node:crypto` (OpenSSL) and nothing else.

```bash
node test-vectors/relay/generator/generate.mjs         # rewrite, print one hash over all vectors
node test-vectors/relay/verify.mjs                     # independent re-check, built-ins only
node test-vectors/relay/generator/check-published.mjs  # noise.mjs against Noise's published vectors
(cd test-vectors/relay/snow-check && cargo run --release)   # a second Noise implementation agrees
```

`verify.mjs` shares no code with `generator/`. It re-checks proofs, ids, QR parsing, derivations, the
digits, frames and records, and decrypts every transport message. It does not run Noise handshakes:
`check-published.mjs` and `snow-check` cover those. `snow-check` replays both handshakes, the hash, the
transport frames and rekey through the `snow` crate, byte for byte.

## Status of the Noise layer

`generator/noise.mjs` is an **unaudited** Noise state machine, thin over audited primitives. No
maintained JavaScript library has `XXpsk3`, `KK` and `Rekey` together. It passes the published vectors
for `KK`, `XX` and `XXpsk3`, and `snow` agrees with it, but `snow` is unaudited too. Published vectors
do not cover `Rekey`, so that rests on `snow` and on `verify.mjs`, which derives each new key by hand.
`packages/cezar/test/unit/relay-vectors.test.ts` runs the three Node checks in CI, and regenerating must
reproduce every committed byte.
Nothing in this directory ships: it is outside every npm workspace, and the published CLI does not
depend on it.

The R1 review fixes (spec changelog, 2026-11-01) are text only: no vector byte changed, and `verify.mjs` and `generate.mjs` give the same results.
