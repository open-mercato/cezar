# Automations — scheduled triggers, the redesigned surface, and creation from a prompt

> Slug: `automations-redesign` · Status: **designed, awaiting implementation** · Source design:
> `assets/automations-redesign/` (Claude Design export "cezar Automations", 2026-09-14).
> Extends `2026-07-25-github-automations.md` (the shipped feature, amended by #801) and absorbs
> the pending "automations from a prompt" patch (`2026-09-13-automations-from-prompt.md`), which
> lands on top of this work as its last phase. Delivery: one PR to `main`.

## 📝 TLDR

A user who wants cezar to do recurring work today can only react to GitHub events (PR opened,
issue opened, label changed) through a plain list/editor/log that is off unless
`CEZ_AUTOMATIONS=1`. The proposed behaviour adds a second trigger kind — **a schedule** (every
day, weekdays, weekly on a day, every N hours, in the cockpit's local time zone) — turns the
feature **on by default**, and rebuilds the Automations surface to the design: a list with
this-week stats and next/last run, a Week and a Day calendar of upcoming runs, a "Next runs"
rail, an editor that can start from a template (built-in, or one of your other projects'
automations), previews the next five runs, carries per-automation dispatch settings and a
"Copy as CLI" card, and an execution log that shows cost and dispatched child tasks. Every run
stays an ordinary cezar task in its own worktree, queued behind the parallel cap, never
auto-merged. The "create an automation from a prompt" patch (built-in skill, `cez automation`
CLI, system-prompt part) lands last, re-pointed at the extended definition and given a flag
form beside its JSON form.

## Resolved decisions (gate answers, 2026-09-14)

| # | Question | Decision |
|---|---|---|
| Q1 | CLI shape | **JSON + flag sugar.** `cez automation create --file|--json|stdin` stays the transport; `cez automation add --name … --cron|--on … --prompt …` builds the same body. "Copy as CLI" prints the flag form when the definition is expressible in flags, the JSON form otherwise. |
| Q2 | Where definitions live | **Keep the gitignored store** (`.ai/cezar/automations.json`, revision-checked). The card's copy no longer promises a committable file. |
| Q3 | Budget per run | **Dropped.** No budget field in the editor, no budget in the list's "Runs as" cell. |
| Q4 | Dispatch per automation | **Dispatch on/off + up to N subtasks → `dispatch.intent.maxSubtasks`; "review child" is a prompt-level instruction**, no contract change. |
| Q5 | Delivery | **One spec, one PR.** Phases below structure the work and the review, not the PRs. |
| Q6 | New GitHub events (`pull_request.review_requested`, `release.published`) | **Deferred.** Event chips show the four events the poller reconstructs. |
| Q7 | Templates "From your other projects" | **Included.** A workspace-level read-only endpoint lists other registered projects' automations. |
| Q8 | Gating | **Default-on.** `capabilities.automations = CEZ_AUTOMATIONS !== '0'`. Breaking per `BACKWARD_COMPATIBILITY.md`; takes the deprecation path (README + CHANGELOG + minor bump called out as breaking). |
| Q9 | Time zone for schedules | Applied default: **server's local zone**, shown in the editor and the header; the structured schedule is stored, the cron string is derived. |
| Q10 | Run now while paused | Applied default: **allowed** — a manual launch that does not enable the automation; the log records it as `manual`. |

## 📝 Problem Statement

- **Recurring work has no trigger.** "Bump deps nightly", "sweep failed CI every weekday
  morning", "draft the changelog on Friday" are the automations people ask for first, and the
  shipped spec lists time triggers as a non-goal. Users fall back to cron + `cezar run`, which
  bypasses the cockpit's log, receipts, dedupe and review gate.
- **The feature is invisible.** Since #801 it is off unless an operator sets a variable, so
  almost nobody has seen it, and a repo with no GitHub remote cannot use it at all even for work
  that never touches GitHub.
- **The shipped page is a placeholder.** `packages/web/src/routes/automations/automations.tsx`
  is ~200 lines: cards with four buttons, an editor that hard-codes `issue.opened` every 5 min,
  a log with no cost and no task context, no design-system primitives beyond `Button`/`Input`.
- **Nothing says what an automation costs or when it fires next.** The list exposes
  match/launch/duplicate/error counts only; there is no money, no agent time, no calendar.

## 📝 Proposed Solution

1. **Two trigger kinds on one definition.** `kind: 'github' | 'schedule'`. GitHub keeps the
   shipped poller, cursors, receipts and baseline semantics untouched. Schedule is a new
   evaluator in the existing workspace timer: the next occurrence of a structured schedule in
   the server's zone, one durable receipt per occurrence (so a crash never launches twice), and an
   age rule that fires at most ONE missed occurrence — after a restart, a sleep, or any gap —
   and skips the rest.
2. **Default-on.** The nav item, the routes and the scheduler are on unless `CEZ_AUTOMATIONS=0`.
   GitHub-kind triggers still degrade on forge availability; schedule-kind triggers need no
   forge, so a repo without a GitHub remote gets the page and the schedule kind only.
3. **Surface rebuilt to the design**, pixel-matched against the export (§ UI/UX carries the
   normative values), composed from named primitives (§ Primitives) that either exist in
   `packages/web/src/components` or are promoted there once from today's inline spellings.
4. **Stats derived, not stored.** Runs / spent / failed / agent time and per-automation runs 7d /
   cost 7d come from run records linked by provenance (`RunRecord.automation` for GitHub
   launches, the new optional `automationTrigger` for schedule launches: `costUsd`, `startedAt`,
   `finishedAt`) plus the execution log; no new counters.
5. **Templates.** Built-in automation templates ship in code; the palette's second tab lists
   automations from the user's other registered projects through one read-only workspace route.
6. **Prompt-driven creation last.** The pending patch's CLI, built-in skill and system-prompt
   part are applied and adapted: the schema reference names `kind`/`schedule`, the skill's
   playbook knows both kinds, and `cez automation add` is added as flag sugar.

Alternatives considered: a cron library (full cron expressions) — rejected, four bounded shapes
cover the design, keep occurrence math testable without a dependency, and a cron string is still
derived for display and for the CLI; a separate scheduler process — rejected (no daemon, the
existing timer already owns due-time math); storing stats — rejected (derivable, and a
persisted counter drifts from the runs it counts).

## 📝 Architecture

```mermaid
flowchart LR
  subgraph server[packages/cezar]
    WS[WorkspaceAutomationScheduler<br/>existing timer] --> PS[ProjectAutomationScheduler<br/>existing: github check]
    WS --> SS[schedule-runner.ts<br/>NEW: occurrence → receipt → launch]
    PS --> GP[github-poller.ts existing]
    SS --> TT[task-template.ts<br/>changed: renderScheduleTask, dispatch intent]
    PS --> TT
    TT --> RM[RunManager.startRun existing]
    ST[(automations.json<br/>automation-state.json<br/>receipts / log)] --- PS
    ST --- SS
    API[server.ts automations family<br/>changed: kind-aware, +run, +stats, +templates] --> ST
    API --> RS[(runs.json)]
  end
  subgraph contract[packages/contract]
    C1[automations.ts changed: kind, schedule, task.dispatch]
    C2[automation-schedule.ts NEW: pure occurrence math]
  end
  subgraph web[packages/web]
    P[primitives: Chip, Segmented, Kbd, BranchChip NEW<br/>Pill, StatusDot, Button, Card, Sheet… existing]
    R[routes/automations/* NEW screens]
    R --> C2
    R --> P
  end
  CLI[automation-cli.ts (patch) + add sugar] --> API
```

Takeaway: the only new server mechanism is the schedule evaluator; everything else extends
existing modules or is UI composed from primitives.

### Modules

| Path | Status | Change |
|---|---|---|
| `packages/contract/src/automations.ts` | changed | `kind`, `schedule`, `task.dispatch`, new log results, `timeZone` + `stats` on the list response, run response, templates response. Every addition optional or defaulted. |
| `packages/contract/src/automation-schedule.ts` | new | Pure functions shared by server and cockpit: `nextOccurrence`, `occurrencesBetween`, `cronOf`, `scheduleLabel`, `normalizeSchedule`. `Intl`-based zoned wall-time math, DST-safe (see Edge cases). |
| `packages/cezar/src/automations/types.ts` | changed | Storage schema: `kind` (default `'github'` so every existing file parses unchanged), `schedule` (required when `kind === 'schedule'`), `events` optional for schedule kind (superRefine), `task.dispatch`. New log results `manual`, `catch-up`, `skipped`, `failed`. |
| `packages/cezar/src/automations/schedule-runner.ts` | new | `ScheduleRunner.due(definition, state, now)` and `ScheduleRunner.fire(definition, occurrence, reason)`: reserve receipt (`eventId = schedule:<occurrenceIso>` or `manual:<nowIso>`), launch through `task-template`, record log, set `nextRunAt`. |
| `packages/cezar/src/automations/scheduler.ts` | changed | `ProjectAutomationHandle` gets an optional `github?: { owner, repo, poller }` sub-object (today `owner/repo/poller` are required, so a project without a GitHub remote gets NO handle — `server.ts` `handle()` returns `undefined` and `schedule()` skips it). `WorkspaceAutomationScheduler.schedule()` gathers due items of BOTH kinds (`nextCheckAt` for github, `nextRunAt` for schedule), skips github items when `handle.github` is absent, and dispatches to the right runner. Stale-item rule (Lifecycle §3/5) applies on every arm, not only at boot. |
| `packages/cezar/src/automations/store.ts` | changed | `setState` becomes read-modify-write (re-read the file, merge this id, atomic write — the `mergeWriteWorkspaceConfig` pattern) so two cockpits on one project converge instead of the last writer clobbering the other's `nextRunAt`/cursor. |
| `packages/cezar/src/automations/task-template.ts` | changed | `renderScheduleTask` (placeholders `{{date}}`, `{{time}}`, `{{project}}`, `{{automation}}`), `dispatchIntentOf(task)`, review-child prompt suffix, schedule/manual provenance under the NEW optional `RunRecord.automationTrigger` (§ Data Model); `reconcileAutomationReceipts` reads both `automation` and `automationTrigger`. |
| `packages/cezar/src/automations/stats.ts` | new | `automationStats(definitions, logs, runs, now, tz)` → week strip + per-automation 7d tallies. Pure, tested with fixtures. |
| `packages/cezar/src/automations/templates.ts` | new | Reads other registered projects' definitions read-only through `AutomationCoordinator` for the palette's second tab. |
| `packages/contract/src/zoned-time.ts` | new (moved) | `zonedParts`, `zonedWallTimeToUtc` — today private functions in `core/usage-limit.ts:173,200` — move into the contract package (Node-free, `Intl` only) so the schedule math and the usage-limit resume share one implementation; `usage-limit.ts` imports them from there. |
| `packages/cezar/src/server/capabilities.ts` | changed | `automations: env.CEZ_AUTOMATIONS !== '0'`. |
| `packages/cezar/src/server/server.ts` | changed | `automationProjects` (`:5626`) and the boot warm-up (`:5695`) register EVERY registered project (root always; `github` only when the remote parses as github.com); kind-aware create/update validation; `POST /automations/:id/run`; kind-aware retry; list response gains `timeZone`, `stats`, per-entry `runs7d`/`costUsd7d`/`nextRunAt`/`lastRun`; log response gains `runs` map; `GET /workspace/automation-templates`; default-on re-baseline at boot (Lifecycle § Default-on). |
| `packages/cezar/src/automations/automation-cli.ts` (patch) | changed on apply | `add` subcommand (flag sugar) building the same body; `schema` reference covers both kinds. |
| `packages/cezar/src/automations/prompts.ts`, `builtin-skill.ts` (patch) | changed on apply | Playbook knows schedules; the system-prompt part recognises "every day at …", "on weekdays …". |
| `packages/web/src/components/{chip,segmented,kbd,branch-chip}.tsx` | new | Promoted primitives (§ Primitives). `ui/switch.tsx` gains `size="sm"`; `ui/card.tsx` gains `flush`. |
| `packages/web/src/routes/automations/*` | rewritten | One file per screen-level component (§ UI/UX). |
| `packages/web/src/lib/automation-templates.ts` | new | The six built-in templates (from the design's `data.js`). |
| `packages/web/src/components/nav-items.ts` | changed | Automations item gated on `capabilities.automations` only (forge no longer required). |
| `packages/web/src/api/client.ts` | changed | `runAutomationNow`, `deleteAutomation` (exists server-side, unused by the cockpit today), `getAutomationTemplates`. |

### Lifecycle additions (schedule kind)

1. `reschedule()` (existing) refreshes the coordinator and calls `schedule()`.
2. `schedule()` collects, per enabled definition: github → `state.nextCheckAt` (existing);
   schedule → `state.nextRunAt`, or `nextOccurrence(schedule, now, tz)` when absent (first
   enable, or an edit that changed the schedule — the PUT handler clears `nextRunAt` when the
   schedule differs).
3. At due time for a schedule item, `ScheduleRunner.fire(definition, occurrence, now)` under
   the existing project lease. The occurrence's AGE decides the reason — the same rule whether
   the timer fired on time, the laptop slept, or cezar just booted:
   - `now − occurrence ≤ 10 min` → `scheduled`;
   - `≤ 24 h` → `catch-up`, fired once for the LATEST missed occurrence only;
   - older → not fired; log `skipped` "missed N occurrences while cezar was not running".
   Then reserve the receipt keyed `${automationId}:schedule:${occurrenceIso}` (a second process
   hits the receipt and logs `duplicate`), launch, log the reason with `runId`, and set
   `nextRunAt = nextOccurrence(schedule, max(occurrence, now), tz)`, `lastRunAt = occurrence`,
   `lastSuccessAt = now`. Advancing from `max(occurrence, now)` is what makes a burst impossible:
   a daily that slept three days fires one catch-up, not three; an hourly, one, not seventy-two.
4. Launch failure: receipt `launch-error`, log `failed` with the reason, `nextRunAt` still
   advances (a broken workflow must not fire every second), `consecutiveFailures++`; after 3
   consecutive launch failures the automation is auto-paused with a log row `failed` "paused
   after 3 consecutive launch failures" and an `automation-change` event. A held lease
   (another cockpit is polling) and a `duplicate` receipt are NOT failures: the loser advances
   its own `nextRunAt` to the next occurrence and does not count.
5. Restart: nothing special — step 3's age rule covers it. The first `schedule()` after boot sees
   past-due items and applies catch-up/skipped exactly as a sleeping process would.
6. `POST /automations/:id/run` (schedule kind): `fire(definition, now, now, 'manual')`
   immediately, outside the timer, same lease, receipt keyed `manual:<nowIso>`; answers
   `202 {runId}`. Allowed while paused (Q10); never changes `enabled` or `nextRunAt`.

GitHub kind lifecycle is unchanged (spec 2026-07-25 § Lifecycle) except for one boot rule that
the default flip needs:

**Default-on re-baseline.** A store may hold github definitions with `enabled: true` from a
time the operator had `CEZ_AUTOMATIONS=1`, later unset the flag, and forgot them. With the
default flipped they would resume from a stale cursor and could launch up to `maxRecords` tasks
each with no user action — the "diff the default path" failure AGENTS.md warns about. So at boot,
before the timer arms, every enabled github definition whose `lastSuccessAt` is absent or older
than its `filters.lookbackDays` is re-baselined (`baselineAt = cursor = now`) with a log row
`baseline` "re-baselined after N days idle; the backlog is not launched" and an
`automation-change` event. Definitions polled recently continue as before.

## 📝 Data Model

### `automations.json` — definition (v1 file, additive fields)

```ts
type AutomationDefinition = {
  id: string; revision: number; name: string; description?: string
  enabled: boolean                      // default false (unchanged)
  kind: 'github' | 'schedule'           // NEW, storage default 'github' → old files parse as before
  // github kind (unchanged; required when kind === 'github')
  events?: AutomationEvent[]            // was required; now required only for github
  intervalSeconds?: number              // idem
  filters?: AutomationFilters           // idem
  // schedule kind (required when kind === 'schedule')
  schedule?: {
    type: 'daily' | 'weekdays' | 'weekly' | 'hours'
    hour?: number                       // 0–23, daily/weekdays/weekly (default 4)
    minute?: number                     // 0–59, idem (default 0)
    day?: 1 | 2 | 3 | 4 | 5 | 6 | 7     // weekly: Monday = 1 … Sunday = 7
    every?: 1 | 2 | 3 | 4 | 6 | 8 | 12  // hours: at 00:00 + k·every
  }
  task: AutomationTask & {
    dispatch?: { maxSubtasks?: number; reviewChild?: boolean }   // NEW, optional — the automation's own
  }                                                              // setting; `dispatchIntent` is untouched (Q4)
  createdAt: string; updatedAt: string
}
```

Validation (storage `superRefine`, mirrored in the route schema): `kind === 'github'` requires
`events` (1–4), `intervalSeconds`, `filters` (defaults fill), and the existing `changedLabels`
rule; `kind === 'schedule'` requires `schedule` and forbids `events`/`filters` (400 "a scheduled
automation has no GitHub filter"). `schedule.type` decides which keys are read; unknown keys
survive (`.passthrough()`). `task.dispatch.maxSubtasks` is bounded by
`DISPATCH_MAX_SUBTASKS`. `task.dispatch` is stored as given and **ignored, never refused, when
`capabilities.dispatch` is off** — the precedent `POST /runs` sets (`server.ts:3628` drops the
composer's `dispatch` silently; BC §2 "the field is dropped and the run still starts"), so a
template copied from another project still saves on a dispatch-off cockpit and its runs launch
plain. `task.dispatch.reviewChild` maps to a prompt suffix at fire time (Q4): the definition
records the user's choice; the dispatch intent contract gains no field.

The derived `cron` string is never stored: `cronOf(schedule)` computes it (`M H * * *`,
`M H * * 1-5`, `0 */N * * *`, `M H * * D` with cron's Sunday = 0).

### `automation-state.json` — runtime state (additive)

```ts
type AutomationRuntimeState = {
  …existing…
  nextRunAt?: string       // schedule kind: the next occurrence's instant (UTC ISO)
  lastRunAt?: string       // schedule kind: the last fired occurrence's instant
}
```

`nextCheckAt` stays the GitHub kind's key; the list response maps both onto one `nextRunAt`.

### Receipts

Unchanged shape. Schedule occurrences use `eventId = schedule:<occurrenceIso>` / `manual:<iso>`
and carry no `candidate`. `receiptKey` stays `${automationId}:${eventId}`, so the 90-day
retention and compaction rules apply as they are.

### Execution log (additive results)

`result` gains `manual` (a Run now launch), `catch-up` (a missed occurrence fired once after
boot), `skipped` (nothing to do: missed occurrences discarded, or a schedule fired while the
project's run queue refused), `failed` (a launch that threw). `githubNumber/Title/Url` stay
optional and absent on schedule rows.

### Run provenance (`RunRecord.automationTrigger`, new optional key)

`RunRecord.automation` is **not** loosened: its `githubUrl` stays `z.string().url()` because
`runs/store.ts:703` parses the WHOLE index with one `safeParse` — a downgraded cezar reading one
record without `githubUrl` would drop every run and re-save an empty index. Schedule and manual
launches instead carry a new optional key that an older schema strips silently:

```ts
automationTrigger?: {
  automationId: string; automationRevision: number; receiptId: string
  trigger: 'schedule' | 'catch-up' | 'manual'
  occurrenceAt: string        // the scheduled wall-time instant (UTC ISO); `manual` = launch time
}
```

`reconcileAutomationReceipts`, the "from automation" badge and the log's `runs` map read both
keys. GitHub launches keep writing `automation` exactly as today.

### Sensitive data

Definitions can contain free prompts about people (unchanged, local `0600`). The new
cross-project templates route reads other projects' definitions from the same user's home
registry only; it answers over the loopback server like every automations route, never leaves
the machine, and is gated by `capabilities.automations`.

## 📝 API Contracts

All routes stay under the automations family (`/api/v1/p/:projectId/…` plus the boot-project
spellings), behind the origin guard and the automations gate (now default-on).

- `GET /automations` → `{ available, reason?, scheduler: { state, nextDue? }, timeZone, stats,
  automations[] }`.
  - `timeZone`: `Intl.DateTimeFormat().resolvedOptions().timeZone` of the server.
  - `stats` (this calendar week, Monday 00:00 in `timeZone` → now): `{ runs, failed,
    agentSeconds, costUsd? }`; `costUsd` absent when `capabilities.costMetrics` is off.
  - each entry: `…definition, state?, latestLog?, counts` (existing) + `nextRunAt?`
    (schedule → `state.nextRunAt`; github → `state.nextCheckAt` when enabled), `lastRun?:
    { runId, status, ts, costUsd? }` (the newest `launched|manual|catch-up|failed` row joined
    with its run), `runs7d` (launched rows in the last 7 × 24 h), `costUsd7d?`.
- `POST /automations`, `PUT /automations/:id` — body gains `kind`, `schedule`, `task.dispatch`;
  the kind rules above; `PUT` clears `nextRunAt` when `schedule` changed so the timer recomputes.
  A `POST` without `kind` is github; a `PUT` without `kind` inherits the stored kind (so an
  old-shaped client editing a schedule automation is not read as a kind switch).
- `POST /automations/:id/enable` — github: baseline as today; schedule: sets
  `nextRunAt = nextOccurrence(now)`, no baseline. `pause` unchanged.
- `POST /automations/:id/run` — **new**, schedule kind only → `202 { runId }`; `409 { error }`
  for a github automation ("use check with mode execute"), when the project lease is held, or
  when the run queue refuses. Allowed while paused.
- `POST /automations/:id/check` — github kind only; `409` for schedule ("a schedule has nothing
  to preview; use run").
- `GET /automation-log?…` → `{ records, runs }` where `runs: Record<runId, { title, status,
  costUsd?, children: Array<{ runId, kind, title, status, costUsd? }> }>` for every `runId` in
  `records` (children = runs whose `dispatch.rootRunId === runId`, excluding the root). Capped by
  the existing 100-row read.
- `POST /automation-log/:receiptId/retry` — kind-aware: a schedule receipt in `launch-error`
  (no `candidate`) retries by firing that occurrence again as `manual` under the same receipt;
  the existing "predates retry context" 409 stays for github receipts without a candidate.
- `GET /api/v1/workspace/automation-templates` — **new, workspace-level** (the
  `/workspace/*` family, like `/workspace/agent-profiles`; `/automation-checks` is project-scoped
  and is not the precedent), with its own automations gate: `{ templates: Array<{ project: { id,
  name }, id, name, kind, schedule?, events?, intervalSeconds?, task: { prompt, workflow?,
  runner?, model?, autonomous?, dispatch? } }> }` from every registered project's definitions
  except `?exclude=<projectId>`. Read-only; a missing or unreadable project store is skipped,
  never an error.
- `DELETE /automations/:id` unchanged (now called by the cockpit).
- Health: `capabilities.automations` semantics flip to default-on (see Risks).
- Workspace SSE `automation-change` unchanged; additionally emitted after `run`.
- Both new routes are added to `BACKWARD_COMPATIBILITY.md` §2 and to
  `bc-route-inventory.test.ts`, which fails on an undocumented route.

### CLI (`cez automation`, from the patch, plus)

```
cez automation add --name <name> (--cron "<M H * * *|M H * * 1-5|0 */N * * *|M H * * D>" | --on <event>[,<event>] --every <5m|1h|…>)
                   [--prompt "<text>" | --prompt-file <path>] [--workflow <name>] [--runner claude|codex|opencode]
                   [--model <model>] [--autonomous|--no-autonomous] [--dispatch [--max-subtasks N] [--review-child]]
                   [--label <l>]… [--author <a>]… [--enable]
```

`--cron` accepts only the four shapes (`cronOf` inverse); anything else exits 2 naming them.
`add` builds the JSON body and calls the same `create`. `schema` prints both kinds. Exit codes
as in the patch (0 / 1 refused / 2 usage or no cockpit).

## 📝 UI/UX

Route map unchanged: `/automations`, `/automations/new`, `/automations/:id`,
`/automations/:id/log`. The list's view mode (`list | week | day`) is a `?view=` search param so
a reload keeps it. Every screen is a composition of the primitives in § Primitives; the
values below are normative and come from `assets/automations-redesign/kit/AutomationsScreen.jsx`
(the design was ported from the cockpit's own tokens, so `var(--…)` names map 1:1 to
`packages/web/src/styles/index.css`).

Shared page chrome: sticky header `h-14` (56px), `px-5` (20px), `gap-3`, border-bottom, `bg-background`,
z-10 — the cockpit's existing route header (`routes/inbox.tsx:84` is the reference). Page body
`p-5` (20px), column gap 12px.

### 1. Automations list (`design-01-list.jpg`, `design-11-list-light.jpg`)

- **Header:** `h1` "Automations" 600 16px; `Segmented` `List <count> | Week | Day`; spacer;
  status (`.cz-auto-status`, hidden under 1280px): `StatusDot` (success when
  `scheduler.state === 'scheduled'`, neutral otherwise) "Scheduler running|idle" `·` "GitHub
  available|unavailable" `·` `timeZone` in mono 12px — 12.5px, `text-muted-foreground`,
  separators `text-soft-foreground`; `Button` primary `+ New automation`.
- **Stats strip** (`StatsStrip`): label "THIS WEEK" 600 11px uppercase `.05em` soft; four
  figures `<b>` 600 14px mono tabular + 12.5px label: runs, `$spent` spent (hidden when
  `costUsd` absent), failed (value in `--danger` when > 0), agent time (`Xh Ym`); then
  `StatusDot pending pulse` "N GitHub polls continuous" (enabled github automations); spacer;
  `clock-3` 13px "next **HH:MM** <name>" (name ellipsis at 180px); `Button` outline sm
  `calendar-clock` "Next runs" + count 500 11px mono muted → opens the rail.
- **Table** (`AutomationsTable`, inside `Card flush` with `overflow-x:auto`): `TH` height 38,
  `padding 0 10px` (first 16px), 600 11px uppercase `.05em` soft; `TD` height 48, 13px,
  `border-bottom 1px` except the last row; row `cursor:pointer`, `opacity .6` when paused,
  hover `bg-muted` (`.cz-row`), click → editor. Columns:
  1. State — `Pill dot={enabled ? success : neutral} pulse={enabled && github}` "enabled|paused".
  2. Automation — icon `github` / `clock-3` 14px soft + name 500 13px ellipsis + dispatch badge
     when `task.dispatch`: pill `bg-muted` radius 999 `1px 6px` 500 10.5px muted, `git-fork` 10px
     "×N" (`maxSubtasks`), `title="dispatch · up to N subtasks"`.
  3. Trigger — `scheduleLabel` mono 12px muted, max-width 260 ellipsis, full text as `title`
     (`on issue.opened · every 5 min` / `every day at 04:00` / `weekdays at 07:30` / `every 6
     hours` / `Tuesdays at 02:00`).
  4. Runs as (`.cz-auto-wide`) — 12px muted: `{workflow} · {runner}` + `· ⚡` (`zap` 11px,
     `title="autonomous"`) when autonomous. (Budget dropped, Q3.)
  5. Next run — mono 12px tabular; `continuous` for github; `Thu 04:00` (day + time in
     `timeZone`) for schedule; `—` when paused.
  6. Last run — `StatusDot tone` (done→success, running→pending, failed→danger, review→violet)
     + status label 12.5px muted + age 11.5px soft + "task ↗" link (600 10.5px mono `--violet`,
     radius 999, border `1px color-mix(violet 40%)`, `1px 6px`, `arrow-up-right` 9px) → task; `—`
     when none.
  7. Runs 7d, 8. Cost 7d (`.cz-auto-wide`, right-aligned, mono 12px tabular muted; cost column
     absent when `costMetrics` off).
  9. Actions (right, `padding-right 12`): ghost `icon-sm` `play` "Run now" (schedule → `run`;
     github → `check execute`), `pause`/`power` "Pause|Enable", `ellipsis` "More" → `DropdownMenu`
     width 200: Edit · View log · Duplicate · Copy as CLI · separator · Delete (destructive,
     `AlertDialog` confirm). Clicks inside the actions cell stop propagation.
- **Empty state:** `CenteredState` icon `zap` "No automations yet" subtitle "Create one paused,
  preview it, then enable it." action `+ New automation`.
- **Next runs rail** (`NextRunsRail`, `design-02`): `Sheet` side right width 360, title
  `calendar-clock` 16px "Next runs"; rows `.cz-row` grid `76px 1fr auto`, `padding 8px 16px`,
  13px: time (500 12px mono muted tabular; day prefix when not today) · name 500 13px ellipsis ·
  relative (11px soft: `in 12m` / `in 3h` / `in 2d`); 12 upcoming across enabled schedule
  automations (client-side `occurrencesBetween(now, now + 14d)`); footer separated by a top
  border `margin-top 6`, `padding 10px 14px 4px`: `StatusDot pending pulse` "N GitHub polls running
  continuously". Row click → editor.
- **Responsive:** under 1280px `.cz-auto-wide` columns and the header status hide; the table
  keeps scrolling inside its card; phone width keeps the 16px gutter the cockpit already applies.

### 2. Week view (`WeekView`, `design-04-week.jpg`)

`Card flush`: day header grid `48px repeat(7, minmax(0,1fr))`, cells `padding 10px 8px`,
border-left, 600 11px uppercase `.05em` (today `--foreground`, else soft) + day-of-month pill
(500 13px, today `bg-primary text-primary-foreground`, radius 999, `1px 7px`). Then, when any
github automation is enabled, a "poll" band row: gutter label 10.5px mono soft right; one band per
automation: height 22, radius 6, `bg color-mix(violet 8%)`, `border 1px color-mix(violet 25%)`,
`padding 0 8px`, `github` 12px violet, name 500 11.5px, `scheduleLabel` 10.5px mono muted,
`runs7d runs` right 10.5px mono soft. Then the grid: `HourGutter` (width 48, rows `HOUR_H = 34`,
10.5px mono soft right, `translateY(-6px)`, hour 0 blank) and seven columns (`border-left`,
height `24·34`, hour lines 1px `--border`, today column `bg color-mix(muted 35%)`), `max-height
560` scrolling. `EventBlock`: absolute `left/right 3`, `top = min/60·34 + 1`, height 24, radius
6, border, `bg-card`, `shadow-xs`, `padding 0 6px`, 500 11.5px, `StatusDot` (runner codex →
violet, else success) + name ellipsis, `title="<name> · HH:MM"`, `opacity .5` when paused, click →
editor. `NowLine` in today's column: 2px `--primary` at the current minute with an 8px dot at
`left -3`. Occurrences from `occurrencesBetween(weekStart, weekEnd)` for ALL definitions
(paused ones render at 50%). Overlapping blocks at the same minute stack with `top + 26·k`.

### 3. Day view (`DayView`, `design-05-day.jpg`)

Grid `minmax(0,1fr) 320px` gap 16. Left `Card flush`: toolbar `padding 10px 14px` border-bottom:
ghost `icon-sm` `chevron-left`/`chevron-right` (previous/next day), "Wed 16 Sep" 600 14px,
`Pill dot=success` "today" when today, right "N scheduled runs" 12px muted; body `max-height 600`
scrolling with `HourGutter` and one column; `EventBlock wide` (height 48, `padding 5px 8px`,
column layout, second line `HH:MM · workflow · runner` 10.5px mono muted). Right `Card flush
padding 12px 0`: "AGENDA" heading 600 11px uppercase soft `padding 0 14px 8px`; rows `.cz-row`
grid `48px 1fr` gap 10 `padding 8px 14px`: time 500 12px mono (soft when past), name 500 13px
(muted when past) with `StatusDot` (past → last run tone, else neutral), prompt excerpt 11.5px
soft ellipsis; empty: "Nothing scheduled — GitHub polls still run." 12.5px soft.

### 4. Editor (`AutomationEditor`, `design-06…09`)

- **Header:** ghost `icon-sm` `arrow-left` (back to list), `h1` "New automation|Edit
  automation" 600 16px, `Pill dot` enabled|paused (edit only), spacer, ghost sm
  `layout-template` "Start from a template|Hide templates" (new only), outline "Cancel", primary
  "Save changes" | "Save and enable" | "Save paused" (by the Enable switch), disabled until name
  and prompt are non-empty.
- **Body:** centred, `max-width 1080`, grid `minmax(0,1fr) 320px` gap 16; left column gap 16 of
  `Section` = `Card` `padding 0 24px`, title 600 14px `padding 16px 0 4px`, body column gap 14
  `padding 10px 0 20px`.
  1. **Template palette** (`TemplatePalette`, new only, open by default): `Card flush padding 0 0
     12px`; `TabBar` "Built-in" | "From your other projects" with a right caption 12px soft
     ("Ship with cezar" | "Registered in ~/.cezar/config.json"); grid `repeat(auto-fill,
     minmax(240px,1fr))` gap 10 `padding 12px 16px 0`; card: `border 1px`, radius 10,
     `bg-card-2`, `padding 10px 12px`, column gap 6: icon (`github`/`clock-3` 13px soft) + name
     600 13px ellipsis + `BranchChip` project name (other-projects tab, right); `when` 11.5px
     mono muted; prompt 12px soft 2-line clamp; outline sm "Use this" → fills name, kind,
     schedule|events, prompt, task and closes the palette. The second tab loads
     `getAutomationTemplates` lazily; empty: "No automations in your other projects yet." Built-in
     list: Nightly dependency bump · Triage new issues · Weekly changelog draft · Stale PR nudge ·
     Flaky test hunt · Security advisories (texts in `lib/automation-templates.ts`).
  2. **Name:** `Input` `max-width 420` 15px, placeholder "Nightly dependency bump".
  3. **When:** `Segmented` "On a schedule | When GitHub changes". Schedule: `Chip` row
     (`Every day`, `Weekdays`, `Weekly`, `Every N hours`, `active` = type); weekly adds a `Chip`
     row Mon…Sun (`padding 0 9px`); hours shows "every `Select` (1,2,3,4,6,8,12 h) starting at
     00:00" 13px muted; otherwise `TimeRow`: "at" `Input` HH (width 56, mono, centred) ":" `Input`
     MM, `timeZone` mono 12px; last line "cron" 12px mono soft + `BranchChip` `cronOf`. GitHub:
     `Chip` row of the four events (mono, multi-select — the shipped feature allows several;
     the design's chips read as one but the contract is `events[]`), "poll every `Select` (2, 5,
     10, 15, 30, 60 min) · last `filters.lookbackDays` days · maximum `filters.maxRecords`
     records" 13px muted; the advanced filters (authors, assignees, labels, lookback, max) live in
     a `Collapsible` "Filters" under that line (not in the export — the shipped feature needs
     them; `changedLabels` required for label events). When the forge is unavailable, the GitHub
     segment is disabled with `title = reason`.
  4. **What to run:** chips row: `file-text` 12px "Prompt templates" + `Chip` per prompt template
     from `availablePromptTemplates(capabilities)` (height 24, 11.5px; click inserts at caret)
     + dashed `Chip settings-2` "Manage…" → Settings → Prompt templates; `Textarea` rows 5
     `min-height 104` 14px/1.55, placeholder per kind ("Placeholders: {{date}}, {{project}}" /
     "{{github.url}}, {{github.title}} …"); run-as row: `Chip chevron workflow` workflow ·
     `Chip chevron` runner · model · `base: <branch>` (read-only, from `/repo`) — these are the
     composer's `PickerPill`s restyled by the shared `Chip`, reusing `RUNNERS`, `modelsForRunner`
     and the workflow list; right: `Label` "Autonomous" + `Switch`. Note 12px/1.5 soft: "Each run
     is an ordinary cezar task in its own worktree — it queues behind the parallel cap like
     anything else and never auto-merges." Dispatch row (top border, `padding-top 12`, hidden
     when `capabilities.dispatch` is off): `git-fork` 14px (violet when on) "Dispatch" `Switch`;
     when on: `·` "up to `Select sm` (1,2,4,6,8) subtasks" `·` `Switch sm` "review child",
     right "≤ {maxSubtasks + 1} agents" 11.5px soft. (No budget field, Q3.)
  5. **Enable:** `Switch` "Enabled" + for github "— from a current-time baseline; existing
     matches will not launch" 12px muted.
- **Right column** (`position: sticky; top: 76`), gap 12:
  - `NextRunsPreview` `Card flush padding 12px 0 8px`: heading "NEXT 5 RUNS" | "HOW IT POLLS";
    schedule → five rows `padding 5px 14px`: `Thu 04:00` 500 12px mono width 82 + `in 18h` 11.5px
    soft, computed live from the form; github → "Checks GitHub every N min while cezar is open,
    through your `gh`. No webhook or public URL required." 12.5px/1.5 muted.
  - `CopyAsCliCard` `Card flush padding 12px 14px`: "COPY AS CLI" + ghost sm `copy` "Copy" (height
    24) → clipboard + toast; `pre` 11.5px/1.6 mono muted `bg-card-2` border radius 8 `padding 8px
    10px` wrapping; caption 11.5px soft: "The same definition the cockpit saves — `cez automation
    schema` prints its shape." Flag form when expressible (§ CLI), else `cez automation create
    --json '…'`.
  - `LastRunCard` (edit, when `lastRun`): "LAST RUN" heading; `StatusDot` status age (11.5px soft)
    cost right (12px mono muted); buttons outline sm `play` "Run now", ghost sm `scroll-text`
    "View log".
- **Save:** create → `POST` (enable per switch); edit → `PUT` with `expectedRevision`; a 409
  shows "Edited elsewhere — reload to see the latest version" with a Reload action; validation
  errors inline under the section they belong to (`role="alert"`).

### 5. Execution log (`AutomationLog`, `design-10-log.jpg`)

Header: back, name 600 16px, "· execution log" 13px muted, spacer, outline sm `pencil` "Edit".
Body centred `Card flush max-width 820`; row grid `90px 110px 1fr auto auto`, `padding 12px
16px`, 13px, row gap 8 / column gap 12: time 500 12px mono muted (`Wed 04:00` in `timeZone`;
older than 6 days → `12 Sep 04:00`), `Pill dot` result (launched/manual/catch-up → success,
skipped/no-match/preview/baseline/duplicate → neutral, failed/error/rate-limited → danger), note
(reason; danger colour on failed/error) ellipsis, cost 12px mono soft, ghost sm "Open task ↗" when
`runId`. Children (from `runs[runId].children`) as an indented block spanning all columns,
`padding-left 14`, grid `14px 70px 1fr auto auto` gap 10 12.5px: `└` 11px mono soft, kind pill
(`bg-muted` 500 10.5px), `StatusDot` + title ellipsis, cost 11.5px mono soft, ghost sm (height
24) "Open ↗". Existing "Retry task" affordance stays on `launch-error` rows as a ghost sm button.
Filters (result, event) stay as `Select`s in the header's spacer area (shipped behaviour).

### 6. Sidebar and gating states

- Nav item "Automations" (`zap`) shows whenever `capabilities.automations`; the forge no longer
  gates it.
- `CEZ_AUTOMATIONS=0`: deep links render `CenteredState` "Automations are off — this cockpit was
  started with CEZ_AUTOMATIONS=0." (text updated; the e2e "absent without opt-in" case flips to
  "absent when opted out").
- Forge unavailable: list header says "GitHub unavailable · <reason>"; github rows show
  `Pill dot=neutral` "paused by capability" in State; the editor disables the GitHub segment.

### 7. Composer (from-prompt phase)

Unchanged from the patch: the built-in skill in the picker, the `create-automation` template,
the system-prompt part. Only the texts learn the schedule kind.

## 📝 Primitives

Promote once, use everywhere. Each new primitive gets a test file and a `data-slot`.

| Primitive | File | Normative style (from the kit) |
|---|---|---|
| `Chip` | `components/chip.tsx` (promotes `chipClass` from `picker-pill.tsx`; `PickerPill` keeps using it) | `inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-55`; `active`: `border-foreground text-foreground font-semibold`; `skill`: `border-violet text-foreground font-mono font-semibold`; `icon` 12px; `chevron` 10px `text-soft-foreground`; dashed variant via `className`. |
| `Segmented` | `components/segmented.tsx` (generalises `SegmentedControl` in `facet-filter.tsx`; that caller migrates) | wrapper `inline-flex gap-0.5 rounded-md bg-muted p-[3px]` (`full` → `w-full`, buttons `flex-1`); button `h-7 rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground`, pressed `bg-card text-foreground font-semibold shadow-xs`, `aria-pressed`; optional `count` as `<small>` 11px mono tabular. Radio semantics (re-click is a no-op) — `facet-filter` keeps its release-on-reclick by passing `allowRelease`. |
| `Kbd` | `components/kbd.tsx` | `rounded-[5px] border border-border border-b-2 bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground`; `onContrast` swaps to translucent contrast-foreground. |
| `BranchChip` | `components/branch-chip.tsx` | `inline-block rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-muted-foreground whitespace-nowrap`. |
| `Switch` | `ui/switch.tsx` (already has `size="sm"`: 24×14, thumb 12) | reuse. |
| `Card` | `ui/card.tsx` + `flush` | `flush`: `p-0 gap-0 overflow-hidden`. |
| `Pill`, `StatusDot`, `Button`, `Sheet`, `DropdownMenu`, `AlertDialog`, `Select`, `Input`, `Textarea`, `Label`, `TabBar`/`TabLink`, `CenteredState`, `Collapsible`, `Tooltip`, toaster | existing | unchanged; the kit's values already match (`Button` variants and sizes, `Pill` `px-2.5 py-[3px] text-xs`, `StatusDot` 7px). |

Screen components (all under `routes/automations/`, one file each, props typed on the contract):
`automations-route.tsx` (mode switch, gate, data), `automations-header.tsx`, `stats-strip.tsx`,
`automations-table.tsx`, `row-actions.tsx`, `next-runs-rail.tsx`, `week-view.tsx`,
`day-view.tsx`, `calendar-parts.tsx` (`EventBlock`, `HourGutter`, `NowLine`), `editor.tsx`,
`editor-schedule-fields.tsx`, `editor-github-fields.tsx`, `editor-run-as.tsx`,
`editor-dispatch-row.tsx`, `template-palette.tsx`, `next-runs-preview.tsx`,
`copy-as-cli-card.tsx`, `last-run-card.tsx`, `log.tsx`. Pure helpers: `lib/automation-format.ts`
(`relativeIn`, `dayName`, `hm`, `agentTime`, `usd`) and `lib/automation-cli.ts` (`cliOf`).

## 📝 Edge Cases & Failure Scenarios

| Case | Behaviour |
|---|---|
| DST: a `daily 02:30` in a zone that skips 02:30 on spring-forward | `nextOccurrence` resolves the wall time through `zonedWallTimeToUtc`; a non-existent wall time maps to the next valid instant (03:30) once; a repeated wall time on fall-back fires once (the first instant). Tested with `Europe/Warsaw` and `America/New_York` fixtures. |
| `hours` type across DST | Anchored at 00:00 wall time each day, so a 23- or 25-hour day simply has one fewer/more slot. |
| Server zone changes between boots | `nextRunAt` is an instant; the next `schedule()` recomputes from the schedule, so the first run after the change lands on the new zone's wall time. Header shows the current zone. |
| Cezar was down, or the laptop slept, for hours or days | The age rule (Lifecycle §3): one `catch-up` at most when the latest missed occurrence is < 24 h old, else `skipped` with the count; `nextRunAt` advances from `now`, so no burst either way. |
| Two cezar processes on one project | Existing lease; the loser hits the receipt, logs `duplicate`, advances its own `nextRunAt` and does not count a failure. `setState` is read-modify-write, so neither process clobbers the other's state file. |
| Run queue at capacity | The run is created queued (existing scheduler); the log row is `launched` — queued is a run state, not a failure. |
| Workflow/model/runner missing at fire time | `failed` row with the reason; after 3 consecutive launch failures the automation auto-pauses and the list shows it paused with the last failure. |
| `task.dispatch` set but `capabilities.dispatch` off | Saved as given; at fire time the run launches WITHOUT dispatch and the log reason says "dispatch is off on this cockpit; ran as a plain task". Never a 409. |
| Upgrade flips the default on with old enabled github definitions in the store | Re-baselined at boot when idle longer than their lookback (Lifecycle § Default-on); the log says so; nothing from the backlog launches. |
| Edit changes the schedule while a run is queued | The queued run is unaffected; `nextRunAt` recomputes. |
| Edit switches kind github → schedule | Refused with 409 "change the kind by creating a new automation" — receipts and cursors are kind-specific and a silent swap would orphan them. Duplicate + delete is the path. |
| Old `automations.json` (no `kind`) | Parses as github; nothing rewritten until the next edit. |
| Older cezar reads a run launched by a schedule | The run carries `automationTrigger`, an unknown key the older `runRecordSchema` strips; `automation` is absent, so the strict `githubUrl` never fails. `runs.json` stays fully readable on a downgrade. |
| `costMetrics` off | `costUsd`, `costUsd7d`, `stats.costUsd` absent; the strip and columns hide; the CLI's `list` prints `—`. |
| Templates route: a registered project's store is corrupt or unreadable | Skipped with one server warning; the tab shows what could be read. |
| Copy to clipboard unavailable (non-secure context) | Toast "Copy failed — select the text to copy it"; the `pre` is selectable. |
| Week view with >12 blocks in one hour cell | Blocks stack; the cell scrolls with the column. Fine for the bounded shapes (max 24/day per automation). |

## 📝 Risks & Impact Review

- **Breaking — default-on (Q8).** `capabilities.automations` flips from `=== '1'` to `!== '0'`.
  Impact: every cockpit gains the nav item and the scheduler timer (idle until an automation is
  enabled); the routes stop answering `409` by default; stores with forgotten enabled github
  definitions are re-baselined at boot rather than resumed (Lifecycle § Default-on) — the one
  way this flip could have launched work on its own. Required path (BACKWARD_COMPATIBILITY.md
  general rule): README env row rewritten (`CEZ_AUTOMATIONS=0` opts out; `=1` accepted, no-op),
  CHANGELOG entry at release marked breaking, minor bump, a new compatibility section
  "Automations — default-on (this spec)", and an AGENTS.md § Zero config owner-approved
  exception bullet in the form the dispatch and skills-updates entries use. Rollback:
  `CEZ_AUTOMATIONS=0`. Owner-approved on 2026-09-14 (gate Q8).
- **Contract addition — `RunRecord.automationTrigger`.** Optional, stripped by older readers;
  `automation` is untouched. Called out in the compatibility file §3.
- **Nav gating change.** The Automations item no longer needs a forge. A repo without GitHub sees
  a page whose GitHub kind is disabled with the reason — deliberate, the schedule kind is the
  point.
- **Scheduler safety.** New launch path; mitigated by receipts per occurrence, the shared lease,
  one-catch-up rule, auto-pause after 3 failures, fake-clock tests including DST.
- **Cross-project templates read other projects' prompts.** Same user, same machine, same
  loopback server, gated; no new persistence.
- **Pixel fidelity vs. shared primitives.** The kit's values are written into § UI/UX; where the
  cockpit's existing primitive differs by a pixel (e.g. `Segmented` button height 28 vs the
  facet filter's 24), the kit wins and the existing caller adopts it — one control, one look.
- **Scope.** Large but one capability (automations); the phases are reviewable slices inside
  one PR (Q5).

## 📋 Phasing

Each phase leaves the app working and green; together they are one PR.

1. **Primitives** — `Chip`, `Segmented`, `Kbd`, `BranchChip`, `Card flush`; migrate only the
   two spellings the automations screens share (`PickerPill`'s `chipClass`, `facet-filter`'s
   segmented control — the latter grows to the kit's 28px, a deliberate visual change on the
   Tasks "group by" control). No other screen is touched.
2. **Contract + storage + schedule engine** — kind-aware schemas, `automation-schedule.ts`,
   contract `zoned-time.ts`, `schedule-runner.ts`, scheduler handle/`schedule()` changes,
   read-modify-write `setState`, task-template changes (schedule placeholders, dispatch intent,
   review-child suffix, `automationTrigger` provenance).
3. **Routes + gating** — every-project handles in `server.ts`, kind-aware validation, `run`,
   `check`/`retry` kind rules, `stats.ts`, enriched list/log, `workspace/automation-templates`,
   default-on capability with the boot re-baseline, docs and compatibility notes.
4. **Surface: list, rail, week, day.**
5. **Surface: editor, palette, preview, Copy as CLI, last run.**
6. **Surface: log.**
7. **From-prompt patch** — `git am` the patch from `assets/automations-redesign/patch/`
   (committed on the branch), resolve the expected conflicts with phases 1–6, adapt schema
   reference/skill/prompt to both kinds, add `add` flag sugar, wire "Copy as CLI" to it.
8. **Verification** — unit, route, contract-parity, web, e2e journeys, QA screenshots against the
   design at 1440×900 (light and dark), phone sweep.

## 📋 Implementation Plan

Validation gate for every step: `npm run typecheck`, `npm test`, `npm run test:unit`,
`npm run build`, `npm run test:package`; e2e at the end (`npm run test:e2e`).

**Phase 1 — primitives**
1. Add `components/chip.tsx` (+test) from `chipClass`; `picker-pill.tsx` re-exports `chipClass`
   from it. Test: renders `active`/`skill`/`chevron`/`icon`, forwards `disabled`.
2. Add `components/segmented.tsx` (+test) with `count`, `full`, `allowRelease`; migrate
   `facet-filter.tsx`'s `SegmentedControl` (used by `routes/global-tasks.tsx` for "group by") to
   it — its tests keep passing, its buttons grow from 24px to the kit's 28px.
3. Add `components/kbd.tsx`, `components/branch-chip.tsx` (+tests). Both are new spellings;
   nothing outside the automations screens migrates in this PR.
4. `ui/card.tsx` `flush` (+test). (`ui/switch.tsx` already ships `size="sm"`.)

**Phase 2 — contract, storage, engine**
5. `packages/contract/src/zoned-time.ts`: move `zonedParts`/`zonedWallTimeToUtc` out of
   `core/usage-limit.ts`, which imports them back; usage-limit tests unchanged.
6. `packages/contract/src/automation-schedule.ts`: `automationScheduleSchema`,
   `normalizeSchedule`, `cronOf`, `parseCron` (four shapes), `scheduleLabel`, `nextOccurrence`,
   `occurrencesBetween` (on the contract's zoned-time). Tests: every type, week boundaries, DST
   fixtures (`Europe/Warsaw`, `America/New_York`), `parseCron(cronOf(s)) ≡ s`.
7. `contract/src/automations.ts`: `kind`, `schedule`, `task.dispatch`, log results, list
   response (`timeZone`, `stats`, per-entry fields), `automationRunResponseSchema`,
   `automationTemplatesResponseSchema`, log `runs` map; `contract/src/runs.ts` +
   `runs/store.ts`: optional `automationTrigger`. `automations/types.ts` mirrors with defaults
   and the kind `superRefine`. Tests: old fixture parses as github; schedule fixture; refusals;
   an old-schema parse of a record with `automationTrigger` keeps every run.
8. `automations/store.ts`: read-modify-write `setState` (+test: two stores on one dir
   interleave writes, both ids survive).
9. `automations/schedule-runner.ts` (+tests with fake clock and an in-memory store): age rule
   (scheduled / catch-up / skipped), receipt → launch → log → `nextRunAt` from `max(occurrence,
   now)`, manual, duplicate and held-lease not counted, failure and auto-pause after 3, no burst
   after a simulated 3-day sleep for daily and hourly.
10. `automations/scheduler.ts`: `github?` on the handle; both kinds in `schedule()`; tests: a
    project without github gets schedule items only; a github and a schedule definition arm one
    timer for the earlier; a fired schedule re-arms in the future.
11. `automations/task-template.ts`: `renderScheduleTask` + placeholder validation per kind,
    `dispatchIntentOf` (ignored when dispatch off), review-child suffix text, `automationTrigger`
    provenance, `reconcileAutomationReceipts` reading both keys. Tests.
12. `automations/stats.ts` (+tests): week window in a zone, 7d tallies, `costMetrics` off.

**Phase 3 — routes and gating**
13. `server.ts`: `automationProjects`/boot warm-up register every project (github sub-object
    only for github.com remotes); kind-aware create/update schemas (PUT inherits kind) and the
    409 rules; `POST /automations/:id/run`; `check` refuses schedule; kind-aware `retry`;
    enable/pause per kind; PUT clears `nextRunAt` on schedule change. Tests in
    `automations-api.test.ts`; route parity test updated.
14. List enrichment (`timeZone`, `stats`, `nextRunAt`, `lastRun`, `runs7d`, `costUsd7d`) and log
    `runs` map (root + children). Contract parity tests.
15. `automations/templates.ts` + `GET /api/v1/workspace/automation-templates` with its gate;
    tests with two fake project roots, one unreadable; `bc-route-inventory.test.ts` and
    `BACKWARD_COMPATIBILITY.md` §2 list it and `run`.
16. `capabilities.ts` default-on + boot re-baseline (+tests: idle enabled github definition is
    re-baselined with a `baseline` row, a recently polled one is not); `automations-gate.test.ts`
    flips to `CEZ_AUTOMATIONS=0`; `health` tests; README env row; `BACKWARD_COMPATIBILITY.md`
    default-on section and §3 `automationTrigger`; AGENTS.md exception bullet; `.env.example`.
17. `api-client`: `runAutomationNow`, `deleteAutomation`, `getAutomationTemplates`, types.

**Phase 4 — list, rail, calendars**
18. `routes/automations/automations-route.tsx`: data hook (`getAutomations` + `automation-change`
    refresh), gate states, `?view=` param, mode switch. Remove the old file.
19. `automations-header.tsx`, `stats-strip.tsx` (+tests: costMetrics off hides spent).
20. `automations-table.tsx`, `row-actions.tsx` (+tests: paused opacity, dispatch badge, task
    link, actions stop propagation, delete confirm, duplicate posts a paused copy).
21. `next-runs-rail.tsx` (+test: 12 rows, github footer count).
22. `calendar-parts.tsx`, `week-view.tsx`, `day-view.tsx` (+tests with a fixed `now`: block
    positions, today column, poll band, agenda past/future tones).
23. `lib/automation-format.ts` (+tests).

**Phase 5 — editor**
24. `editor.tsx` state model (`draft` typed on the contract; `toBody(draft)`; `fromDefinition`),
    header buttons, save/409 handling (+tests).
25. `editor-schedule-fields.tsx`, `editor-github-fields.tsx` (+ filters collapsible), `editor-run-as.tsx`
    (workflow/runner/model/base chips over `RUNNERS`/`modelsForRunner`/workflows), `editor-dispatch-row.tsx`
    (+tests: hidden when dispatch off, agents hint).
26. `template-palette.tsx` + `lib/automation-templates.ts` (+tests: use-this fills the draft;
    other-projects tab lazy load, empty state).
27. `next-runs-preview.tsx`, `copy-as-cli-card.tsx` + `lib/automation-cli.ts` (+tests: flag form
    vs JSON fallback, clipboard failure toast), `last-run-card.tsx`.
28. Prompt-template chips + "Manage…" navigation; `nav-items.ts` gating change (+test).

**Phase 6 — log**
29. `log.tsx` (+tests: result tones, children block, retry stays, time formatting).

**Phase 7 — from-prompt patch**
30. `git am --3way .ai/specs/assets/automations-redesign/patch/0001-automations-from-prompt.patch`
    (the patch is committed on this branch; its package README sits beside it). It applied
    cleanly to `origin/main` on 2026-09-14, but phases 1–6 rewrite `automations/types.ts`,
    `server/server.ts` and `api/client.ts`, so conflicts there are expected and resolved by
    hand; the package README's "what changes in existing files" list is the guide. Verified by:
    the patch's own test files (`automations/automation-cli.test.ts`, `prompts.test.ts`,
    `skills.test.ts`, `workflows/system-prompt.test.ts`, `web/src/lib/prompt-templates.test.ts`)
    green, plus the gate.
31. `automation-cli.ts`: `add` subcommand (+tests: cron shapes, `--on/--every`, body equality
    with `create`), `schema` covering both kinds; `prompts.ts` schedule wording (+tests pin the
    reference against the storage schema for both kinds); `builtin-skill.ts` playbook update.
32. `copy-as-cli-card` emits the `add` form; README CLI section.

**Phase 8 — verification**
33. `packages/web/e2e/automations.e2e.ts`: opted-out case (`CEZ_AUTOMATIONS=0`); schedule
    journey (new → template → save paused → Run now → task appears → log shows it → week view
    shows the block → enable → next runs rail lists it → pause → delete); github journey as
    today. `ios-sweep.e2e.ts` gains the list and the editor (asserts no horizontal overflow).
34. Design-fidelity evidence: the e2e run saves 1440×900 light and dark screenshots of every
    screen to `.ai/qa/artifacts_e2e/automations-*.png`; the PR shows each next to its
    `design-*.jpg`. This is reviewer evidence, not an automated assertion — the pixel values
    themselves are asserted by the component tests (computed styles on the rendered primitives).
35. Run notes in `.ai/runs/2026-09-14-automations-redesign.md` (documentation, no test);
    CHANGELOG left to release.

## Not done (deliberately)

New GitHub events (Q6), a repo-committed definition format (Q2), per-run budgets outside
dispatch (Q3), a `reviewChild` field on the dispatch INTENT (Q4 — the automation's own
`task.dispatch.reviewChild` is stored and becomes a prompt suffix), full cron expressions, automations while the
server is stopped, a dedicated "New automation from prompt" composer screen (the skill picker
and template are the composer's affordances, per the patch's spec).
