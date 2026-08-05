# Auto-resume a task after a provider usage limit

> Depends on: `2026-07-24-monitoring-session-auto-wake.md` (the timer/deadline pattern it reuses)

## TLDR

A subscription window that runs out kills the task, not the work: the agent was mid-way through something the user asked for, the account simply closed until a known instant. Cezar already receives that instant — Claude Code puts it in the failure verbatim — and then throws it away. This spec keeps it: a run that fails on a usage limit schedules its own continuation for the reset instant plus 30 seconds, says so in the thread, and can be switched off in one place. On by default.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | On or off by default? | **On.** | Owner decision, and the one cost-bearing automation in `resources` that earns it: it spends nothing while it waits, and it finishes work the user already asked for rather than starting any of its own. The alternative is a task that quietly sits dead until someone notices hours later — which is the bug this exists to remove. |
| Q2 | What if the provider names no reset instant? | Do nothing — the run stays `failed`. | A guessed window is a retry loop against a provider that is still refusing. "We don't know when" is an honest answer and leaves the pre-feature behavior (Continue) exactly intact. |
| Q3 | How long after the reset? | +30 s. | Resuming AT the boundary races the provider's clock and its rounding, and one failed resume costs the whole window again. Thirty seconds is free next to five hours. |
| Q4 | Safety bound? | 12 consecutive resumes without a human turn. | A resume can only fire after a real reset instant, so this is not a throttle — it is the backstop for a provider answering "limit reached, retry now" in a loop. Twelve sits through a couple of days of five-hour windows. |
| Q5 | Per project or per machine? | Machine (`~/.cezar/config.json` `resources`). | The limit belongs to the account, not the repo — same reasoning that moved `maxParallel` there. |
| Q6 | What about a task the user has walked away from? | Archived tasks are never scheduled or re-armed, archiving retires a pending resume, and there is a per-task **Don't resume**. A deadline missed by more than 24 h expires instead of firing. | A window closes the whole ACCOUNT, so one limit can park several tasks at once and each gets its own promise. That is right for work in flight and wrong for work abandoned — reviving a task from another era is a surprise, not a service. The user needs the per-task off switch as much as the global one, and "I archived it" has to mean what it says. |

## Problem Statement

Claude Code answers an exhausted window with an `is_error` result whose text is machine-readable: `Claude AI usage limit reached|<epoch seconds>`. Cezar surfaces that string as the run's `error`, marks the run `failed`, and stops. Every parked task then waits on a human to come back, notice, and press Continue — typically long after the window reopened. Overnight and weekend runs lose the entire remaining window.

Nothing about the state is actually broken: the worktree, the branch, the handoff file and the agent session id are all intact, and `continueRun` already knows how to pick the work back up. The only missing piece is the alarm clock.

## Research

The reset instant is the whole feature, and the shapes it arrives in differ by backend:

- **Claude Code** — `Claude AI usage limit reached|<epoch seconds>` in the result frame. Exact, locale-free, no prose parsing. This is the case that matters in practice.
- **Codex / OpenCode** — prose, when they carry an instant at all (`try again at <ISO>`), or a relative delay (`retry after 3600`).
- **Raw API 429s** — frequently no instant at all, which Q2 answers.

Two adjacent mechanisms already exist in the engine and were deliberately NOT reused:

- `monitoringWakeAt` (spec 2026-07-24) parks a LIVE session and nudges it on a cadence. Here the session is dead and the run is `failed`, so the timer cannot live on an `ActiveRun`.
- `recover()`'s restart continuation re-queues interrupted runs at boot. Same destination (`continueRun(…, deferForCapacity)`), different trigger.

## Proposed Solution

One question, asked once, on the path every terminal transition already funnels through (`dropActive`): *did this run fail because the account is out of window, and when does that window reopen?* When the answer is yes:

1. persist `autoResumeAt = resetAt + 30 s` on the record and arm an unref'd timer for it;
2. append a lifecycle line naming the instant;
3. at expiry, re-check the record synchronously (hours have passed — the user may have continued, cancelled or deleted it), then hand the resume to the ordinary queued-continuation path so it obeys both the workspace and per-project concurrency caps like any other work;
4. count it against a 12-resume cap that any human turn, or any successfully settled turn, resets.

The run stays `failed` while it waits, deliberately: it IS failed, the Continue button still works, and every existing view keeps its current meaning. What changes is that the thread now says the failure is going somewhere.

## Architecture

