# The multi-model harness

One agent writes the code. Different agents — on different models, from different
providers — decide whether it's any good. Nobody grades their own homework, nobody
commits anything, and nothing reaches a human reviewer that hasn't already survived
a real validation gate and an independent review council.

This document describes how the harness in `packages/cezar/src/harness/` actually
works: the role model, the phase pipeline, the handoff contract between roles, the
review councils, and the stage-only guarantee that makes the whole thing safe to run
unattended. The design record lives in `.ai/specs/2026-07-23-harness-orchestration.md`
and its follow-ups; this is the readable version.

## Why it exists

The predecessor of this design was a single long-lived agent context conducting the
whole pipeline. Two things killed it.

**Context rot.** Over a 10–14 hour run the conductor compacted its own context and
lost phase position, loop counters, and table formats. Progress notes were prose;
there was nothing to resume from after a crash.

**Self-graded work.** A single agent that implements *and* declares victory is
optimistic by construction. The predecessor 10-task eval found nine false success
reports and eight worktree escapes. In the zero-config rerun summarized at the end
of this document, matched settings and location instructions improved containment
only to 2 of 5; one deliverable still failed its external gate, and every run
reported success. Nothing in a single-session setup has both the incentive and the
independence to catch either.

The harness fixes the first by making control flow deterministic code with durable
state, and the second by separating the roles and making every claim mechanically
verified.

## The ownership split

Three parties, three non-overlapping jobs:

| Party | Owns | Concretely |
| --- | --- | --- |
| **cezar** | control flow | `src/harness/driver.ts` — a TypeScript state machine inside `RunManager`. Decides which phase runs next, enforces budgets and timeouts, persists everything. |
| **skills** | judgment | Vendored Markdown playbooks (`cez-*` / `om-*` under `vendor/skills/`). Each phase is a *fresh* agent session whose system prompt is the pinned skill body. |
| **harness.mjs** | mechanics | A deterministic Node script (`vendor/skills/cez-harness/scripts/harness.mjs`) run as a sealed child process. Capture, verify, validate, review-council fan-out, staging. |

The rule that falls out of this: **no LLM context ever outlives its phase.** The
orchestrator that writes the spec is not the implementer that reads it, and neither
is any reviewer. Memory lives in the ledger and in artifacts on disk, not in
anyone's context window.

## Roles

Three roles, each bound to a concrete `runner/model` pair at run submission
(`HarnessRoleRef` in `driver.ts`):

- **Orchestrator** — the judgment phases: qualify/diagnose for the issue flow,
  spec for the feature flow. Never touches implementation.
- **Implementer** — implement and fix phases. Runs sandboxed and stage-only.
- **Reviewers** — 2–5 per council. Each gets its own fresh, read-only pass.

The lineup is submitted per run — since the 2026-07-27 UX pass there is no profile
picker; profile names (`standard`, `multi`, `multi-optimized`, `high-assurance`)
survive as display labels and for scripted callers. A typical lineup, and the one
the eval used:

```
orchestrator   claude / haiku
implementer    codex  / gpt-5.6-luna
reviewers      claude/haiku · codex/gpt-5.6-luna
               · opencode/muse-spark-1.2-contributor-free
               (3 reviewers, 3 independent provider families)
```

**Families are the independence axis.** A council where every reviewer is a
resold alias of the same weights is not a council. `model-family.ts` is the single
definition of provider lineage (gateway prefixes like `openrouter/` or `zen/` are
billing, not family), and the server rejects a lineup whose reviewers don't span at
least two families. OpenCode is refused for the **orchestrator and implementer** —
those run as agent sessions that write to the worktree, and cezar can only hold a
session to stage-only where it has a seam for one (a `PreToolUse` hook plus
sandboxed Bash for claude, the workspace-write sandbox for codex; OpenCode offers
neither). It is welcome on the review bench, where nothing opens a session at all.

Reviewers come in three transports, one council:

- **Runner-backed** reviewers (claude, codex) run as fresh read-only agent
  sessions, up to 5 in parallel. The driver content-hashes the worktree before and
  after; a reviewer that mutates anything gets its review rejected.
