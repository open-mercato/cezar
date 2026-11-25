# Manager agent chain: backup agents for the Manager

Approved design: `manager-agent-routing-design.html` / `.md`, Part 1, variant 1C (task 23700640,
2026-11-25). Decisions: chain of #1 plus up to 3 backups; back to #1 when it is available; the chain
serves every turn (chat, follow-ups, watch checks, jobs).

## Model

`Manager.runner`/`agentProfile`/`model`/`effort` stay row #1. `backups` (≤ 3 of `{runner,
agentProfile?, model?, effort?}`) are rows #2–#4; `failback` is `available` (absent) or `manual`. No
two rows share a runner and account (`400`). A manager with no `backups` is exactly today's manager:
`hasChain` is false and no chain code runs, no `agent` field is written, no hold is shared.

State (`~/.cezar/managers/<id>/state.json`): `chain.active` (`{slot, reason, since}`, absent = #1)
and `chain.holds` (`runner|account` → `{until, reason, streak?, accountKey?}`), plus `parkedSessions`
(each row's transcripts by session key, at most 4).

## When it switches

`driveChain` (engine) wraps `drive`. Before a turn, `chainPlan` picks the first open row from the
preferred one (#1 with `available`, the active row with `manual`). A row is closed by its own hold or
by a workspace hold on its account (`accountLimit`, a task hit the limit). After a turn, a failure
another account can get around (`failoverReason`: usage limit, auth, billing, missing CLI) records a
hold and hands the SAME turn to the next open row; busy servers, network, session, stops and the
30-minute limit never switch. A turn tries each row at most once. Holds: a usage limit until its
reset (1 h when the provider named none); the others 15 minutes, then 1 h. Every row out: today's
`armResume` at the earliest reset (only for usage limits, and only with auto-resume on).

A reply cut off after it acted stays (`cutOff: true`); the backup's prompt starts with the commands
that already ran (`cutOffNote`). An echoed limit or login line is dropped instead.

## Going back

With `available`, every turn starts from #1, so the first turn after #1's hold ends goes back (a
`back` notice). A reconnect of a row's login releases its `auth` hold. `PATCH {switchToPrimary:
true}` (Switch back now) clears every hold and posts a `manual` notice. Editing any row or the
failback choice clears `chain.active` and the non-limit holds. Each row's transcript is parked under
its session key, so #1's resumes when `resumes()` still allows it.

## Shared limits

A usage-limit hold carries the queue's account key (`runner:account`); `ManagerEngine.accountHolds()`
publishes them through a semaphore participant registered in `server.ts`, and a timer at the hold's
end wakes the queues. Only managers with backups publish.

## What the user sees

- `notice.agentSwitch` (`from`, `to`, `reason`, `until?`, `lost?`, `reconnect?`), with `text` for
  older cockpits.
- `assistant.agent` (`{slot, runner, profileId, label?, model?}`) on every reply of a chain manager;
  the cockpit labels only slot > 0 (`#2 · codex Work`).
- `ManagerSummary.activeAgent` while a backup answers: the (i) next to the name and its popover.
- Settings → Manager agent: the chain list, the row editor (desktop inline, phone pushed), drag or
  Move up / Make primary, "After a switch, go back to #1", "Switch back to #1 now".

## Cost

Backups serve watch checks and jobs too, so an unattended turn may run on a backup account the user
added (AGENTS.md § Zero config). Nothing happens until the user adds a backup.
