# Execution plan — a saturated overlap band no longer pins the automation poll cursor

Issue: [#982](https://github.com/open-mercato/cezar/issues/982)
Slug: `automation-pinned-poll-cursor`
Branch: `fix/automation-pinned-poll-cursor`

## Goal

A GitHub poll automation whose 120-second overlap band alone holds `filters.maxRecords` events
must not stall forever: when a poll spends its whole budget and still hands back the cursor it was
given, the scheduler re-polls with a doubled budget until the cursor moves or the search API's
own 100-record ceiling is reached — and pays that climb **once per pinned cursor**, not once per
interval.

## Background — the fixed point (from #982)

Three behaviours compose:

1. `GithubPoller.poll()` evaluates a contiguous prefix of a `sort=updated&order=asc` search and
   takes its cursor from the **last evaluated observation**. When the whole budget lands inside
   already-seen events, the returned cursor is not later than the stored one.
2. `ProjectAutomationScheduler.check()` re-reads a 120-second overlap band
   (`overlapSince = cursor - 120_000`) and `laterCursor()` never moves the cursor backwards, so the
   stored cursor stays exactly where it was.
3. The search window `updated:>=<overlapSince>` is derived from that cursor, so the next interval
   asks the identical question.

The window cannot shrink and the budget cannot grow, so the automation polls forever, logs
`no-match`, and never fires. It is also expensive: `poll()` issues one `/timeline` REST call per
search hit, so a pinned 60-second automation can burn ~10,500 calls/h against a 5,000/h budget
shared by every agent run on the machine.

## Scope

- `packages/cezar/src/automations/github-poller.ts` — accept a one-call budget override so the
  scheduler can re-poll wider without mutating the stored definition.
- `packages/cezar/src/automations/scheduler.ts` — the ladder and the pinned-cursor marker.
- `packages/cezar/src/automations/types.ts` — the new optional runtime-state key.
- `packages/contract/src/automations.ts` — the same key on the contract's state mirror (one line,
  additive, keeps the two schemas honest).
- `packages/cezar/src/automations/task-template.ts` — clear the marker when an idle automation is
  re-baselined, alongside the other cursor bookkeeping it already clears.
- Tests: `github-poller.test.ts`, `scheduler.test.ts`.

### Non-goals

- The poll **lease/lock** and the failed-check reschedule delay — owned by PR #993 (issue #983).
- Runners, `workflows/run.ts`, server-install, forge, and the web cockpit.
- Changing the 120-second overlap band itself, or the `eligible` filter, or receipt de-duplication.
- Any new configuration key. The ceiling is the search API's, not an operator's knob.

## Implementation plan

### Phase 1: a one-call poll budget override

`poll()` reads `definition.filters.maxRecords` in three places (page size, the evaluated prefix,
and the `truncated` test). Fold them into a single resolved `maxRecords`, sourced from an optional
`GithubPollOptions.maxRecords` and clamped to `HARD_CANDIDATE_CAP` (100). The definition is never
mutated, so the stored automation and its revision are untouched.

### Phase 2: the scheduler ladder and the pinned-cursor marker

In `check()`, for `mode === 'execute'` with a stored cursor:

- **No progress** is `laterCursor(state.cursor, result.cursor) === state.cursor` — `laterCursor`
  returns its `current` argument by reference when the observation is not later, so this
  distinguishes "this poll made no progress" from "this poll found nothing new".
- While the poll made no progress **and** reported `truncated` **and** the budget is below 100,
  double the budget and re-poll. This cannot step over an event: `poll()` evaluates a contiguous
  prefix and takes its cursor from the last evaluated observation, so a wider budget only reaches
  further into the same ordered run.
- When the ladder ends at the ceiling still pinned, record the cursor it failed at in a new
  `pinnedCursor` runtime-state key. While the stored cursor still equals that marker, skip the
  climb entirely — a band saturated at 100 is at the search API's own ceiling and re-climbing it
  every interval costs far more than the stall it replaces.
- The cursor moving is the recovery path: any poll that advances the cursor clears the marker.

### Phase 3: tests and the validation gate

Unit tests for the fixed point, the escape, the once-per-pinned-cursor guarantee, and the
untouched ordinary path; then the full configured gate.

## Risks

- **A wider budget launches more tasks in one poll.** After the ladder clears a backlog, the poll
  can return up to 100 matching candidates instead of `maxRecords`. That is the intended recovery —
  those are genuine, never-launched events — and durable receipts still prevent duplicates. The
  schema already caps `maxRecords` at 100, so the ladder cannot exceed what an operator could have
  configured.
- **One slow poll.** The climbing poll costs roughly 2× the budget in `/timeline` reads (the
  reporter measured ~3× the usual duration for the first poll). It is bounded, paid once per pinned
  cursor, and strictly cheaper than a pinned automation re-reading its whole budget forever.
- **Touching a file PR #993 also touches.** Both change `scheduler.ts` and `scheduler.test.ts`.
  #993's hunks are the lease acquisition and the reschedule delay; this change lives between the
  `since` computation and the `setState` block, and adds its tests in a separate `describe`.

## Progress

PR: #1002

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: a one-call poll budget override

- [x] 1.1 Resolve `maxRecords` once in `poll()` from an optional `GithubPollOptions.maxRecords`, clamped to the 100-record cap — fb108557
- [x] 1.2 Poller tests: an override widens the evaluated prefix without mutating the definition — fb108557

### Phase 2: the scheduler ladder and the pinned-cursor marker

- [x] 2.1 Add the optional `pinnedCursor` runtime-state key to both state schemas and clear it on re-baseline — 5a62f2e3
- [x] 2.2 Climb the budget ladder in `check()` when a poll makes no progress while reporting truncated results — 5a62f2e3
- [x] 2.3 Record the cursor the ladder failed at, skip the climb while it still matches, and clear it when the cursor moves — 5a62f2e3

### Phase 3: tests and the validation gate

- [x] 3.1 Scheduler tests: the pinned fixed point, the ladder escaping it, the still-pinned-at-100 case not re-climbing, and an ordinary no-new-events poll unaffected — 5a62f2e3
- [x] 3.2 Run the full validation gate and refresh the PR body — 5a62f2e3


### Gate (run with `TMPDIR=/tmp TMP=/tmp` and the run's `CEZ_*` vars unset — see below)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | 390 files, 7180 tests, 0 failures, exit 0 |
| `npm run test:unit` | 36 pass, 0 fail, exit 0 |
| `npm run build` | exit 0 — `check:pack ok — 530 files, 88 under web/dist` |
| `npm run test:package` | 16 pass, 0 fail, exit 0 |

Inside a cezar task `TMPDIR`/`TMP` point inside the repo, so `mkdtemp`-based tests find a git repo
where they assert there is none, and the run's exported `CEZ_*` vars trip the zero-config prompt
tests. Neither is related to this change; the gate is run with both neutralised.