- **Gateway** reviewers — anything the picker offers as `opencode/<model>` — are
  translated by `reviewer-binding.ts` into one structured call to the gateway. No
  config file, no session: this is how a Zen model joins a council straight from
  the composer.
- **Advisor** reviewers (a provider the gateway cannot reach at all, such as a Kimi
  subscription CLI) are bound in `agentHarness.models` and execute the same way.

The last two exist for a measured reason: `mimo-v2.5-free` answered as a structured
call in 62 s with real findings, and timed out at 30, 60 and 60 minutes as an agent
session. Small models answer a schema'd prompt perfectly and cannot drive a session
(`reviewer-binding.ts` has the numbers).

## The pipeline

Two built-in workflows: `harness-implement-feature` and `harness-fix-issue`
(same shape, plus qualify/diagnose up front and a cross-process issue claim).

```
 PREFLIGHT ── pin skills + trusted config (sha256), probe every roster model live
 CAPTURE   ── snapshot HEAD/refs/reflogs, run the baseline validation gate
    │
    ▼
 ┌─────────────┐   spec.md    ┌──────────────┐  blockers (≤3 rounds)
 │    SPEC     │─────────────▶│ SPEC COUNCIL │──────────┐
 │ orchestrator│◀─────────────│  reviewers   │◀─────────┘
 └──────┬──────┘   revise     └──────────────┘
        ▼
 ┌─────────────┐  implementer, sandboxed, stage-only
 │  IMPLEMENT  │
 └──────┬──────┘
        ▼
 ┌─────────────┐  regression vs baseline? ──▶ FIX (≤2 gate-repair rounds,
 │  VALIDATE   │                              doesn't spend review rounds)
 └──────┬──────┘◀─────────────────────────────────────────┘
        ▼ green
 ┌─────────────┐  any blocker/major ──▶ FIX (≤3 review rounds,
 │   COUNCIL   │                          + one closing fix, no extra review)
 │  ≥2 rev,    │◀─────────────────────────────────────────┘
 │  ≥2 fam.    │
 └──────┬──────┘
        ▼ approve
 ┌─────────────┐  git-derived allowlist, refs must be untouched
 │    STAGE    │
 └──────┬──────┘
        ▼
   REVIEW GATE — the run parks at cezar's `review` status.
   Push and PR creation stay 409 until a human publishes.
```

Every box is one ledger entry; every arrow between agent phases is an artifact
handoff, not a conversation.

## Handoffs are artifacts, never transcripts

Each agent phase ends by writing a schema-validated JSON result to
`$CEZ_HARNESS_RESULT_FILE`. The driver parses it, and builds the *next* phase's
prompt from the parsed fields — the implementer never sees the orchestrator's
reasoning, only its conclusions:

| Phase | Writes | Consumed by |
| --- | --- | --- |
| qualify | `{outcome: work_needed \| no_action, evidence}` | driver (may end the run) |
| diagnose | `{summary, files[], regressionTest?}` | implement brief |
| spec | `{summary, specPath, files?, openQuestions?}` | spec council, implement brief |
| implement / fix | `{changedPaths[], summary?, suggestedCommit?}` | validate, council, stage |
| review | `{verdict, findings[{severity, title, location?, evidence?}]}` | fix loop |

The claims in these files are treated as advisory wherever git can answer instead.
`changedPaths` is the clearest case: the driver derives the complete changed-path
set from git itself and *overwrites* the model's claim with it before staging. A
spec path that isn't on disk where the model said it would be is rejected before a
council pays to review it.

Two budgets keep this honest. Prompts are byte-budgeted (180 KB after output
reserve) and checked *before* paying for an invocation; result schemas are
field-bounded (`HARNESS_RESULT_LIMITS`). A phase that ends without a valid result
gets exactly one retry with an appendix naming the contract violation, then the run
fails resumably.

## Review councils

A council is not "ask another model what it thinks." It's a gated quorum with
mechanical verdicts:

- **Verdicts are derived, not trusted.** Any blocker or major finding forces
  `request_changes` regardless of what verdict the model wrote. A model that
  approves against its own blockers gets a loud note in the ledger.
- **Quorum is ≥2 completed reviewers spanning ≥2 independent families.**
  Below quorum the run doesn't die — it parks on a `council` decision and the
  operator chooses *retry the failed reviewers* or *proceed with the survivors*,
  recorded in `ledger.decisions`.
- **Findings merge across reviewers** with attribution (`by:` lists), deduped by
  severity and title. The merged verdict is `request_changes` if anyone said so.
- **Reviewers see history, not verdicts.** Later rounds get an appendix of what
  earlier rounds demanded — fixing the observed failure mode where round 2 demands
  X and round 3 blocks the fix for doing X — while each reviewer stays
  fresh-context.

The loop structure matters as much as the council: a red validation gate
short-circuits review and spends from a separate repair budget (2 rounds), so a
broken build never eats review rounds; and after the last paid review round, one
closing fix pass runs and is validated without buying a fourth review.

## Stage-only, mechanically enforced

The harness never commits, pushes, or opens PRs. That's not a prompt instruction —
prompt instructions are how you get 8/10 worktree escapes. It's enforced in layers:

1. **Sandbox.** Claude sessions run under an invocation-scoped settings file with
   a `PreToolUse` hook that refuses `git commit`/`push` and mutating `gh` calls,
   plus sandboxed Bash (sandbox-runtime on macOS, native sandbox elsewhere,
   `failIfUnavailable`) with writes confined to the worktree. Credentials
   (`ANTHROPIC_API_KEY`, OAuth, GitHub tokens) are denied to the sandbox.
   Environment is hardened for every phase: `GIT_ASKPASS=/usr/bin/false`,
   `SSH_AUTH_SOCK=''`, an empty `GH_CONFIG_DIR`.
2. **Git integrity.** `capture` snapshots HEAD, refs and reflogs at start;
   `verify` re-checks between phases; `stage` refuses if any ref or reflog moved —
   including a commit that was made and then reset away, which the reflog still
   shows.
3. **Staging is git-derived.** The allowlist comes from the driver's own diff, the
   runtime stages exactly those paths, and the driver cross-checks the staged set
   for exact equality.
4. **Server-side twin.** Push and PR routes 409 until the ledger proves
   `stage.status === 'staged'` and the outcome is `ready` (or a `contested`
   outcome the human explicitly accepted).

The end state is always the same: a verified staged diff parked at cezar's review
gate, with a `suggestedCommit` and a composed PR body in the ledger. Publishing is
a human act.

## Skills under the hood

The playbooks that own judgment are ordinary Open Mercato skills — vendored into
`vendor/skills/` from a pinned upstream commit, and routed by a fixed table
(`skill-routing.ts`). The `generic` profile maps phases to `cez-spec-writing`,
`cez-pre-implement-spec`, `cez-implement-spec`, `cez-code-review`,
`cez-verify-in-repo`, `cez-root-cause`, `cez-fix`; the `open-mercato` profile maps
them to the canonical `om-*` names. The graph is fixed — only the playbooks vary.

The trust mechanism is the interesting part. At preflight, every selected skill is
copied **out of the model-writable worktree** and its whole tree is sha256-hashed
into `ledger.trustedSkills`. Phase prompts are rendered from those pinned bytes,
bypassing the normal local-first skill catalog — so nothing the implementer writes
mid-run can swap the playbook the council reviews against, and a resume re-verifies
the hashes. The same treatment applies to `.ai/agentic.config.json` (snapshotted
from the base ref, never from the task branch) and to `harness.mjs` itself (sealed
out of the worktree, hash re-verified before every op — a modified runtime aborts
the op).

This is why a catalog-resolved skill copy is never trusted: one run froze a stale
runtime into four consecutive executions before the bundled tree became the only
source. The comment trails in `driver.ts` are full of these — the design is
incident-driven, and the incidents are cited in place.

## Durable state and recovery