### Detection — `src/core/usage-limit.ts`

`parseUsageLimit(message, now)` → `{ resetAt, evidence } | null`, recognized in order of exactness: the Claude marker (epoch seconds, milliseconds tolerated), an explicit ISO instant in prose, a relative delay / `retry-after`. Gated on a narrow limit-phrase test so a timestamp that happens to sit in an unrelated error can never schedule anything. A reset already in the past clamps to now (the window is open); one further out than **seven days** is refused rather than believed — a corrupt number must not swallow a task. Never throws: this runs on the failure path of every run.

### Scheduling — `RunManager`

`autoResumeTimers: Map<runId, Timeout>` on the MANAGER, not on `ActiveRun`: these runs are failed and therefore not active. The deadline itself is on the record, so the map holds nothing that matters — a restart rebuilds it.

- `scheduleAutoResumeIfLimited(runId)` — called from `dropActive`. Refuses silently (run stays plainly failed) when the setting is off, the message carries no reset, there is no session to resume, or a resume is already armed. The one loud refusal is the cap, which appends a note: a run that stops resuming has to explain itself.
- `armAutoResume(runId, deadline)` — publishes `autoResumeAt` (the cockpit's only source) and arms the timer.
- `fireAutoResume(runId)` — re-checks `status === 'failed'` and `autoResumeAt`, then `continueRun(runId, { text: … }, /* deferForCapacity */ true)` **and pumps**: a deferred continuation only enqueues itself, and `recover()` — the only other deferring caller — pumps once after its bulk sweep. Without that pump the resumed run parks at `queued` until an unrelated run happens to finish.
- `clearAutoResume(runId, keepAttempts?)` — called at the top of `continueRun` once every refusal has passed, so a human Continue retires the schedule and starts a fresh epoch.
- `cancelAutoResume(runId)` — the PUBLIC per-task off switch behind `DELETE /api/v1/runs/:id/auto-resume` and the archive route. Idempotent; leaves the workspace setting and every other task alone.
- `reconcileAutoResumes()` — the self-healing sweep, run from `pump()` and once from `recover()`. Switching the setting off cancels armed timers and clears their deadlines; otherwise every `failed` record carrying an `autoResumeAt` this process is not currently holding gets armed from that record.

The reconcile is a reconcile rather than a boot-time restore because **the deadline is durable state and the timer is not**: a restart, a rebuilt project context, a manager disposed mid-wait, or a refused continuation all leave a record promising a resume nothing is holding, and the cockpit renders that promise. Rebuilding from the record covers every one of those with one mechanism. A deadline that passed while cezar was down floors to zero and fires immediately — the window is open, which is the point. A record whose deadline is unreadable, or whose cap is spent, is retired instead of armed.

### The queue hold

A limit closes an **account**, not a run — so freeing the slot and starting the next queued task walks it into the same wall. Measured before this existed: eight tasks under `maxParallel: 2` all failed within **517 ms**, each spawning a CLI (and, outside worktree-opt-out mode, a worktree and a branch) only to be marked `scheduled`. The cap was respected at every instant and was no brake at all, because a doomed run lives ~200 ms. Every cycle then re-ran the stampede and spent one of every task's 12 attempts.

So `pump()` will not start a queued run while any run **on the same agent account** holds a future `autoResumeAt`:

- **Keyed, not global** — `runner:agentProfile` (`runAccountKey`). A Claude limit must not stall Codex tasks, and a second login is a second budget.
- **Derived, not tracked** — `RunManager.heldAccounts()` reads the durable records (`usageLimitHolder`), so the hold survives a restart, expires by itself, and lifts when a user cancels a resume or archives the task. There is no new state and no config key.
- **Held until a resume PROVES the window** — a run holds its account while parked on a future deadline *and* while its automatic resume is in flight (`autoResumeAttempts` set, status queued or running). Ending the hold when the resume fires ends it at the moment the account is least proven: every cycle then let a queued task dequeue, walk to the repo-root lease and get handed back, which is what filled one reported transcript with six identical `run started … held in the queue` blocks. The counter is retired by the first completed turn — a settled run, or one that parks for the user — which is the only evidence the limit actually lifted.
- **Two kinds of hold, because they bind different work** (`AccountHolds`, `accountHeldFor`) — and getting this wrong produced a bug in each direction:
  - `deadline` (a run parked on a reset instant that has not arrived) — the window is KNOWN shut, so it blocks everything on that account, **resumes included**. Exempting them let four windows reopen at once, every resume spawn, and each one re-limit: four `scheduled` where two was the answer. The stampede wearing a different hat.
  - `inFlight` (a resume running right now, re-testing the window) — nothing is proven yet, so it blocks fresh work but **not other resumes**. Blocking those deadlocked a live workspace: two resumes fired together, each waiting on the account the other held, both parked `queued` forever with every task behind them.
- **A failsafe, because a wedged queue is too expensive to leave to any one fix being right** — `rescueStalledQueue`, on a 60 s unref'd tick. Idling is legitimate while work runs (here or in another project) or while a real appointment is still ahead; anything else is work queued, nothing running anywhere, and no event coming to wake it. That gets one forced sweep under the ordinary caps, and the account's real state re-asserts itself: if the window truly is shut, that task meets the limit and re-establishes an honest hold with a deadline behind it. The override carries into the spawn gate too, or the rescue would undo itself a millisecond later.
- **Workspace-wide** — published through `WorkspaceSemaphore.heldAccounts()`, because one account can be driving tasks in several projects and the limit closes all of them. Optional on the participant, so a stub holds nothing.
- **Published before the slot is released** — `dropActive` schedules the resume *then* calls `releaseSlot`. The other order leaves a window where the queue sees a free slot and a healthy-looking account; it measured as exactly one extra doomed task.
- **FIFO among what can start** — a held run keeps its place in the queue rather than being dequeued and re-queued.

**Dequeue is not the moment of no return**, so the same question is asked again at the last honest moment — `requeueWhileHeld`, immediately before the first spawn and again right after the exclusive repo-root lease is granted. A `worktree: false` run parks on that lease, and a run parked there holds no slot (#347), so the queue keeps advancing behind it and the dequeue gate is minutes stale by the time it spawns: measured at four of five in-place tasks starting under `maxParallel: 2`. A run refused here has created no session and no worktree, so it goes back as plain `queued` with `startedAt` cleared — untouched, not half-started.

One accepted consequence: when the window reopens, resumed runs re-enter the queue at the back (`continueRun` pushes), so a task that never started can take the freed slot first. A scheduled run blends into the queue like any other work.

### State

Two additive optional `RunRecord` fields, both carried by the existing run update event and both mirrored in `packages/contract/src/runs.ts`:

- `autoResumeAt?: string` — present ONLY while a resume is pending. `RunStore.open` keeps it on a `failed` run (that is what `recover()` reads) and drops it anywhere else; `updateRun` drops it whenever a run comes back to life, so the record cannot outlive the promise.
- `autoResumeAttempts?: number` — the cap's counter, persisted so a restart cannot reset a loop to zero. Cleared by a human Continue and by `settleSuccess`.

### Configuration

Two scopes, because one limit parks several tasks and the user needs to answer for one without answering for all:

- **Machine** — `resources.autoResumeOnUsageLimit: boolean` (default `true`) in `~/.cezar/config.json`, on the existing `GET/PUT /api/v1/workspace/config` contract, cached by `WorkspaceSemaphore` like every other resource key, so a change takes effect without a restart. No environment variable: one surface, and the setting is persistent.
- **Task** — `DELETE /api/v1/runs/:id/auto-resume` (idempotent, `{cancelled: true}`, 404 for an unknown run), plus the same retirement riding `POST /runs/:id/archive`. Archiving is how a user resigns from a task, and a resigned task must never come back on its own.

## UI/UX

**Settings → Resources → Auto-resume after a usage limit** (below Monitoring wake-up): an On/Off select that saves immediately, hinted with what it actually does — waits for the reset the provider named, continues 30 seconds later, up to 12 times in a row, and Off leaves the task failed with its Continue button.

**The task list** — a waiting run is `failed` on the record, but it is not an outcome, and every list surface must say so. One decider each, so no two surfaces can disagree:

- `deriveAttention` → `scheduled`, amber, not pulsing, bucket `none` (`lib/attention.ts`). Not red, because the failure is about to undo itself; not in the `error` bucket, because it needs nothing from the user — which also keeps it out of notifications.
- `bucketOf` → **Working**, not Recent (`lib/task-groups.ts`): work in flight, never "Needs you".
- `statusWeight` → between `running` and `queued`, so the list reads as the pipeline in the order it will happen: needs-you, running, scheduled, queued, then the outcomes (done, failed, cancelled). The top of the list answers "what is happening, and what happens next?" without opening a row.
- `isUnread`/`isReadDoneItem` → neither (`lib/read-state.ts`): there is no outcome to have missed and no history to dim, so no unread marker, no nav-badge count, no dimmed row.
- The row and mobile card carry the appointment inside the pill (`scheduled 9:52 PM`, short date prefixed once it is not today; the full instant to the second on hover), the way a queued row carries its position.

**The thread dock** (`auto-resume-hint.tsx`), beside the paused/queued hints, exactly where the thread already answers "what is expected of me right now?" — and here the answer is "nothing":

> ● Usage limit reached — this task resumes automatically at **Aug 3, 2026, 7:00:30 PM GMT+2**  ·  [Don't resume]  ·  [Auto-resume settings]

Two ways out, both in the hint rather than in Settings: **Don't resume** retires the promise for this task alone (archiving does the same implicitly), and the link governs every future one.

The absolute instant is the source of truth (`<time dateTime>`), not a countdown: the wait is hours, the deadline is server-computed, and a ticking number would say less while re-rendering more. It is shown to the **second** with the zone named — matching the monitoring schedule line, and because minute precision cannot tell a wait that is nearly over from one that just started. The lifecycle line in the transcript carries the same local, to-the-second instant rather than a raw ISO string; the machine-readable copy is `RunRecord.autoResumeAt`. The settings link is the other half of the promise — an automation the user did not ask for has to be one click from being switched off. The component renders only when the server armed a resume, so it never has to reason about the off/no-instant/capped cases.

## Edge Cases & Failure Scenarios

- **No reset instant** — nothing scheduled, run plainly failed (Q2).
- **Reset already past** (a limit that lifted while the run was dying, or a restart after the deadline) — fires immediately.
- **User continues first** — `continueRun` retires the timer and the counter; the stale timer no-ops on its record re-check.
- **Cancelled / deleted while waiting** — the timer re-checks and no-ops; a deleted record simply is not there.
- **Setting switched off mid-wait** — the config PUT refreshes the semaphore, which pumps every manager; `reconcileAutoResumes` cancels the armed timers and clears their deadlines there, so the thread stops promising a resume that will never come. `recover()` honors the setting too.
- **Cap reached** — a note on the transcript, no schedule, Continue unchanged.
- **The resume itself hits the limit again** — a fresh instant, a fresh schedule, counter +1.
- **No session to resume** — refused up front rather than failing inside `continueRun`.
- **`continueRun` refuses at fire time** (the run moved on, the session went away) — the deadline is retired and a note says why. It must never be left in the past: a hint counting down to an instant that has already passed is worse than no hint, and it is the one state that makes the whole feature look broken.
- **The timer is lost without the record** (restart mid-write, rebuilt context, disposed manager) — the next `pump()` re-arms it from the record.
- **Archived while waiting** — the archive route retires the resume immediately, and no sweep re-arms an archived run however the deadline got there. Un-archiving does not re-promise one.
- **Several tasks parked by one window** — each carries its own deadline and its own off switch; cancelling one leaves the rest waiting.
- **A deadline missed by more than 24 h** — expires with a note instead of firing, so a sweep can only revive tasks someone is still waiting on.
- **The hint appeared only after a reload** — not this feature's bug, but it surfaced one: `useMarkRunSeen` fires the instant a run finishes (the busiest moment on the run stream) and its `onSuccess` wrote the answer's whole record into the run caches. That answer is a snapshot from before the arm, so it reverted `autoResumeAt` — permanently, since nothing refetches afterwards. The receipt now takes only `seenAt` from its own answer and leaves every other field to the stream, which is the general rule a mutation response should follow here.

## Risks & Impact Review

- **Cost:** each resume is a real turn, but it is the continuation of a task the user started, gated on a reset the provider named, and capped. Zero spend while waiting.
- **False positives:** the parser is deliberately narrow and requires BOTH a limit phrase and a usable instant; the Claude path requires the exact marker.
- **Rollback:** reverting drops the timers; the two record fields degrade to unread keys and the config key round-trips through `.passthrough()`.

## Testability

`scripts/mock-claude.mjs` grows `mock:limit`, emitting the real envelope with a reset `CEZ_MOCK_LIMIT_RESET_SECONDS` seconds out (default 60). The whole path — CLI wire shape → record `error` → parse → schedule → restart re-arm → resume — is exercised under `CEZ_DRY_RUN=1` with no login and no tokens, in `src/workflows/auto-resume.test.ts`, and is reachable by hand for QA the same way.
