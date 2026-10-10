# Run: instance port allocation must be machine-wide (#913)

- Issue: [#913](https://github.com/open-mercato/cezar/issues/913) — a second unix user's
  `server-install` writes `proxy_pass http://127.0.0.1:4321` at the **first** user's cezar.
- Engine: om-auto-create-pr (steps: 7, --loop: no)
- Base: `main`

## 🎯 Goal

An instance's nginx `proxy_pass`, its systemd unit's `--port`, its recorded `primaryPort`
and the port its service can actually bind are the same number — on a host where another
unix user already runs a cezar. Today they are not, and the gap silently proxies one user
into another user's cockpit, run history and coding-agent subscription.

## Root cause (confirmed in source, `origin/main` @ 0e9dfd76)

`nextFreeInstancePort()` (`packages/cezar/src/server-install/state.ts`) derives "already
used" from `listServerInstances()`, which reads the **invoking user's**
`~/.cezar/server-instances/`. The resource it allocates — a loopback port — is
**machine-wide**. A second unix user has an empty registry, so the scan starts and stops at
4321 even though the first user's cezar is bound there.

That 4321 becomes `state.primaryPort`, and everything downstream renders from it faithfully:
the vhost (`ubuntu-vps.ts` lines 328 and 485) and the systemd unit's `--port` (lines 764,
799) agree with each other and with the printed plan. The *service* is the one that
disagrees: `serve` falls back to `pickPort()`, finds 4321 busy and drifts to 4322. From then
on nginx forwards an authenticated second user into the first user's process.

So the defect is entirely upstream of rendering. Fixing the allocator fixes the vhost, the
unit, the recorded state and the printed plan in one place — and also removes the
boot-race the reporter documented in the issue's follow-up comment (two units both carrying
`--port 4321` race for the socket on every reboot, so the cross-wiring can flip direction).

## Scope

- `packages/cezar/src/server-install/state.ts` — bind-probe allocation, conflict reporting.
- `packages/cezar/src/server-install/engine.ts` — refuse a port this install cannot own.
- `packages/cezar/src/index.ts` — the one auto-pick call site (now `await`ed) so the port the
  wizard **prints** is the port it allocated.
- Tests for the above.

### Non-goals

- Making the installed **service** fail rather than auto-increment (issue item 3). That lives
  in `serveCommand`/`pickPort`, the interactive-cezar path, and is deliberately left alone —
  with allocation fixed, no two instances are handed the same port to race for. Follow-up.
- Giving the verification gate an **instance-identity** check (issue item 4). Real and
  valuable — it is what makes this class of misconfiguration loud rather than green — but it
  is a separate behavioural change to the verify step. Follow-up.
- The `http2` directive work in flight on PR #994, which touches the same file.
- `--external-proxy` and `macosx-ngrok` specifics, per the issue's own out-of-scope list.

## Design

1. **The socket is the authority.** `nextFreeInstancePort()` keeps the recorded-state scan as
   a cheap first filter and adds a real bind probe (listen on 127.0.0.1:port, release it) as
   the deciding test. The probe is injectable so the unit tests stay deterministic, with one
   test exercising the real socket so the default cannot rot.
2. **Bounded, and loud when exhausted.** The scan has a window; running out throws a message
   naming the range and `--port` rather than returning a port it could not verify.
3. **Refuse a port this install cannot own.** A first-time `runInstall` checks the resolved
   `primaryPort` before any step renders anything, and stops with a `PreflightError` naming
   the port, the reason, and how to see who holds it. Resumes and reinstalls skip the check —
   there, the port is held by this instance's own service.
4. **Allocate once, then render.** The call site awaits the allocation before printing it, so
   the printed plan, the recorded state, the unit and the vhost are all one number.

## Risks

- A fresh `server-install` on a box where an interactive `cezar` already holds 4321 now
  *refuses* instead of proceeding. That is the intended behaviour change: proceeding is what
  writes a `proxy_pass` at a process the install does not own. The error names the port and
  `--port`.
- The probe adds a socket bind per candidate port. Bounded, loopback-only, released
  immediately.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #1003

### Phase 1: Machine-wide port allocation

- [x] 1.1 Add an injectable loopback bind probe and make `nextFreeInstancePort` use it as the authority — 4e769d5a
- [x] 1.2 Report a port conflict (recorded-by-another-instance vs held-by-a-foreign-process) instead of silently stepping over it — 4e769d5a

### Phase 2: Refuse a port the installer cannot own

- [x] 2.1 `runInstall` stops a first-time install whose `primaryPort` is not bindable, before anything is rendered — 6bb733ca
- [x] 2.2 Await the allocation at the CLI auto-pick site so the printed port is the allocated port — 6bb733ca

### Phase 3: Regression tests

- [x] 3.1 `state.test.ts`: allocation skips a bound-but-unrecorded port, refuses an exhausted window, and the real probe agrees with a real socket — 4e769d5a
- [x] 3.2 `strategies.test.ts`: two instances on one host — the second's vhost, unit and state all carry its own port and never the first's — 5292cb5b

### Phase 4: Gate

- [x] 4.1 Full validation gate, review pass, PR
- [x] Post-review fix: the port check runs after `strategy.preflight()`, so a wrong-OS refusal is not reported as a port clash — 322dec5c

## Gate evidence

Run with the documented cezar-task workaround (`TMPDIR`/`TMP` outside the repo, exported
`CEZ_*` unset) — without it ~9–13 tests fail on any branch including clean `origin/main`.

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ clean (contract, api-client, server, web) |
| `npm test` | ✅ 390 files / 7181 tests |
| `npm run test:unit` | ✅ 36/36 |
| `npm run build` | ✅ `check:pack ok — 530 files` |
| `npm run test:package` | ✅ 16/16 |

The regression tests were confirmed **red without the fix**: reverting
`nextFreeInstancePort` to the recorded-state-only scan fails
`a second instance's vhost never points at the first instance's port`
(`expected 43549 not to be 43549`) and both allocator cases.
