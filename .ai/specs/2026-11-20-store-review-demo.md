# Store-review demo cezar

Refs `.ai/specs/2026-10-31-mobile-apps-manager-first.md` (Q10), `.ai/specs/2026-11-01-relay-qr-pairing.md`
(§ How a reviewer pairs, R6).

Status: **built on branch `demo/store-review`, which is never merged into `main`** (owner, 2026-11-24:
a one-off demo for reviews). The operator's guide is `packages/mobile/demo/README.md`.

## Decisions (owner, 2026-11-24)

| Question | Decision |
| --- | --- |
| Where it lives | Its own branch, deployed from a build of that branch; never on `main`, never on npm |
| What it is | A real cezar in dry run: fake projects and a fake manager; mock agents that say on every reply it is a demo |
| How a reviewer connects | Through the real relay, like a user's computer: a fixed typed code, auto-approved. No domain, no login |

## Design

- `CEZ_RELAY_DEMO_CODE` (dry run only): the relay service keeps one typed-code rendezvous open on that
  code, reopening it 7 s after each one settles (≈28/h), and approves the phone when the handshake ends.
  It needs the demo's own relay account attached; it retries every minute until there is one.
- `CEZ_DEMO=1` (dry run only): relay-scoped writes pass a route allowlist (`src/demo.ts`), else 403;
  check steps never run; the mock agent runs its demo script.
- Kit: `deploy.sh` (build, pack, copy, run setup), `setup.sh` (Node 22, the packed cezar, sandboxed user,
  egress DNS + 443, service with `Restart=always`, nightly reset, 2-hourly tick), `seed.sh`, `reset.sh`,
  `local.sh`.
- rome: per-cezarId `rendezvousPerHour` override and `newRoomsPerHour` exemption (needed for an always-open
  code), and locator reservation (recommended). See the README's "What rome needs".

## Verified

- Unit: `src/demo.test.ts`, `src/relay/demo-pairing.test.ts`.
- Local: rome under `wrangler dev`, `local.sh`, Android emulator with a debug CezarBot: Enter code →
  paired with no approval → phone terms → Manager with question and approval cards → approve, start a
  task from chat, answer its question, task done with its fake PR.
- Push notifications could not be checked locally (no FCM credentials on a dev relay).

## Changelog

- 2026-11-20: First draft (merge-to-main design, PR off main).
- 2026-11-24: Owner: one-off branch, never merged; relay pairing through the real relay. Rewritten to what was built.
