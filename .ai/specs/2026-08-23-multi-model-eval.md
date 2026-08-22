# Single-model vs multi-model eval (zero-config lineup)

Status: approved 2026-08-23. Evidence for the `feat/multi-modal` pull request.

Predecessor: `om-eval-sandboxes/eval-protocol.md` (2026-08-06, 10 tasks × 2 arms). This
run replaces its lineup with one that needs **no `.ai/agentic.config.json` at all** —
every seat is reachable from a CLI the user has already logged into. That is the claim
under test as much as the quality gap is: a user who installs cezar, logs into Claude
Code and Codex, and authenticates OpenCode Zen can field a three-family council from the
composer without writing a config file.

## Why this eval exists

The predecessor's council used two `agentHarness` advisor bindings (`deepseek`, `mimo`),
so its result could not answer "what does a user get out of the box". It also left
`claude/haiku` unprobed (CLI login blocked in non-interactive shells), so the host family
was never measured as a seat.

## Prerequisite: the OpenCode reviewer guard

The lineup below cannot start on the branch as it stands. Both the driver preflight
(`src/harness/driver.ts`) and the start route (`src/server/server.ts`) refuse **any** role
bound to the `opencode` runner:

> harness start blocked: OpenCode cannot enforce Cezar's stage-only isolation; use Claude,
> Codex, or a configured advisor

Verified against the running server on 2026-08-23: the exact lineup below returns 409, no
run created (the guard fires before worktree creation).

The refusal is correct for **orchestrator** and **implementer**. Those run as agent
sessions that write to the worktree, and cezar has stage-only enforcement for Claude
(`claude-guard.ts`) and Codex (workspace-write sandbox) but nothing equivalent for
OpenCode.

It is **wrong for reviewers**. A reviewer is not an agent session: `reviewer-binding.ts`
translates a picker-chosen `opencode/<model>` reviewer into a single structured Zen call,
with no config entry, and `driver.ts` dispatches it through the same council op the
configured advisors use. That module exists precisely because the session path does not
work for small models — measured on the same day, same spec, same model:
`mimo-v2.5-free` answered in 62 s as an advisor and timed out at 30/60/60 minutes as an
agent session. The blanket guard runs first and never lets a reviewer reach it.

A second defect falls out of the same place: the Multi-model composer offers OpenCode
models for every role, **defaults** the orchestrator to one (`opencode/claude-fable-5`),
probes it green, and enables Start — on a lineup the server always refuses. The option
list excludes only `pi` (`new-task.tsx`).

### Fix, in this PR, before the eval runs

1. Narrow the guard in both places: refuse `opencode` for orchestrator and implementer
   unconditionally; refuse it for a reviewer only when `synthesizeReviewerBinding` returns
   `null` — a bare model id with no gateway prefix, which has no structured path.
2. Stop the composer offering OpenCode for orchestrator and implementer. Reviewers keep
   it, because after (1) it works.
3. Regression tests for both halves: a reviewer-seated `opencode/<model>` starts, an
   orchestrator-seated one still 409s, and the composer's role options reflect the split.

Without this fix the eval would need a hand-written advisor binding in eval-app, and no
user arriving through the UI would have one — the result would not describe the product.

## Arms

| | Arm A — single | Arm B — multi |
| --- | --- | --- |
| Workflow | `quick-task`, isolated worktree | `harness-implement-feature` |
| Orchestrator | — | claude / haiku, effort **low** |
| Implementer | claude / haiku | codex / gpt-5.6-luna, effort **medium** |
| Reviewers | none | claude/haiku (low) · codex/gpt-5.6-luna (medium) · opencode/muse-spark-1.2-contributor-free (medium) |
| Families in council | — | anthropic, openai, opencode (3) |

Every seat rides a subscription or a free tier: Claude Code and Codex CLI logins, and
OpenCode Zen's contributor-free Muse Spark. Effort is a harness-role concept only — the
`quick-task` payload carries no effort field — so arm A runs haiku at the backend default.
That gives the single arm *more* thinking budget than arm B's haiku seats, which biases
the comparison toward arm A and against the claim being made.

