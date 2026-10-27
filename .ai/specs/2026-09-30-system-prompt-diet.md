# System prompt diet — compose what a session can use, compute what the engine already knows

> Slug: `system-prompt-diet` · Status: implemented · No new env var, no new route, no default flipped
> Amends: `2026-09-10-dispatch.md` (§Prompt, §CLI, A2), `2026-09-13-automations-from-prompt.md` (the prompt part)

## TLDR

Every agent session in a cockpit opens with the same fixed blocks: the dispatch contract, the
automations contract and the handoff contract, ~12.7 k chars (~3.2 k tokens). A dispatched child
gets the root's fan-out tutorial, and the automations tutorial it has no use for. Both tutorials
carry a flag-by-flag CLI reference that the CLI's own `--help` can print when it is needed.
Several facts the prompt asks the model to work out are ones the engine already has: which
changed files fall outside a child's declared scope, whether a report was dropped, and how many
retries a child has used.

After this change:

- A root keeps a shorter dispatch block: when to dispatch, disjoint scopes, commit first, how
  reports are validated, the Guard. It covers the decisions and leaves out the flags. The full
  flag reference is `node "$CEZ_BIN" task --help`, which now prints every flag with its meaning
  and works without a cockpit behind it.
- A dispatched child gets a short "you were dispatched" block: its order is the assignment, report
  with `cez task report`, the Guard, the tree directory. It is not taught to fan out, but it can
  still dispatch: one line points at `cez task --help`.
- The automations block is one paragraph plus `cez automation schema` / `--help`, and is composed
  only for a root the user started. A dispatched child and a task an automation launched get none.
- At settle the engine compares the child's changed files with its declared `scope` and attaches
  a one-line verdict to the report the parent receives.
- `retry_limit` is enforced: it caps how many times cezar auto-continues the child after a turn
  that ended unfinished.
- Reports beyond the 20 kept pending are counted and replaced by one pointer line.
- `cez task list` / `cez task tree` accept `--json`.

## Resolved assumptions

| # | Question | Applied default | Why |
|---|---|---|---|
| D1 | Who gets the dispatch block | Unchanged gate (`dispatchReachable()`: flag on AND `CEZ_API_URL`). A run whose record has no `dispatch.parentRunId` (a root, or a plain task that may become one) gets `DISPATCH_PROMPT`. A dispatched child gets `CHILD_DISPATCH_PROMPT`. The review addendum and the intent block compose as before. | Any task may become a root on its first dispatch (dispatch spec A3), so a root cannot be told less than how to decide. A child's job is its order. |
| D2 | "Unless its depth allows further dispatch" | The engine has no depth limit, so every child may dispatch. The child block has one line ("independent parts you could hand off: `cez task --help`") in place of the tutorial. `cez task create` prints the monitoring instruction on success. | Adding a depth cap would be a new brake and a behaviour change outside this diet. Removing the child's ability to fan out would take away a working mechanism. A pointer keeps the ability and drops the cost. |
| D3 | Where the flag reference lives | `cez task --help` (also `cez task help`, `cez task create --help`): one line per flag, `--flag <value>  meaning`, including the rules the prompt used to carry (budget carve-out, inherited runner/model, cap of 4, commit before dispatching). Help no longer needs `CEZ_API_URL`. | An agent reads the reference when it is about to dispatch. Before this change `cez task create --help` refused without a cockpit, which is also the case where an agent most needs to read it. |
| D4 | Who gets the automations block | `automationsReachable()` AND no `dispatch.parentRunId` AND no `automation` / `automationTrigger` provenance on the record. This is a default-path behaviour change, not only a size cut: a scheduled task whose template asks it to set up another automation no longer gets the block that teaches it how (the skill still lists). | A child has an order to do, not automations to create. A task an automation launched runs unattended, and an automation creating automations is a loop nobody asked for. The `create-cezar-automation` skill is unchanged and still lists wherever automations are reachable. |
| D5 | Scope check | `scope` is persisted on the child's `dispatch` record. When a scoped child reaches `settleSuccess`, one `git diff --name-only <merge-base>` in its worktree lists the changed files. Scope tokens (split on whitespace, commas and semicolons) lose surrounding quotes, brackets and trailing sentence punctuation (`.,:;`) and a leading `/` or `./`; a bare `/`, `.` or `*` means the whole repository. Every token is matched by prefix, up to the first glob metacharacter, so a bare directory name (`docs`) keeps its share of a mixed scope. An `outside` verdict, though, needs at least one token that clearly names a path — a glob, a trailing slash or a file extension; when the scope is all bare words or slash-prose ("and/or the auth module") and every file reads outside, the verdict is `not checked — the scope names no unambiguous paths`, never a false `outside`. The verdict (`scope check: all N changed files inside the declared scope` / `K of N changed files outside the declared scope: a, b, c` / `not checked …`) is stored as `dispatch.scopeCheck` and attached to the settle report and the pending-report block. A settle other than `settleSuccess` (failed, cancelled) has no verdict. | Scope is free text (`dispatchInputSchema.scope`, max 1000). Globs appear in examples, but nothing interpreted them, so they are not a feature yet and `picomatch` is not added. Prefix matching up to the first wildcard can only err towards "inside", and the all-outside fallback keeps a prose scope from flagging every file; a false "outside" would send the parent after work that is correct. The extra git call runs only for scoped children, and only at settle. |
| D6 | `retry_limit` | Enforced. Persisted as `dispatch.retryLimit` on the child. `tryAutonomousNudge` caps a child's auto-continues at `min(MAX_AUTO_CONTINUES, retryLimit)`. When the cap is hit, a note is written and the run parks at `waiting` on the same path the 40-nudge cap already uses, so the idle timeout still closes it. The park is durable (`dispatch.retryLimitReached`): a session that closes without the agent finishing settles the run `failed` (the run-status word for unfinished), and the report the parent reads is `partial`, so a retry ceiling is never mistaken for a finished task. The marker is retired by any non-nudge wake — a delivered user message, a child's report, a monitoring wake (all through `deliverMessage`) — and by a `CEZ:DONE` turn, so a run finished with the user's help settles `done`; the capped nudge is the one wake that does not retire it. The task-order line explains the meaning. The cap and its note are per session, like the 40-nudge cap: `autoContinues` restarts at 0 when a human Continue opens a new session, so the child may be auto-continued up to `retryLimit` times again and the note is written again when it hits the cap. | "Enforce if feasible". An auto-continue is the only retry cezar performs on a child's behalf, and the flag's range (0–3) fits it. An unenforced brake was worse than either choice. |
| D7 | Dropped pending reports | `withPendingReport` counts what it trims into `dispatch.droppedReports`. `pendingReportsBlock` appends one line (`N older reports are not repeated here — read units/*/report.md in the tree directory`). The flush clears both fields. | Before this change they were dropped silently. The files are already on disk. |
| D8 | `cez task list/tree --json` | A JSON array, root first then depth-first, of `{id, parentRunId?, depth, status, title, branch?, costUsd?, kind?, report?: {status, verdict?}}`. | An agent reads it to decide what to do next, and parsing a formatted tree is error-prone. |
| D9 | Parent's validation instruction | The report carries cezar's diff size, cost and scope check, so the parent does not re-derive them. It still reads the child's diff and runs the tests the report names before merging, and re-runs the checks after each merge. | The engine measures diff size and scope membership (`engine.ts` `childSettleReport`); it neither reads the diff nor runs tests (see Not done), so checking the claim stays the parent's job. |
| D10 | Legacy child records | A child created before this change carries the old full `DISPATCH_PROMPT` as its extra `systemPrompt`. A Continue on it composes that text plus the new child block, because `dispatchPromptPart` no longer finds an exact duplicate. This is accepted: it affects only children already in flight across the upgrade, for as long as they stay open — once such a child settles and is not continued again, nothing carries the old text. No migration rewrites the stored prompt. | Matching the legacy text would be a special case with no end date. |

