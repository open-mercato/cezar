# Deferred task start — UX review and handoff

Prepared using `om-ux-shape` (open-mercato/skills, commit `3fc5a1f`), in **Review**, then **Handoff** mode. Covers the [specification](../2026-10-07-deferred-task-start.md) and [mockup](../assets/deferred-task-start/index.html).

Project contract: the repository has neither `.uxproof/` nor `UX_REVIEW.md`, so `[PRODUCT]` tags refer to the cockpit code, specification and AGENTS.md. The author's judgments are marked `[ASSUMPTION]`.

> **Revision 2 (October 7, 2026, evening).** The first version recommended removing the “after usage limit resets” option. That recommendation misunderstood the need: I assumed it was about completing a task after exhausting a limit. The actual goal is to **deliberately start a new task only in the next usage window**, even when the current window is not exhausted. A second mistake was assuming cezar could not know the reset time for an account below its limit. It can; the sources are described under “How cezar knows the reset time” below. This revision corrects both assumptions.

> **Update, October 8, 2026:** specification v4 applies. Claude and Codex reset sources were confirmed live (§12–§13 of the specification). Codex can return a single seven-day window without a secondary window; mockup scenario 05 covers that case. Earlier references to a required spike are historical. `Plan first` consumes tokens while writing the plan; scheduling defers execution of the approved plan. Title generation for deferred tasks also waits until the scheduled time.

## 🔍 Verdict: keep, with one scope change

Keep all three start options: **Now**, **Pick date & time**, **After usage limit resets**. The third lets users preserve the current usage window for their own work and allocate the task to the next window. It must show **the evidence behind its timing**: usage, reset time and observation age. Without those details, users cannot judge whether waiting is worthwhile. Version 1 of the mockup did not show them.

### How cezar knows the reset time — evidence from local binaries

| Backend | Source | Contents | Cost |
|---|---|---|---|
| Claude Code 2.1.291 | `rate_limit_event` in the `stream-json` stream cezar already reads (`claude-ui-mapper.ts` skips it in the `default` branch) | `status` (`allowed` / `allowed_warning` / `rejected`), `resetsAt` (Unix seconds), `rateLimitType` (`five_hour`, `seven_day`, …), `utilization`; also `unifiedWindows.five_hour/seven_day` with `utilization` and `resetsAt` (marked `@internal` in the schema) | No additional model call, if the event arrives during a task |
| Codex CLI 0.154.0 | App-server method `account/rateLimits/read` and notification `account/rateLimits/updated` | `primary` / `secondary`: `usedPercent`, `windowDurationMins`, `resetsAt` | No tokens; one short-lived app-server process on demand |

`[PRODUCT]` — these shapes were read from schemas embedded in the installed binaries (`claude.exe`, `codex`), **not** from a live stream. At the time of this review, I found no recording of a real `rate_limit_event` on disk. That made live verification the highest-priority next test.

Claude limitation: cezar cannot independently request limits without sending a model request, which would consume tokens and **open a new window**. It therefore knows only the state observed during the last task on that account. Terminal activity outside cezar is invisible to it.

### ✅ What works

- A pill in the composer footer beside Source/Runner/Model follows the `PickerPill` pattern. `[PRODUCT: new-task.tsx]`
- “No earlier than” semantics, no slot reservation, persistence across restarts and waking without an open tab. `[PRODUCT: spec §6]`
- “Run now” is the only action that removes the delay, distinct from “Cancel task”.
- A past-time error preserves the draft and does not silently switch back to Now.
- The task remembers the account whose usage window it awaits. Changing the account in Settings does not move the task.

### 🔍 What to change (worst first)

1. **The reset option does not show its evidence.** `[ASSUMPTION]`, but directly follows from the goal: deciding whether to wait depends on usage and timing.
   - Proposed replacement: below the option, show two window rows with usage and reset times, plus observation age (*Updated 12 min ago*). Explain old or missing observations without guessing.
2. **Polish labels in a cockpit without i18n.** `[PRODUCT: no i18n in packages/web; existing copy such as “Usage limit reached — this task resumes automatically at …”]` → use English throughout.
3. **Two confirmations for one choice (modal + “Apply” + “Schedule”).** `[HEURISTIC: Nielsen — flexibility and efficiency of use]` → use a non-modal `Popover`, already present in the composer; apply the selection immediately and confirm once with the main button. Remove the ambiguous “Cancel” action.
4. **Account holds are invisible.** `[PRODUCT: QueuedPlaceholder in task-thread.tsx]` A task waiting for a reset after hitting a limit says “Waiting for a free agent slot”. → *Waiting for usage limit reset · 18:00*. This does not replace the third option; it shares the same data and copy.
5. **Three buttons in every list row.** `[ASSUMPTION]` → show the time in the row and put actions in the task thread.