All state is one versioned JSON ledger (`.ai/cezar/runs/<runId>.harness.json`,
atomic tmp+rename) plus the run's NDJSON event stream. Corrupt or future-version
ledgers fail closed; they never silently restart.

The recovery unit is the **invocation**: every paid model call is recorded with
its input hash and its artifact's sha256. A restart re-uses a completed invocation
only if both hashes still match — you never re-pay for verified model work, and
you never trust an artifact that changed underneath you. In-flight invocations are
reconciled by process identity token before being marked interrupted. Mid-run
operator messages queue in the ledger and fold into the next phase's prompt.

## Work packages (high-assurance)

Default profiles hand the implementer one phase brief — no decomposition. The
`high-assurance` profile adds bounded **packets**: an orchestrator-routed planning
phase emits up to 12 packet manifests (`objective`, `risk`, `allowedPaths`,
`invariants`, `acceptanceCriteria`, `dependencies`), and the driver validates the
plan mechanically — no overlapping path leases, no dependency cycles. Each packet
runs its own implement → driver-run gate → `packet-gate` promotion cycle, and only
gated packets' paths feed the final stage allowlist. A packet interrupted twice
stops for manual recovery rather than looping forever.

## The numbers

Five vertical-slice module tasks on a `create-mercato-app` scaffold, with the same
prompts and the same external gate (`generate + typecheck + lint + test`) re-run
post-hoc over each arm's full deliverable. Arm A was one `quick-task` agent on
claude/haiku. Arm B was the harness lineup above, using only existing CLI logins and
OpenCode's contributor-free tier — no `agentHarness` configuration. Model
self-reports were recorded and never trusted; arm-A escapes were credited
generously by reassembling and gating them on a clean baseline.

| Metric | Single agent | Harness |
| --- | --- | --- |
| Delivered to its own worktree | 2 / 5 | **5 / 5** |
| Tests written | 4 / 5 | **5 / 5** |
| Full gate green, salvage credited | 4 / 5 | **5 / 5** |
| Terminal state | 5 × `done` (success reported) | **5 × `review`, ready and staged** |
| Cost | $4.54 | $13.33 |
| Wall clock | 53 m | 343 m |
| Reviewer completions | — | **90 / 90, 401 findings** |

The difference is reliability, not capability. The single arm produced good code
on three tasks and wrote more tests than the harness on one, but misplaced the work
three times, shipped a red gate once, and reported success every time. The harness
was 5/5 on containment, tests and the external gate, at 2.9× the cost and 6.5× the
wall clock. You are not paying for speed. You are paying to stop re-running,
re-reviewing, and salvaging work that declared itself done.

## Where to read the code

| What | Where |
| --- | --- |
| Phase state machine | `packages/cezar/src/harness/driver.ts` |
| Deterministic ops (capture/verify/validate/stage) | `packages/cezar/src/harness/runtime.ts` + `vendor/skills/cez-harness/scripts/harness.mjs` |
| Quorum and council gate | `packages/cezar/src/harness/council-quorum.ts` |
| Reviewer transport selection | `packages/cezar/src/harness/reviewer-binding.ts` |
| Skill routing and trust pinning | `packages/cezar/src/harness/skill-routing.ts`, `skill-binding.ts` |
| Provider families | `packages/cezar/src/harness/model-family.ts` |
| Live readiness probes | `packages/cezar/src/harness/probe.ts`, `probe-transports.ts` |
| Ledger | `packages/cezar/src/harness/ledger.ts`, `types.ts` |
| Stage-only enforcement (Claude) | `packages/cezar/src/harness/claude-guard.ts` |
| Issue leases | `packages/cezar/src/harness/issue-claim.ts` |
| Workflow defs + catalog gating | `packages/cezar/src/harness/workflows.ts`, `src/workflows/load.ts` |
| Founding spec | `.ai/specs/2026-07-23-harness-orchestration.md` |

The feature rides the `multiModel` flag (`.ai/cezar/config.json`, off by default).
Flipping it off never strands in-flight runs — revival reads the persisted workflow
definition, and the ledger routes stay readable for history.
