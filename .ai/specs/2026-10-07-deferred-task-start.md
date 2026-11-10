# Implement: schedule tasks from the composer, including after usage limit reset

## 🎯 Change

Let users submit a new task now and have cezar start it **only after the selected account's usage limit resets** — even when the current window still has allowance left. This lets them keep the remaining allowance for their own interactive work and hand the next window to cezar.

The composer entry point was already requested in [#771](https://github.com/open-mercato/cezar/issues/771). This issue builds on that direction and adds a start time derived from the selected account's usage limit:

- Automatic resume after a usage limit (spec `2026-08-03-auto-resume-after-usage-limit`) continues a task that was **already interrupted** by an exhausted limit. It never defers a new one.
- The one-time `once` automation schedule ([#1260](https://github.com/open-mercato/cezar/pull/1260), part of [#771](https://github.com/open-mercato/cezar/issues/771)) starts a task at a **fixed wall-clock time** the user types. It knows nothing about usage limits, accounts or reset windows.

This issue adds the missing part: knowing when an account's limit resets, and turning that into a start time. It deliberately does **not** add a second scheduler. The wake-up, cross-process lease, receipts, cold-project launch and late-start rules all come from the automations infrastructure, extended by #1260.

### Expected behavior

The task composer gets a start selector:

| Option | Behavior |
| --- | --- |
| **Now** | Default; existing behavior, unchanged. |
| **Pick date & time** | Creates a one-time `once` start at the chosen time, from the composer. |
| **After usage limit resets** | Resolves the selected account's next confirmed reset and creates a one-time start at that instant plus a short grace period, bound to that account. |

A deferred task makes **no model call before its start time**: no title generation, no worktree, no check steps. The run is created only when the start time arrives, or after an explicit Run now action, through the ordinary launch path. At that point, the existing concurrency limits and account holds still apply.

The server and computer must be running at the start time; the browser tab may be closed. Late starts follow the existing automation age rule: up to 24 h late, the task starts once as a catch-up. Later than that, it does not start by itself and is shown as missed.

There is no new configuration, daemon or `CEZ_*` variable. With `CEZ_AUTOMATIONS=0`, both deferred options are disabled with an explanation, and **Now** works as before. A deferred choice never becomes the default for the next task.

The selected time is a **not-before time**, not a reservation of future allowance. Other tasks or activity outside cezar may use that allowance first; ordinary account holds and capacity limits still apply. Scheduling must preserve the chosen workflow, account, model, autonomy setting and review gates, rather than implicitly making the task autonomous.

## 📋 Scope

This issue delivers one complete capability, covering:

- **Show the real waiting reason.** A queued task that waits on an account hold shows “Waiting for usage limit reset · 18:00” instead of “Waiting for a free agent slot”. `accountHolds()` only returns the held account keys, so the time comes from the earliest future `autoResumeAt` of the run holding that account, looked up across the whole workspace (the holding run may belong to another project). An in-flight automatic resume shows “Waiting for this account's automatic resume” instead, because no reset is pending. The waiting reason is exposed through a typed read surface and updates live when a hold appears or clears, even though the queued run's own record does not change.
- **Defer from the composer at a chosen time.** The composer's start selector creates a `once` start from the composer body (depends on #1260). The task list shows pending deferred starts with **Run now**, **Change time** and **Cancel**. A task detail shows the full prompt, resolved workflow/model/account and start time. Creation, inspection, rescheduling, cancellation and error recovery never require the Automations view; user-facing messages call these scheduled tasks. Prompt and execution-setting editing are outside scope; changing them requires cancelling the pending start and submitting a replacement through the composer.
- **Start after usage limit resets.** Reset data for Claude and Codex, account binding, preview and the third composer option.

In scope: ordinary submission, execution of an approved plan (inline `steps`), and ×1–×3 variants.

Out of scope: recurring schedules (already shipped, #985), deferred Continue, changes to automatic resume, percentage thresholds, switching accounts to bypass limits, and reset data for backends other than Claude and Codex (follow-up). GitHub/bookmarklet entry and `cez task create` keep their current start behavior.

Option-specific limits:

- **Attachments:** automations do not retain uploaded images (same rule as #771). When the composer has attachments, both deferred options are disabled: “Attachments can't be kept for a later start. Remove them or start now.”
- **Linked todo:** a task started from a todo keeps **Now** only.
- **Plan first:** generating a plan happens immediately and uses tokens. Only executing the approved plan is deferred; the UI says so.

### Interface and example mockups

A clock button in the composer footer opens a non-modal popover. A selection takes effect immediately, with no Apply step.

**Start after reset while allowance remains:**

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Fix login form validation…                                               │
│ Starts after Claude · Personal's usage limit resets at 18:00.            │
│ [Agent/account ▾] [Model ▾] [◷ After reset · 18:01 ▾] [Schedule task →]  │
└──────────────────────────────────────────────────────────────────────────┘

Start
  ○ Now
  ○ Pick date & time
  ● After usage limit resets

    Claude · Personal
    Session limit (5 h): 82% used · resets today 18:00
    Weekly limit:       40% used · resets Mon 09:00
    Starts today at 18:01 or later, when an agent slot is free.
    Time zone: Europe/Warsaw (server time zone).
    Updated 12 min ago from your last task on this account.
```

Codex may report only one weekly window:

```text
Start
  ● After usage limit resets

    Codex · Work
    Usage limit (7 days): 10% used · resets Wed 14:02
    Starts Wed at 14:03 or later, when an agent slot is free.
    Time zone: Europe/Warsaw (server time zone).
    Checked just now.
```

**Choose a specific date and time:**

```text
Start
  ○ Now
  ● Pick date & time
  ○ After usage limit resets

    Date                Time
    [2026-10-14     ▾]   [14:30     ]
    Time zone: Europe/Warsaw (server time zone)
    Starts on Oct 14 at 14:30 or later, when an agent slot is free.

[Agent/account ▾] [Model ▾] [◷ Oct 14, 14:30 ▾] [Schedule task →]
```

For a past time, show “Choose a future date and time” next to the field and disable **Schedule task**. Selecting **Now** restores the ordinary start action.

**No reliable future reset time:**

```text
Start
  ● Now
  ○ Pick date & time
  ○ After usage limit resets                    unavailable

    No upcoming reset is known for this account.
    Claude usage information comes from previous tasks in cezar.
    Pick a date and time instead.
```

Opening the popover resolves local workflow eligibility and the server time zone without reading usage or starting an agent. Keep the reset radio visible but disabled, with an inline reason, for unsupported providers, unresolved accounts, and workflows spanning multiple accounts/providers. Resolve the whole workflow rather than trusting the composer runner alone. For supported Claude/Codex workflows, missing observations do not disable the check action: Claude reloads observations from prior Cezar tasks, while Codex can read usage without a model turn. Changing execution settings preserves the chosen scheduling mode and invalidates its preview.

Show the actual server time zone before date entry. An untouched empty date shows neutral guidance; after interaction, invalid fields show errors. Date preview is automatic, with Retry only after a failed check. The collapsed reset summary includes day, date, time and zone and wraps on narrow screens.

**Task list and deferred task detail:**

```text
Scheduled
  Fix login form          After limit reset · today 18:01
  Dependency report       Thu 07:00
  Old cleanup             Missed · Mon 07:00
  Release notes           Couldn't start · temporary launch error

Queue
  Auth middleware         #1 in queue
  Checkout tests          Waiting for usage limit reset · 18:00

                 Starts after the usage limit resets · today 18:01
                 Claude · Personal
                 [Run now] [Change time] [Cancel]

                 Couldn't start · temporary launch error
                 No run was created. Retry this scheduled start.
                 [Retry] [Change time] [Cancel]

                 Task settings changed · selected account was removed
                 Cancel this scheduled task and submit it again
                 with the intended settings.
                 [Copy prompt] [Cancel]
```

Required states:

| State | UI response |
| --- | --- |
| No Claude usage data | Disable the reset option; explain that the data comes from previous tasks; offer date & time. |
| Reset has passed / no reliable date | Disable the option; never guess the next window. |
| Reading Codex limits | Show a checking state; block **Schedule task** in reset mode until a result arrives. |
| Codex read failure | Show a clear error with **Retry** or date & time. |
| Workflow uses more than one account | “This workflow uses more than one account. Pick a time instead.” |
| Backend without reset data | “Usage reset information is not available for this backend yet. Pick a time instead.” |
| Automations disabled (`CEZ_AUTOMATIONS=0`) | “Later starts are turned off on this cockpit.” Only **Now** is available. |
| Attachments present | Both deferred options disabled, with the attachment message above. |
| Account on hold and Now selected | Show the real reset-related waiting reason. |
| Linked todo | Both deferred options disabled: “Tasks started from a todo can only start now.” |
| Server changes the proposed start | Show the refreshed preview and require confirmation; create nothing. |
| Launch failed / interrupted before a confirmed run | Keep the scheduled task visible with “Couldn't start”, a safe reason and the applicable recovery actions (Retry / Change time / Cancel for a transient failure; the replacement guidance below for an invalid binding). Reconcile existing runs before allowing retry; link to any run already created. |
| Account, model or workflow binding changed | “Task settings changed. Cancel this scheduled task and submit it again with the intended settings.” Show the saved settings and the detected mismatch. Disable Retry, Run now and Change time while the binding is invalid; allow cancellation and copying the prompt. A replacement requires a fresh composer preview and explicit submission; never silently use another account. |
| Cancellation loses a race with launch | “This task has already started” with a link to the run; do not report successful cancellation. |
| Start missed by more than 24 h | “Missed · Mon 07:00” with **Run now**, **Change time** and **Cancel**. |

Times are shown in the server's time zone, the same zone every automation schedule uses; the zone is always shown. Use the existing `zoned-time.ts` rules for user-entered wall times and display the instant they resolve to before confirmation. A provider reset is already an absolute instant: preserve it, add the grace period and round upward in UTC. Persist that authoritative not-before instant for composer-origin definitions; the existing automation runner must honor it across server-zone changes and repeated DST hours. Extend the `once` calculation in the shared scheduler for this case rather than adding another timer. A wall-time conversion must never move a reset-derived start earlier.

Accessibility: a radio group, labelled fields, dismissal with Escape or by clicking outside, focus restoration, errors linked through `aria-describedby`, and `role="status"` messages. Usage and times are always shown as text, never only as colours or bars.

<details>
<summary>Implementation details: building on `once`, reset data, API, safety</summary>

### Building on `once`

A deferred start is a `once` automation created from the composer, marked as such. It adds no parallel scheduling store, coordinator, timer or lease; the only new routes are the preview and create endpoints below.

- **Origin marker.** The definition gets an optional, additive `deferredStart` object: `origin: 'composer'`, `reason: 'at' | 'usage-reset'`, the confirmed absolute not-before instant, and the execution binding below. These fields are server-derived, not trusted from a generic automation update. Definitions without it behave exactly as today.
- **Prompt stored verbatim.** Schedule prompts reject unknown `{{…}}` placeholders and substitute `{{date}}`, `{{time}}`, `{{project}}` and `{{automation}}`. A composer prompt is user text: for `origin: 'composer'`, skip placeholder validation and substitution entirely. A prompt containing `{{user.id}}` must launch unchanged. Do not append the generic schedule instruction that nobody is available to answer questions. Preserve the composer's autonomy choice and normal question/review behavior.
- **Template.** Built from the composer body, reusing the `automationTaskSchema` fields: workflow or inline `steps`, model, runner, `agentProfile`, variants, worktree, autonomous, system prompt, dispatch. `images` and `todoId` are not part of a deferred start (see Scope). Extend the actual launch adapter to pass `agentProfile` through: the existing `startInput()` does not currently do so. Test the resolved account used by the runner, not just the stored template.
- **Name.** The definition name comes from the existing heuristic title, never from an LLM call. LLM naming happens on the run once it launches.
- **Launch.** At the start time, the existing schedule runner launches through `RunManager.startRun` / `startVariants`, with the usual schedule provenance on the run. Title generation, worktree creation and every model call therefore happen only after the start time, with no extra gate in the run manager.
- **Late start.** Use the existing age rule (`SCHEDULE_CATCH_UP_MS`): on time → launched, up to 24 h late → one catch-up, later → skipped and shown as missed.
- **Lifecycle and durability.** Pending → launching → launched, missed, or couldn't-start. A successful create response requires a completed definition write; write failure must not leave an enabled in-memory task. Guarantee process restart/crash recovery, without claiming power-loss durability. Remove the pending definition only after the run and receipt provenance are durably recorded; replace its UI row with links to the resulting run(s). Keep failed, missed and ambiguous launches visible. Reconcile reserved receipts and already-created runs before retry or cleanup, including partial ×3 launches; never repeat already-created variants. Cancellation removes only a start that has not been claimed. No automatic retry spends tokens after an ambiguous launch; the user resolves it explicitly with **Start missing runs** (relaunches only the run IDs recorded before launch that do not exist) or **Dismiss** (records the existing runs and launches nothing).

- **Run-index writer lock.** Every `runs.json` write takes a bakery lock in `runs/.index-writers/` (`lockRunIndex`). A ticket in the same process view (hostname, Linux PID namespace, boot-id format) is reaped only on proof: an earlier boot, this PID and thread but not the ticket being taken, a vanished PID, or a Linux start-time mismatch. A ticket from another view, or an unreadable one, has no PID evidence and is reaped once 5 minutes older than the reader's own ticket. So after a container restart behind a crash ticket, saves fail (2 s each) for up to 5 minutes. Residual: on macOS/Windows a same-boot crash ticket whose PID was reused waits until that process exits.
- **Execution guarantee boundary.** Creation-key replay and scheduler lease ownership do not establish global exactly-once execution. Ordinary queued-run recovery has no cross-process execution-owner fence: two independent cockpits recovering the same project can admit the same run. This inherited limitation remains outside the deferred launch lease. The no-repeat rule above applies while variant records remain available. During a partial ambiguous launch, deleting a completed variant (manually or through retention) removes the delivery evidence used by **Start missing runs**, which can execute that ID again; the UI explicitly warns about deletion. Use **Dismiss** after checking existing work if a run may have been deleted. Immutable per-variant delivery history and execution ownership are required before claiming the stronger guarantee across deletion and concurrent recovery.
- **Creation idempotency after cleanup.** Extend the existing automation persistence with compact creation records keyed by project and idempotency key: a digest of the original validated request, deferred-start ID, terminal outcome and all resulting run/variant IDs. Persist the mapping with creation, and persist its terminal result before removing a definition. Keep it while pending, failed or ambiguous and retain the compact terminal tombstone for the lifetime of the project's automation data, independently of receipt/log compaction or run deletion. Store no duplicate prompt or credentials. The same key and request returns the original outcome even after launch or cancellation; a different request returns 409. Replays never recreate a removed definition or launch a run. Check this mapping before revalidating an expired preview. Crash recovery must reconcile a partially written creation before arming anything. Clearing the project's automation data is outside this guarantee.
- **Visibility.** Composer-origin definitions appear in the task list's **Scheduled** group, not in the Automations list. Updates use the existing automation change events.
- **Run now / Retry / Change time / Cancel.** Serialize composer-origin mutations and launch claims through the existing automation lease, re-read current persisted state while holding it, and check the expected revision. Existing delete/run routes do not provide these guarantees today: extend them additively for composer-origin definitions while preserving ordinary automation behavior. Run now claims the same stable occurrence identity as the scheduled tick, not `manual:<now>`. A claimed launch cannot be reported as cancelled or rescheduled; return a conflict and the run link if available. A reschedule cannot revive a consumed occurrence. Retry reconciles the original receipt rather than allocating another launch. Run now explicitly waives the time restriction, never the account binding, normal holds or capacity limits.
- **Compatibility.** Keep normal `once` automation behavior unchanged. Document two downgrade cases: versions without `once` may discard the definition, and versions with `once` but without composer semantics can ignore its account/time binding. An additive marker alone cannot protect against an unaware executable. Pending composer starts must be cancelled or completed in a compatible version before downgrade or before running an older cockpit against the same project. State this limitation explicitly; do not claim safe mixed-version execution. Add compatibility fixtures for marker preservation and unchanged ordinary automation behavior.


### Reset and account binding

1. **Choosing the window.** Resolve the effective runner, account and model for every agent step, including per-step overrides. For each distinct model, select its applicable confirmed blocking windows; if none are blocking, select its applicable Claude five-hour window or Codex `primary` window. Combine these selections across all agent steps, deduplicate shared account windows and use the latest reset. A common account does not imply a common model limit. If a required window or its model applicability cannot be established reliably, reset mode is unavailable; never silently omit that step or substitute another model's limit. The preview identifies the contributing windows and the one determining the start time. Add `AUTO_RESUME_GRACE_MS` (30 s, the auto-resume grace) and round up to the next minute, since `once` is minute-precise.
2. **Labels.** `primary` is not necessarily five hours. Derive the label from `windowDurationMins`; use the neutral “Usage limit” when the duration is unknown. Missing secondary data is not an error.
3. **Bounds.** Reject a reset in the past, or more than `MAX_USAGE_LIMIT_WAIT_MS` (7 days) ahead, as “no reliable reset”. Provider data never schedules a task further out than that.
4. **Freshness and fixed submission time.** A cached Claude observation has no additional age cutoff: assess each required window independently and accept its observed reset only while it is future and within the seven-day bound. Show observation age and the contributing window; this is an observed reset, not a live allowance check or capacity reservation. New observations supersede older data before confirmation. After submission the confirmed not-before instant stays fixed. If a newer snapshot for the bound account confirms a later blocking reset, execution waits with a visible reason, without rewriting the confirmed time. Normal account holds and usage-limit handling still apply; refreshing never calls a model. The catch-up age is measured from the later hold deadline when one was recorded.
5. **One account.** The server resolves the effective runner and account of every step. Reset mode is only available when the whole workflow uses one provider/account binding; the server enforces this for direct API calls too.
6. **Execution binding.** At submission, pin the resolved runner, account, model and workflow content/revision, including per-step overrides, declarative dispatch/fork work and recursively referenced workflow content. Resolve child account and model defaults using their execution semantics. Missing references, cycles, more than 32 reference levels or 4096 expanded nodes fail visibly before creation. Compositions requiring multiple accounts for the same runner also fail visibly: the first-agent runtime binding is keyed by runner and cannot represent that ambiguity safely. At launch, revalidate them before any title/model call. The required binding is the account ID **plus** its resolved profile location (for the discovered default, the location it resolved to at submission). Pi has no per-provider profile: its native default is represented by account `default` with an empty profile path, and never requires the Claude directory used as a discovery fallback. Other providers still require their readable profile location. Where the provider exposes the signed-in identity without a model call (for example, Codex ChatGPT account metadata), compare it as well, and treat an unanswered check as transient rather than a changed login; where it does not (Claude, a Codex API-key login), the profile location is the binding, and the UI does not claim protection against a different login inside the same profile. If the account is removed, its profile location changes or cannot be read, a compared identity differs, or the workflow/model resolution differs, block with a task-visible reason. The user must cancel the pending start and submit a replacement with a fresh preview and confirmation; neither Retry nor Change time can replace its binding. Restoring the original binding permits Retry after validation. A partially launched or ambiguous occurrence must first be reconciled; do not offer replacement of the whole task as a safe retry of that occurrence. Never use the normal missing-profile fallback to another account. Do not store credentials in the binding. The binding gates the launch only — once the first agent step has started, later steps, Continue and recovery resolve accounts normally.
7. **Preview revision.** A change of account, model or workflow invalidates the preview, even when the time is unchanged. A detected change of the logged-in identity invalidates the stored snapshot. A change in the usage percentage alone does not. The revision covers the project, execution binding, complete set of selected model/limit windows and resolved not-before instant. Both preview and creation use one resolver; any subsequent update through automation routes must preserve these checks. Changing a reset-derived time manually converts the reason to `at` while retaining the execution binding.

### Usage limit data sources

| Backend | Source | Requirements |
| --- | --- | --- |
| Claude Code | `rate_limit_event` in the stream (optionally `unifiedWindows`) | Collect future resets, including with status `allowed`, from ordinary activity without an extra prompt. Do not assume every task emits the event; handle missing data and expired resets. |
| Codex | `account/rateLimits/read`, `account/rateLimits/updated` | Read metadata without creating a model turn. Handle a single weekly window (`windowDurationMins: 10080`) with `secondary: null`. |

- **Runner boundary.** Forward the events through a normalized, backend-neutral metadata callback, covering both execution modes and the account each step actually ran on. Keep backend types out of the manager. Document the callback in `AGENT_PROTOCOL.md` as an optional capability and cover it with golden fixtures.
- **Normalization.** Handle null values, partial updates, absent windows, usage above 100%, model-specific limits and `rateLimitsByLimitId` selection. Keep the source and the observation time. Do not copy a global rejected status onto every window, and do not treat `overageStatus: rejected` as a block when the main status is allowed.
- **Store.** Keep account snapshots in `~/.cezar/usage-windows.json`, resolved through `cezarHomeDir()`, written atomically with mode `0600` and read-modify-write merging, and covered by `assertCezarHomeWriteIsSandboxed`. A corrupt file or read-only home means “no data” plus one warning, never a boot failure. Store no raw messages, prompts or credentials.

### API contract

Every shape is a Zod schema in `packages/contract` with an inferred type. Project routes are chained into a family builder, validated as middleware, and get their `/api/v1` boot-project alias plus an inventory entry in `BACKWARD_COMPATIBILITY.md`. `POST /api/v1/p/:projectId/runs` does not change.

| Operation | Responsibility |
| --- | --- |
| `POST /api/v1/p/:projectId/deferred-start/options` | Composer execution settings. Returns server time zone and reset eligibility for the resolved workflow, without usage or identity probes. |
| `POST /api/v1/p/:projectId/deferred-start/preview` | Composer body plus `{ kind: 'at', date, hour, minute }` or `{ kind: 'usage-reset' }`. Resolves workflow, model and account with the same function as run creation. Returns the resolved start instant, the snapshot (reset mode) and an opaque `previewRevision`, or `{ available: false, reason }` where `reason` is one of `no-data`, `window-over`, `out-of-range`, `check-failed`, `unsupported`, `multi-account`, `attachments`, `linked-todo`, `account-unverifiable`, `automations-off`. |
| `POST /api/v1/p/:projectId/deferred-start` | Same body plus `previewRevision`. Re-resolves and creates an enabled composer-origin `once` definition. A changed execution binding, identity or start instant returns 409 and creates nothing. Creation requires a project-scoped idempotency key; replay lookup precedes preview validation and survives definition cleanup as specified above. Repeating the original request returns its deferred-start ID, outcome and any run links, even if its preview has since expired; a different request with that key returns 409. An invalid time or a reset that is unavailable returns 400. |
| Existing automation routes | Extend update/delete/run and receipt retry for composer-origin definitions with revision checks, shared-lease serialization and binding validation; preserve ordinary automation semantics. Expose state and run links through existing typed read surfaces so task views can show failures and recover them. |

- **Account identifiers.** `agentProfile` is resolved against the agent-account store and is never used as a path.
- **Codex reads.** The Codex read happens only inside the preview route, single-flight per account, with a short cache and a time limit. There is no GET route with a side effect.
- **Boundary checks.** Enforce attachments, linked-todo, backend/account and automations-enabled restrictions server-side, including generic automation mutation paths. Preserve existing host/origin and remote authentication guards. Bound preview input, subprocess runtime/output and concurrent reads; never accept an arbitrary profile path or executable from the request. Treat snapshot data as untrusted and escape provider-derived text in the UI.
- **No new bus topic.** Account usage data does not go on the WebSocket bus.

</details>

## ✅ Done when

- [ ] A queued task held by a reset deadline shows “Waiting for usage limit reset · HH:MM”, using the holding run's `autoResumeAt` even when that run is in another project; an in-flight resume shows its own message; the list and thread update live when the hold appears or clears.
- [ ] **Now** and all existing request shapes behave exactly as before; `POST /runs` is unchanged.
- [ ] A deferred start creates no run, title, worktree or model call before its time, including with LLM naming enabled.
- [ ] It launches once at its time with the browser tab closed, in a project not opened in the UI, through the existing schedule runner, subject to existing limits.
- [ ] Two compatible cezar processes competing for a start, cancellation, reschedule or retry produce at most one scheduler admission per retained variant; this does not certify the independent recovery path described above. Exercise real process contention, persisted-state reload and stale revisions, not only in-process mocks.
- [ ] Restarting before the start time keeps it. Up to 24 h late it launches once as a catch-up; later it shows as missed and launches nothing by itself.
- [ ] Run now, Change time and Cancel racing with a due tick resolve through the receipt and the `revision`; a stale request changes nothing.
- [ ] Repeating creation with the same idempotency key returns the original outcome before and after launch, cancellation, definition cleanup, receipt compaction and restart, even with an expired preview. Reusing it with a different body is refused. Run deletion does not turn a replay into a new launch.
- [ ] Create/write failure cannot report success or leave an armed in-memory start. Crash injection before/after run persistence, receipt finalization and cleanup preserves recoverability without duplicating created variants.
- [ ] After confirmed launch, the pending row is replaced by run links; failed or ambiguous starts stay visible with recovery actions, all without opening Automations.
- [ ] Composer-origin definitions stay absent from the Automations list; ordinary automations retain their existing behavior.
- [ ] Reset-derived instants remain not-before bounds across DST and server-zone changes; previews consistently label the server time zone.
- [ ] Scheduling preserves autonomy, questions and review gates and does not append the generic automation instruction to decide without asking.
- [ ] A prompt containing `{{…}}` text launches verbatim.
- [ ] Deferred options are disabled, with their messages, when attachments are present, the task comes from a linked todo, or `CEZ_AUTOMATIONS=0`.
- [ ] Works for ordinary submission, approved-plan execution and ×3 variants; does not leak into Continue or auto-resume.
- [ ] A Claude `allowed` event with a future reset and a verifiable account binding enables reset mode before exhaustion; missing or expired data triggers no model call.
- [ ] Codex covers checking, success, timeout/error, retry and a single weekly window without secondary data.
- [ ] An old Claude observation remains eligible until its required reset expires; missing/expired required windows disable reset scheduling. A newer confirmed block delays execution visibly without changing the confirmed time, including across restart.
- [ ] Normalization handles nulls, partial updates, usage above 100%, model-specific limits and overage without false blocking; resets outside the next 7 days are rejected.
- [ ] Account/model/workflow changes invalidate preview and are checked again at launch before model calls, including default-profile and per-step changes. Actual runner invocation uses the bound account; missing or unverifiable accounts never fall back. Generic automation updates cannot bypass these checks.
- [ ] A multi-account workflow submitted directly to the API is rejected in reset mode. A single-account workflow with two models selects the latest required reset across both models; missing required model-specific data disables reset mode.
- [ ] An invalid execution binding shows the mismatch and cancellation/replacement guidance in the task detail. Retry, Run now and Change time cannot bypass it. A replacement requires confirmed cancellation, a fresh preview and explicit submission; partial or ambiguous launches are reconciled first.
- [ ] `usage-windows.json` is `0600`, sandboxed in tests, and a corrupt or read-only file degrades to “no data”.
- [ ] The popover is keyboard-accessible, restores focus and exposes errors accessibly; mobile and both themes are checked in a browser.
- [ ] Typed-body, contract-parity, route-parity, versioned-surface and route-inventory tests pass.
- [ ] Regression tests for the no-model-call-before-start guarantee and for verbatim prompts are shown to fail without the fix.

Engine tests use a controlled clock and mocks. Provider fixtures cover a future reset with allowance left, missing data and partial updates.

## 🔗 Related work

- [#1260 — one-time `once` automation schedule](https://github.com/open-mercato/cezar/pull/1260): this capability depends on its one-time schedule support. Preserve its retirement behavior for every consumed occurrence, including duplicate receipts and detection-only launches, and surface the result in the scheduled-task view.
- [#1300 — auto-resume does not continue the remaining workflow steps](https://github.com/open-mercato/cezar/issues/1300): a multi-step task started after a reset can still hit a limit mid-run and rely on auto-resume, so it is affected by this bug. Not a blocker for this issue.
- [#771 — postponed and recurring scheduled tasks](https://github.com/open-mercato/cezar/issues/771): already requests composer-based postponed tasks; this issue implements that entry point using automations and adds usage-reset scheduling.
- [#846](https://github.com/open-mercato/cezar/pull/846): closed after review asked to extend `automations` instead of adding parallel scheduling infrastructure. This issue follows that direction.
- [#985](https://github.com/open-mercato/cezar/pull/985) / [#971](https://github.com/open-mercato/cezar/issues/971): recurring schedules, out of scope here.

Compared with #1260, this adds the composer entry point, usage-limit data from Claude and Codex, reset-derived start times with account binding, and a visible waiting reason for account holds.

Risk is `risk-high` because this widens a persisted automation definition and adds HTTP routes, both protected surfaces (`BACKWARD_COMPATIBILITY.md` §2 and § Automations): additive and optional only.

Depends on #1260. Refs #771, #1300.

If this direction makes sense, I'd be happy to implement these changes.
