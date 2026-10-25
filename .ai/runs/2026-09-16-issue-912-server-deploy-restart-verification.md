# Execution plan — #912: `server-deploy` must fail when the restart failed

Issue: [#912](https://github.com/open-mercato/cezar/issues/912)

## Goal

`cezar server-deploy` must never print "complete — the service was reloaded and verified"
(and must never exit 0) when the systemd restart did not actually happen and the OLD
process is still serving traffic.

## Context (what is broken today)

- `packages/cezar/src/server-install/platforms/ubuntu-vps.ts` → `redeploy()`: a non-zero
  `systemctl --user restart` only produces a `ctx.ui.warn(...)`, and the flow continues.
- The post-restart verification is `confirmCezarRunning()` → `waitForCezar` → `isCezarUp`,
  which is a `curl` to `http://<upstream>:<port>/`. That proves *something* answers the
  port — the old, never-restarted process satisfies it exactly as well as a new one.
- So the reported run prints the real failure (`returned non-zero`,
  `Failed to connect to bus: No medium found`) and then the success banner from
  `packages/cezar/src/index.ts` two lines later, with exit code 0.
- The trap is `systemctl --user` without a D-Bus user session — the natural shape of a
  non-interactive deploy (`sudo -u <svc-user>` from cron/CI/an SSH root script).

The hard-failure plumbing already exists: `runDeploy` (`server-install/engine.ts`) maps a
thrown `StepAborted` to `{ status: 'failed' }`, and `index.ts` maps `failed` to
`process.exitCode = 1` **and** skips the banner. The fix is to use it.

## Scope

- `packages/cezar/src/server-install/platforms/ubuntu-vps.ts` (`redeploy` + new helpers).
- `packages/cezar/src/server-install/platforms/ubuntu-vps.test.ts` (regression tests).
- `docs/server-install/ubuntu-vps.md` (one troubleshooting row for the D-Bus trap).

## Non-goals

- Port allocation and nginx vhost rendering (a concurrent change for #913 owns those).
- Any new `/api/health` field — the health shape is backward-compatibility sensitive
  (`BACKWARD_COMPATIBILITY.md` §2), and the deploy check must work against an old
  cockpit anyway.
- The macOS `launchctl` redeploy path (same warn-only shape, different reproduction;
  kept out so this diff stays reviewable against the reported bug).
- Changing `confirmCezarRunning`'s warn-only behaviour for the install path.

## Implementation plan

### Phase 1 — a failed restart is a failed deploy

1.1 Add `readServiceIdentity(ctx, scope, unit)`: `systemctl [--user] show <unit>
    -p MainPID -p ExecMainStartTimestampMonotonic`, parsed to `{ mainPid, startedAt }`,
    `null` when unreadable or the unit is not running (`MainPID=0`). Add
    `noDbusSessionHint(output)`, which recognises the `Failed to connect to bus` /
    `No medium found` shape (or a missing `XDG_RUNTIME_DIR`) and returns the concrete
    "run it with a real user session" instruction.

1.2 Capture (instead of fire-and-forget) `systemctl --user daemon-reload` and
    `systemctl --user restart`; a non-zero restart exit throws `StepAborted` carrying the
    command's own output plus the hint. Nothing downstream runs, so the banner is never
    printed and the CLI exits 1.

1.3 Read the service identity **before** the restart and again after; when both are
    readable and identical (same PID *and* same start timestamp), throw `StepAborted` —
    "the old process is still serving". Unreadable identity degrades to the previous
    behaviour (never invents a failure). Applies to both the `user` and `system` scope.

### Phase 2 — regression tests

2.1 Tests in `ubuntu-vps.test.ts`: (a) non-zero restart → `StepAborted`, no success path,
    D-Bus hint present when the bus error is in the output; (b) restart exits 0 but the
    identity is unchanged while the port answers → `StepAborted`; (c) a real restart
    (identity changed, port answers) still succeeds; (d) unreadable identity degrades
    instead of failing; (e) dry-run still returns early.

2.2 Prove each regression test is red without the source fix (`git stash push -- <source>`,
    run, confirm red, restore) per `AGENTS.md`.

### Phase 3 — docs and the gate

3.1 Add the D-Bus/`XDG_RUNTIME_DIR` row to `docs/server-install/ubuntu-vps.md`
    Troubleshooting, and state that a failed restart now fails the deploy.

3.2 Run the full validation gate (`npm run typecheck`, `npm test`, `npm run test:unit`,
    `npm run build`, `npm run test:package`).

## Risks

- **Switching the restart from `interactive` to `capture`** stops streaming systemctl's
  output live. Mitigated by echoing the captured output in the failure message — and
  `systemctl restart` prints nothing on success.
- **A false "did not restart" abort** would block a working deploy. Mitigated by
  requiring *both* the PID and the monotonic start timestamp to be unchanged, and by
  treating any unreadable identity as "cannot tell — do not fail".

## Progress

PR: #1009

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: A failed restart is a failed deploy

- [x] 1.1 Add the service-identity reader and the D-Bus-session hint — 5cc6edde
- [x] 1.2 Treat a non-zero `systemctl --user restart` as a hard failure — 5cc6edde
- [x] 1.3 Abort when the process did not actually change — 5cc6edde

### Phase 2: Regression tests

- [x] 2.1 Cover failed restart, stale process, success, degraded identity and dry-run — 5cc6edde
- [x] 2.2 Prove the new tests fail without the fix — 5cc6edde

### Phase 3: Docs and the gate

- [x] 3.1 Document the D-Bus trap in the ubuntu-vps troubleshooting table — 5cc6edde
- [x] 3.2 Run the full validation gate — all five commands green
- [x] Post-review fix: cover the sudo/system scope's did-it-really-restart proof, and name the `outputTail` line variable