## The default-path diff

With every setting at its shipped default (`CEZ_DISPATCH` on, `CEZ_AUTOMATIONS` on, cockpit
running, `CEZ_FOLLOWUPS` off):

| Scenario | Before | After |
|---|---|---|
| Quick-task root, first session | dispatch tutorial (5 058) + automations (2 778) + handoff (4 885) | shorter dispatch block + automations paragraph + handoff (unchanged) |
| Continue of a root | same as above | same as above (both session sites use one resolver) |
| Dispatched implement child | full tutorial (as extra prompt) + automations + handoff | child block + handoff |
| Dispatched review child | tutorial + review addendum + automations + handoff | child block + review addendum + handoff |
| Headless `cezar run` | handoff only | handoff only (unchanged) |
| Task launched by an automation | tutorial + automations + handoff | shorter dispatch block + handoff |
| `cez task create --help` without a cockpit | refused, exit 2 | full reference, exit 0 |
| Child with `--retry-limit 1` | up to 40 auto-continues | 1 auto-continue, then parks (note says why) |
| Child with `--scope` | report has no scope information | report ends with a `scope check:` line |
| Parent with more than 20 unread reports | oldest dropped silently | one pointer line to `units/*/report.md` |

What still works as before: the transitions out of every state (monitoring wake, idle timeout,
the budget brake), the Guard, the in-flight cap, budget carving, the intent block, the review
addendum, the `create-cezar-automation` skill, `cez automation schema`. No state was added
without an exit, because the retry cap reuses the existing cap's park.

## Contract (`packages/contract/src/dispatch.ts`)

Additive, all optional on `dispatchSchema`: `scope`, `retryLimit`, `scopeCheck`,
`droppedReports`. On `dispatchPendingReportSchema`: `scopeCheck`. An old `runs.json` still parses,
and an old consumer ignores them.

## Not done

A depth cap on nested dispatch (D2). Engine-run test commands for a child (the order carries no
declared command). Glob semantics for `scope` (D5). A scope verdict for a failed or cancelled child.
