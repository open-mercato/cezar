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

## Prerequisite 2: the synthesized council config

Found while preparing the baseline, and it would have killed the first council round.

`validateConfig` in `harness.mjs` refuses to run a council unless the config it is handed
carries `agentHarness.version === 1` and `delivery.mode === 'stage-only'`. The driver
synthesizes that config itself when the repo has none — the case its own comment calls
"the ordinary cezar project" — but wrote only `models` and `profiles`. Every zero-config
council therefore died on `agentHarness.version must be 1`.

Both keys are cezar invariants, not user choices: the vendored runtime is version 1, and
delivery is stage-only by construction. The driver states them now, in the synthesized
council config only; the user's own file is never written.

This is the shape the predecessor eval hit and recorded as a lineup mistake — "agentHarness
lacked `delivery.mode: stage-only` → all three structured-call reviewers failed config
validation → below quorum". It was a defect, and it is the reason this eval's baseline can
carry no `agentHarness` block at all.

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

- **Baseline.** Branch `eval-baseline-2026-08-23` at `309eec9`, non-destructively: eval-app's
  `main` is left where it was, carrying T8's merged pagination output, and the branch forks
  from the last commit before any task output landed. Its one added commit REMOVES the
  `agentHarness` block, so the zero-config claim is proven rather than merely not
  disproven — every reviewer binding this run uses is synthesized by the driver.
  `baseBranch` and `validation` stay: those are project facts, not harness configuration.
  The gate is run once on this branch and must pass before any arm starts.
- **Faithfulness.** Runs start through the same `POST /api/v1/runs` body the composer
  builds (`buildCreateRunBody`) — same workflow names, same `harness.skillProfile`, same
  worktree defaults. No eval-only branches, no special-cased configuration. What the eval
  measures is what a user gets.
- **Isolation.** Every arm is gated in its own measurement worktree off the baseline.
  Escaped writes into the main checkout are captured as a patch, reset, and gated
  separately — the "salvage" number, credited generously to arm A.
- **Concurrency.** `maxParallel: 2`; arm B in waves of two, arm A sequentially.
- **Caps.** 45 min per single run, 4.5 h per harness run, 30 min per gate command.
- **Transport.** One cezar booted in the cezar repo drives eval-app through
  `/api/v1/p/eval-app/...` — the same project-scoped path the cockpit uses for any non-boot
  project.
- **Skill profile.** `generic`. The `open-mercato` profile routes phases to `om-*` skills,
  which are not in the bundled vendor tree and would have to resolve from the project
  catalog mid-run; `generic` is fully bundled, is what the predecessor's runs actually
  used, and is what a user outside Open Mercato gets.

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
- **Probe and council disagree on transport for the Muse Spark seat.** Preflight verifies
  an `opencode/<model>` ref by spawning `opencode serve`; the council reaches the same
  model as a structured call to the Zen endpoint. `probe.ts` already names this hazard —
  "a model is only interchangeable with itself on the same transport" — so the seat can
  probe green and still fail at council, or the reverse. Left as measured behaviour rather
  than pre-emptively "fixed": the run will say whether it matters, and aligning the probe
  with the executing transport is a change worth making on evidence.

## Readiness at time of writing (2026-08-23)

| Seat | Verdict |
| --- | --- |
| codex / gpt-5.6-luna | ready — round-trip ok via `codex exec` |
| opencode / muse-spark-1.2-contributor-free | ready — round-trip ok |
| claude / haiku | **failed — `claude CLI exited with code 1`** |

The Claude Code OAuth token in `~/.claude/.credentials.json` expired on 2026-08-12, so
`claude auth status --json` reports `loggedIn: false` and cezar's provider probe reports
`disconnected`. Both Claude seats — orchestrator and one reviewer — are unavailable until
the user re-authenticates in their own terminal. Nothing else blocks the launch.

## Output

Results appended here, and the summary table in `docs/multi-model-harness.md` updated to
describe this lineup alongside the predecessor's.