### 📋 Simpler flow

1. Place `◷ Now ▾` after the model pill.
2. “Start” popover: `Now` / `Pick date & time` / `After usage limit resets`; selections apply immediately.
3. For resets, show the account, usage windows, start time and observation age.
4. Show a status line above the footer; submission says “Start task” / “Schedule task”.
5. List and thread: *Scheduled · Thu 09:30* / *After limit reset · 18:00* / *#N in queue*.

### 🧪 Next test

1. **Technical spike first (half an hour):** run one Claude task with `CEZ_DRY_RUN=0` and capture raw `stream-json`. Does `rate_limit_event` arrive with status `allowed` and `resetsAt` for the five-hour window? Perform the equivalent check with Codex `account/rateLimits/read`.
   - Yes → use the scope below.
   - Only with `allowed_warning`/`rejected` → the Claude option works only near the limit; otherwise show “No current limit data” and offer date/time selection. The product owner decides the scope.
2. **User test after the spike:** give participants the mockup and this task: “You have used 80% of the current window. Schedule a task without consuming the remainder.” Success: the participant selects the reset option and can explain when the task will start.

### ⚠️ Not covered

No analytics on how often users hit limits. Plan first was assessed only through one help-text line. Mobile was covered only in the mockup.

### 🧪 Evidence limits

Cockpit and engine code were inspected. Usage-limit event schemas were read from binaries without live observation. The mockup was checked in jsdom and headless Chromium, not in the real cockpit.

---

## 📝 Deferred task start — handoff

**Intent**: submit a task now and start it no earlier than a selected time, or only after the selected account's usage window resets.
**Non-goals**: recurring schedules (automations), starting after another task, CLI, deferred Continue, switching accounts, or calling a model solely to discover limits.
**Actor and trigger**: a person submitting a task in `New task` (`packages/web/src/routes/new-task.tsx`) or starting an approved plan.

### 📋 Behavior

1. Composer footer, after `Model`: `StartPill`, label `◷ Now`, `aria-label="Start time: Now"`.
2. Clicking opens a “Start” `Popover` with radio options:
   - `Now` (default),
   - `Pick date & time` → `Date`, `Time`, with `Europe/Warsaw (UTC+02:00)` below,
   - `After usage limit resets` → account panel described below.
   Changes apply immediately; Escape or an outside click closes the popover and returns focus to the pill.
3. Reset panel for the selected account (for example, `Claude · Personal`):
   - `Session limit (5 h)  82% used · resets today 18:00`
   - `Weekly limit  40% used · resets Mon, Oct 12, 09:00`
   - `Starts at 18:00 or later, when an agent slot is free.`
   - `Updated 12 min ago from your last task on this account.` (Claude) / `Checked just now.` (Codex)
4. Which reset: the next reset of the window **blocking** the account (status `rejected`); if none blocks it, use the five-hour window (Codex: `primary`). When the weekly window is exhausted, say: `Weekly limit is used up. The task starts after it resets on Mon, Oct 12, 09:00.`
5. Pill labels: `◷ Now`, `◷ Tomorrow 09:30`, `◷ After reset · 18:00`.
6. At most one status line above the footer (`role="status"`):
   - Invalid time: *That time has already passed. Pick a later time.*
   - Date: *Starts no earlier than Thu, Oct 8, 09:30 (Europe/Warsaw).*
   - Reset: *Starts after Claude · Personal’s usage limit resets at 18:00.*
   - Now with an account hold: *Claude · Personal hit its usage limit. New tasks wait until it resets at 18:00.*
7. Submission `aria-label`: “Start task” or “Schedule task”; Plan first: “Plan task”, with popover help text *The plan is written now. The time applies when you start the approved plan.*
8. Toast: *Task scheduled for Thu, Oct 8, 09:30.* / *Task scheduled for after the usage limit resets (18:00).*
9. List: *Scheduled · Thu 09:30*, *After limit reset · 18:00*; once due, the usual *#N in queue* or *Waiting for usage limit reset · 18:00*.
10. Thread (`QueuedPlaceholder`): heading based on the waiting reason, plus **Run now**, **Change time**, **Cancel task**.