Reviewer family resolution: `familyByModelName` has no `muse` pattern, so Muse Spark takes
its gateway as family (`opencode`). Distinct from `anthropic` and `openai`, so quorum
(≥2 completed, ≥2 families) holds even if one seat fails. The label is honest about what
is known rather than guessing a vendor.

## Tasks

Five vertical-slice features from the predecessor's bank (`eval-tasks.json`), chosen so a
cheap single model can fail in *distinguishable* ways. A task qualifies when it crosses
codegen, tenant/organization scoping, a read-only framework boundary, and test authorship
at once — pure-logic tasks separate the arms too weakly to be worth a run.

| Id | Title | Why it discriminates |
| --- | --- | --- |
| T9 | priority field | entity + enum validation + generated schema + sortable UI column |
| T3 | archived flag + filter | schema change plus a default-hidden filter that is easy to get half-right |
| T10 | bulk complete | carries an explicit cross-organization scoping invariant a reviewer can catch |
| T6 | CSV export | escaping edge cases — subtly wrong is the likely failure, not obviously broken |
| T5 | faq module | the heavyweight: a whole new module, tests generalization beyond in-module edits |

Excluded: T4 (title validation — too easy), T7 (stats — thin), T8 (pagination — its output
is already merged into eval-app's baseline).

5 tasks × 2 arms = **10 runs**.

## Measurement

Per run, eight dimensions. Model self-reports are recorded and never trusted.

1. **Containment** — is the staged diff in the run's own worktree, or did it escape to the
   main checkout? (The predecessor's headline single-arm failure.)
2. **Gate** — `yarn generate && typecheck && lint && test`, re-run post-hoc in an isolated
   measurement worktree off the same baseline, for both arms identically.
3. **Honesty** — the run's own success claim against (2). A false success report is the
   metric the harness exists to eliminate.
4. **Tests** — written, and green when actually executed.
5. **Cost** — USD and output tokens from cezar's usage rows.
6. **Wall clock** — submission to terminal state.
7. **Council signal** (arm B) — rounds, findings by severity, per-reviewer completion and
   timeout counts. Per-seat reliability is a result in its own right: the free Muse Spark
   seat is the one at risk, and quorum is what makes that survivable.
8. **Scope discipline** — files touched, and whether framework packages stayed read-only.

## Protocol

- **Baseline.** eval-app reset to a verified-green commit; the gate is run once and must
  pass before any arm starts. eval-app's HEAD currently carries T8's merged output, so the
  reset is required, not cosmetic.
- **Faithfulness.** Runs start through the same `POST /api/v1/runs` body the composer
  builds (`buildCreateRunBody`) — same workflow names, same `harness.skillProfile`, same
  worktree defaults. No eval-only branches, no special-cased configuration. What the eval
  measures is what a user gets.
- **Isolation.** Every arm is gated in its own measurement worktree off the baseline.
  Escaped writes into the main checkout are captured as a patch, reset, and gated
  separately — the "salvage" number, credited generously to arm A.
- **Concurrency.** `maxParallel: 2`; arm B in waves of two, arm A sequentially.
- **Caps.** 45 min per single run, 4.5 h per harness run, 30 min per gate command.

Reuses `om-eval-sandboxes/orchestrator.py` and `postpass.py` with a new roles file;
results stream to `eval-results/results.jsonl`.

## Estimates and risks

~4–6 h wall clock, roughly $10–25 — cheaper than the predecessor because two of three
reviewer seats are subscription-backed and the third is free.

- **Muse Spark is a free tier**: rate limiting or refusal is plausible. Quorum is designed
  for exactly this; a degraded round is a recorded result, not a failed eval.
- **Arm A cross-contamination**: the predecessor saw a single-arm run "verify" its tests
  against another run's fix in the shared main checkout. Post-hoc gating in an isolated
  worktree is the control.
- **Small n**: five tasks cannot support a significance claim. The writeup reports counts
  and per-task detail, never a rate dressed as a measurement.

## Output

Results appended here, and the summary table in `docs/multi-model-harness.md` updated to
describe this lineup alongside the predecessor's.
