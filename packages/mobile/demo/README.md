# Store-review demo cezar

**Branch `demo/store-review` only. Never merge it into `main`.** It adds two demo-only switches to cezar
and a deploy kit, so a one-off demo cezar can run on a VPS for App Review and Google Play review.

A reviewer types one fixed code into CezarBot's **Enter code** and lands in a fake cezar: three sample
projects, tasks in every state, a manager with a question card and an approval card. Every agent is
the bundled mock and says on every reply that it is a demo. The demo connects to phones only through
the real relay (`rome.cezar.run`), exactly like a user's own computer. No domain, TLS or open port.

Design: `.ai/specs/2026-11-20-store-review-demo.md`.

## What the branch changes in cezar

| Switch | Effect | Code |
| --- | --- | --- |
| `CEZ_RELAY_DEMO_CODE=XXXX-XXXX-XXXX` (needs `CEZ_DRY_RUN=1`) | Keeps a typed-code rendezvous open on that fixed code, reopening it every time one ends (about 28 an hour), and approves a phone as soon as the handshake ends. Logs `cezar demo: pairing code open … for cezarId <id>` once | `packages/cezar/src/relay/service.ts` (`runDemo`), `pairing.ts` (`startWithCode`, `autoApprove`) |
| `CEZ_DEMO=1` (needs `CEZ_DRY_RUN=1`) | A paired phone may read everything but change only an allowlist (start/answer/stop tasks, manager chat and cards, its own notification settings); anything else is 403 "Not available in the demo." Check steps never run. The mock agent switches to its demo script | `packages/cezar/src/demo.ts`, `server/server.ts`, `workflows/run.ts`, `workflows/landing.ts`, `scripts/mock-claude.mjs` |

Tests: `packages/cezar/src/demo.test.ts`, `packages/cezar/src/relay/demo-pairing.test.ts`.

## Deploy (one command)

Needs: a fresh Ubuntu 24.04 VPS you can `ssh root@` into (1 vCPU, 2 GB RAM, 20 GB disk is plenty), and a
mailbox for the demo's **own** relay account (an alias like `cezar-demo@…`; never your personal account).
Set the VPS hostname first: CezarBot shows it as the computer's name (`hostnamectl set-hostname cezar-demo`).

```bash
packages/mobile/demo/deploy.sh root@<vps-ip> --relay-email cezar-demo@example.com
```

It builds cezar from this branch, packs it, copies the kit and runs `setup.sh` on the box, which installs
Node 22 and that cezar, creates the sandboxed `cezar-demo` user, an egress filter (DNS and HTTPS only),
the service (restarts on failure and on boot), a nightly reset (03:00 UTC) and a 2-hourly tick that keeps
a task running, seeds the data, attaches the relay account and prints:

```text
  Demo code:  K7QM-3XNA-9VPD   (CezarBot > Enter code)
  Relay:      default (https://rome.cezar.run)
  cezarId:    uCCjdU5AZRRngvVLy3mJXw
  Account:    cezar-demo@example.com — pending  (pending: click the link the relay emailed)
```

Then, once:

1. **Click the confirmation link** the relay emailed to the demo address. Until then the relay gives the
   demo 48 hours (RELAY_PROTOCOL.md § 18).
2. **Send the cezarId to rome** for the rate-limit override (below).
3. Pair a phone yourself with the code, then paste the code into the store consoles
   (`packages/mobile/store/reviewer-notes.md`).

Options: `--code` to choose the code, `--relay-url` for another relay, `--reset` to wipe and reseed,
`--no-build` to reuse the last build. Rerunning `deploy.sh` upgrades cezar and keeps the data.

## What rome needs

No protocol change (version stays 1). Both items are scoped to the demo's `cezarId` only.

1. **Raise `rendezvousPerHour` for the demo cezarId** to at least 40 (it opens about 28 an hour), and do
   not charge those rendezvous to the VPS IP's `newRoomsPerHour` (10). Today both limits are the
   constants in rome's `src/limits.ts`, checked in `src/room.ts` (`rendezvousPerHour`) and
   `src/ip-limiter.ts` (`newRoomsPerHour`). A config var listing demo cezarIds is enough. **Without it
   the code is open only about 20 minutes of each hour**, and a reviewer at the wrong moment sees "code
   not found".
2. **Recommended: reserve the demo's locator.** The code is semi-public (every reviewer sees it). A
   typed code pins no cezar key, so someone holding it could open a `role=cezar` rendezvous on its
   locator between our reopenings and pretend to be the demo, or keep it busy. Ask: a locator opened
   by a demo cezarId may only be opened by that cezarId (409 `pair-taken` for anyone else), for
   example for 24 hours after it last closed. Low harm without it (the data is fake), but it keeps
   the review from failing.

Everything else is unchanged: the demo has its own confirmed account, and the operator's existing
suspension of a cezarId is the kill switch.

## Verify locally (no VPS)

```bash
npm run build:server && npm run build:web
# a local relay: a clone of open-mercato/rome, `pnpm install`, .dev.vars with GRANT_SEAL_KEY and
# ACCOUNT_KEY, `pnpm wrangler d1 migrations apply DB --local`, then:
pnpm wrangler dev --ip 127.0.0.1 --port 8787
packages/mobile/demo/local.sh --relay http://127.0.0.1:8787 --code K7QM-3XNA-9VPD
```

On an Android emulator with a debug CezarBot: `adb reverse tcp:8787 tcp:8787`, then **Enter code**, open
**Advanced**, type `http://127.0.0.1:8787` as the relay, type the code. The cockpit of the demo is at
`http://127.0.0.1:4399` on the Mac. Against the real relay, drop `--relay`; its 10-an-hour limit applies
until rome ships item 1.

## Safety

| Risk | Control |
| --- | --- |
| Reaching your real cezar, data or relay account | Separate VPS, own `CEZ_HOME` and relay identity generated on the box, own relay email. Nothing from your machine is copied except the cezar build |
| GitHub, paid APIs | No `gh`, token, SSH key or model key on the box. Dry run fakes PRs and pushes; agents are the mock |
| Commands from a phone | `CEZ_DEMO` allowlist; check steps never run; no terminal; hosted mode refuses agent-config writes |
| A shell anyway (defence in depth) | Dedicated `nologin` user, `ProtectSystem=strict`, no capabilities, `MemoryMax=1200M`, `TasksMax=512`, `CPUQuota=80%`, egress only DNS and TCP 443 |
| Abuse | Relay limits per cezarId; phones older than `RELAY_KEEP_DAYS` (3) are unpaired at the nightly reset; the relay caps a cezar at 10 phones |
| Bad state | `sudo /opt/cezar-demo/reset.sh` reseeds; `--fresh` also drops the relay identity (new cezarId: tell rome) |

Rotate the code between submissions, never during a review: `deploy.sh root@<vps> --no-build --code <new>`.
Tear down: delete the VPS, delete the demo relay account (`/account/delete` on the relay), and ask rome
to drop the cezarId.

## Files

| File | Runs as | What it does |
| --- | --- | --- |
| `deploy.sh` | you, locally | Build, pack, copy, run `setup.sh` over ssh |
| `setup.sh` | root | Idempotent install, then seed or restart, then the summary |
| `reset.sh [--fresh]` | root, nightly | Unpair old phones, wipe, reseed |
| `seed.sh repos \| tasks \| tick` | `cezar-demo` | Sample repos; projects, tasks and manager through the loopback API; keep a task running |
| `local.sh` | you, locally | The same demo on this machine, from this checkout's build |
| `common.sh` | sourced | Paths, config reader, API helpers |