### 📋 States

| State | Trigger | What the user sees | What they can do |
|---|---|---|---|
| Default | Composer opens | `◷ Now`, no status line | Start task |
| Reset known | Fresh observation, five-hour window active | Two-window panel, *Starts at 18:00 or later…*, *Updated 12 min ago…* | Schedule task |
| Weekly used up | Weekly window is `rejected` | *Weekly limit is used up. The task starts after it resets on Mon, Oct 12, 09:00.* | Schedule task, select another account |
| Window already over | Last `resetsAt` has passed | *The last limit window ended at 13:00, so this account’s limit has likely renewed. Start now, or pick a time.* Option disabled | Now, Pick date & time |
| No data (Claude) | cezar has not observed the account's limits | *Cezar learns this account’s limits from its tasks. Run one task on it first, or pick a time.* Option disabled | Now, Pick date & time |
| Checking (Codex) | Read in progress | *Checking usage limits…* (skeleton) | Wait, select another option |
| Check failed | Read failed | *Couldn’t check usage limits.* + `Retry` | Retry, Pick date & time |
| Account changed | Different `RunnerPill` selection | Panel reloads for the new account; the previous result never overwrites the new one | As above |
| Reset moved | Server knows a different reset than the preview | *The reset time changed to 19:00. Schedule for 19:00?* Submission waits for confirmation | Confirm, change selection |
| Past time | Date ≤ now | *That time has already passed. Pick a later time.* Submission disabled; draft preserved | Change time |
| Nonexistent DST time | 02:30 on the clock-change date | *This time doesn’t exist in Europe/Warsaw on Mar 29. Pick another time.* | Change time |
| Save failed | 500 | Toast: *Couldn’t schedule the task. Nothing was started.* | Retry |
| Scheduled (thread) | Future `notBefore` | *Scheduled for Thu, Oct 8, 09:30* or *Starts after the usage limit resets · 18:00*, plus *Claude · Personal · starts automatically, even with this tab closed* | Run now, Change time, Cancel task |
| Due, account held | Due time passed; account on hold | *Waiting for usage limit reset · 18:00* | Cancel task |
| Edit too late | PATCH after `starting` | Toast: *This task has already started. Its start time can’t be changed.* | — |
| Account removed | Account no longer exists | `failed`: *The account this task was scheduled on no longer exists. Pick an account and start it again.* | Continue with another account |

### 📋 Assumptions to confirm

- `[ASSUMPTION]` Claude emits `rate_limit_event` with `resetsAt` even when `allowed` (spike).
- `[ASSUMPTION]` `unifiedWindows` (`@internal`) may be absent; then show only the window described by public fields (`rateLimitType`, `resetsAt`, `utilization`), without a second row.
- `[ASSUMPTION]` Codex `account/rateLimits/read` works without consuming tokens or opening a model session.
- Usage snapshots belong to accounts, not projects: store them under `~/.cezar/` through `cezarHomeDir()`. They may be written but must never be required.

### ✅ Acceptance criteria

- Given a fresh Claude snapshot (82% / reset 18:00), when I select *After usage limit resets*, I see both windows, *Starts at 18:00 or later…* and observation age; the pill shows `◷ After reset · 18:00`.
- Given the last reset has passed, selecting this option shows it disabled with an explanation about the renewed limit; Now and date/time selection remain available.
- Given no Claude account data, cezar makes no model request and disables the option with an explanation.
- Given an account change while the previous account's read is in progress, the previous result never appears in the panel.
- Given a task scheduled after reset, when 18:00:30 passes and a slot is free, the task starts exactly once, even with the tab closed.
- Given a past time, submission is disabled, the draft remains and the selection does not revert to Now.
- Given the popover was opened with the keyboard, Escape closes it and returns focus to the pill.
- A task waiting for reset never says “Waiting for a free agent slot”.
- All UI text is in English.

### ⚠️ Open decisions

- The product owner decides Claude scope if the spike shows events only near the limit.
- Does an on-demand Codex read (app-server process and network activity when opening the option) require a `CEZ_*` flag? AGENTS.md makes exposure-increasing features opt-in. Here an explicit user action triggers the read, so the recommendation is no flag, subject to owner confirmation.

### 🧪 Evidence limits

Usage-data shapes came from schemas in binaries, not observations. `unifiedWindows` is internal and may disappear in later Claude Code versions. The copy was not tested with users.
