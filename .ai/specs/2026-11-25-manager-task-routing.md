# Manager new-task routing: Main and Backup accounts

Approved design: `manager-agent-routing-design.html` / `.md`, Part 2 (task 23700640, 2026-11-25).
Decisions: a list with roles (Main / Backup), no reserve; Backup when every Main is out of limits
(default) or also busy; a task out of limits mid-way finishes on another listed account (default),
the same agent only, or waits; a queued task moves to an account that frees up.

## Model

- `taskAgents[].role` — `main` | `backup`. Absent on EVERY entry = the original order (the manager's
  own runner, then list order, first with capacity): existing managers are unchanged. The cockpit
  writes a role on every row as soon as the user sets one (new rows default to Main).
- `taskBusyAt` — with roles, an account running this many tasks is busy ("Out of limits or busy").
  Absent = "Out of limits": busy never sends work to Backup.
- `taskLimitSwitch` — `any` (absent) | `same-agent` | `wait`.
- `POST /runs` `managerAgent.routed` (manager token only) marks a task the roles placed; it rides the
  run's `fallbackPolicy.routed`. `queueWaitReason` gained `account-busy`.

These are flat on purpose: the manager summary rides every manager route, and the typed API
(`AppType`) sits at the compiler's declaration-length limit (TS7056).

## How a new task picks its account

`chooseTaskAgent` with `roles`: filter as before (`--account` wins, `--runner` narrows, held, removed
and unlisted accounts drop out); then the open Main with the fewest running tasks (ties: lower fresh
five-hour usage %, `fiveHourUsedPercent`, then list order); else the first open Backup; else, if
something is only busy, the least-loaded account with `busy: true` (the task waits); else, everything
held, the first to reset (as before). "Running" is `WorkspaceSemaphore.accountLoad()`: runs in
status `running`, not parked, across the workspace. A retry keeps its own Main account while open.

## Queued tasks

`RunManager.routeQueuedManagerTasks`, at each pump: a routed queued task whose account is held or
busy moves (the #2462 queued switch) to the open Main with the fewest running, else the first open
Backup, with a "Routed to …" note; with none open it waits as `account-busy` until a slot frees (a
finished task's `release()` pumps again). A task out of limits keeps its usage hold. An explicit
`--account` is never routed.

## Mid-way

The live manager lookup (`setManagerTaskAccountsLookup`) now returns `{ agents, limitSwitch,
maxRunning }`. `eligibleFallbackCandidates` skips every candidate under `wait` (the reset-time
auto-resume applies), other runners under `same-agent`, and with roles orders Main by load, then
Backup, busy last (never refused). New tasks also snapshot the setting (`wait` records an empty list).
