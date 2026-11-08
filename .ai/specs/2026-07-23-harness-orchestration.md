# Multi-model harness orchestration

Status: implemented, opt-in. This is the current design for orchestration, advisor
reviewers, recovery and cockpit integration. Bundled skill discovery and provenance
are specified in [Vendored cez skills](2026-07-24-vendored-cez-skills.md); operator
instructions are in [Multi-model workflows](../../docs/multi-model-harness.md).

## Scope and defaults

Two built-in workflows produce a verified staged diff for human review:
`harness-implement-feature` and `harness-fix-issue`. They run in isolated worktrees,
including in projects using trunk development or automatic landing. They never
commit, push, open a PR or auto-land. A user workflow with the same name remains an
ordinary workflow; dispatch requires the built-in source marker.

The instance flag `CEZ_MULTI_MODEL` defaults to off; only the exact value `1`
enables it. It applies to every project served by the process, including projects
added after boot. Repository configuration and the project config API cannot
change it. The config response's read-only `multiModel` field reports the effective
instance flag; older local config keys are ignored. Restart with a different launch
environment to change enablement.

With it off, the composer, settings section, bundled skill catalog and built-in
workflow catalog expose no new capability. Starting a harness run or probing
models returns 409. Existing run evidence and decisions remain readable, and saved
workflows can continue after the instance is restarted with the flag disabled.

`CEZ_DRY_RUN=1` blocks live harness probes and execution, including recovery.
Read-only Ask tasks cannot start a writing harness workflow. Harness inputs are
text-only: attachments are rejected because no phase consumes them. Native model
locking must be disabled before a custom lineup can be submitted.

The composer shows the required issue binding inline for **Fix an issue**; explicit
issue references in the brief prefill it, and **Build a feature** accepts a brief
without an issue. The selected project must be a Git checkout with a commit. The
composer disables Start while that prerequisite is missing or unverified, and
`POST /runs` checks it before model probes or session creation. Cezar creates the
isolated worktree; users do not prepare one themselves.

## Ownership and contracts

| Owner | Responsibility |
| --- | --- |
| `harness/driver.ts` | Phase transitions, bounded repair/review loops, durable decisions and cancellation |
| Selected skills | Judgment instructions for fresh agent sessions; no orchestration authority |
| `harness/runtime.ts` and bundled `harness.mjs` | Deterministic capture, verification, validation, council adapters and staging |
| `packages/contract/src/harness.ts` | Zod request/response schemas and inferred public types |
| `harness/types.ts` and `ledger.ts` | Versioned durable state and fail-closed reads |

The ledger is `.ai/cezar/runs/<runId>.harness.json`, written atomically. Its current
version is 2; absent, corrupt and unsupported versions are distinct read outcomes.
It records phases, models, invocations, input/artifact hashes, validation results,
review councils, round cursors, queued feedback, pending decisions and the staged
outcome. Corrupt or future state must not silently start another paid run.

Agent phases write bounded, schema-validated JSON to `CEZ_HARNESS_RESULT_FILE`.
Subsequent phases receive artifacts and parsed conclusions rather than preceding
transcripts. An invalid result gets one contract-repair retry, then a resumable
failure. Prompts and results have explicit size limits checked before invocation.
Git-derived changed paths supersede an agent's claimed path list.

## Roles and reviewer independence

A submitted lineup binds an orchestrator, implementer and 2–5 distinct reviewers.
Claude and Codex can orchestrate or implement; OpenCode is review-only because its
writing sessions cannot satisfy the stage-only boundary. With no lineup, the
standard flow uses Claude and a fresh Claude review. The profile is a derived label:
`standard` without roles, `multi` for a Claude implementer, `multi-optimized`
otherwise. Named profiles, configured worker commands and high-assurance packets
are not supported.

Multi-model councils require at least two independent model families. The shared
`packages/contract/src/model-family.ts` classifies lineage across gateway aliases;
a gateway name is not an independent family. The server validates the lineup and
probes each selected binding. Custom command advisors receive an executable
availability check only; their binding is verified when the council runs. A transient readiness failure pauses paid work rather
than quietly substituting a model.

Reviewer transports share one council contract:

- Claude/Codex reviewers use fresh read-only sessions; worktree mutations invalidate
  the review.
- OpenCode catalog selections map to structured gateway calls through
  `reviewer-binding.ts`, without opening a writing agent session.
- Configured advisor bindings in `agentHarness.models` use the runtime adapters.
  Endpoint and credential validation restrict where provider credentials can go.

Provider account selection, reasoning effort and usage records follow the selected
binding. Concurrent reviewers have separate session keys so events, credentials,
transcripts and cancellation cannot be attributed to the wrong session.

## Execution and bounded exits

The feature flow is preflight → capture → spec → pre-implementation council →
implement → validate → review council → stage. The issue flow adds qualification,
a cross-process issue claim and diagnosis before implementation; qualification can
finish with a supported no-action outcome.

| State | Exit and bound |
| --- | --- |
| Preflight | Pin trusted inputs and probe the roster; proceed, pause for a recoverable provider condition, or fail with evidence |
| Project readiness | Detect missing Node dependencies before agent phases; park without an execution slot until the user prepares the worktree or repairs setup and retries |
| Agent phase | Valid artifact advances; one repair attempt for an invalid artifact; cancellation stops the phase |
| Spec council | Approve, revise within the review limit, or park for an operator decision |
| Validation | Compare against the captured baseline; regressions enter at most two gate-repair rounds before stopping |
| Implementation council | Approve, enter a bounded fix round, or park when quorum is lost |
| Council decision | Operator retries failed reviewers or explicitly proceeds with survivors; the choice is bound to the reviewed subject |
| Final fix | After the last review round, one closing fix can run and validate; unre-reviewed changes produce a contested outcome |
| Stage | Verify Git integrity and exact staged paths; park at the human review gate or fail closed |

Review loops have at most three rounds. Gate repairs use a separate counter so a
broken build cannot consume the review budget. Any blocker or major finding forces
`request_changes`, even if a reviewer claimed approval. Findings retain reviewer
attribution; later rounds receive prior requests while starting fresh contexts.
A multi-model council needs two completed reviewers from two families unless the
operator explicitly records a reduced-quorum decision.

No waiting state relies on an imagined process-exit or reviewer callback. The
ledger records the pending decision or recoverable failure; existing run-manager
Continue/account-resume paths re-enter the saved phase. Cancellation terminates
all owned agent and adapter process trees. Recovery verifies process identity
before attempting cleanup, never trusting a reused PID by itself.

### Review handoff and explicit follow-up work

The decision card above the diff explains the outcome and leads with the next
action. The dock links back to it; ordinary Continue and additional review notes
are secondary disclosures while a multi-model decision is needed. An unavailable
check is amber and distinct from a test failure, a tolerated baseline failure,
and a passing check. A missing tool or dependency can never be tolerated as
baseline debt. Missing Node dependencies are discovered from package metadata and
lockfiles, including Yarn's install state, before implementation begins.

`Prepare project` explicitly authorizes the detected package manager's fixed
install command from the task worktree, under the validation environment and
cancellable process tracking. It never installs during a GET or automatically at
boot. A failed setup remains actionable; manual setup followed by Continue also
rechecks the baseline before starting agent phases. Preparation of completed work
then validates and buys one fresh review; preparation before implementation
resumes the original bounded workflow.

`Verify final fixes` performs validation and one fresh full-diff council, without
an implementation phase. `Fix selected findings` performs one repair pass for
the selected current findings, validation, and one fresh council. Neither action
extends the automatic three-round loop or buys a closing repair. Another failed
review returns to the decision card. Each request carries a UUID and the current
ledger revision; duplicate clicks reuse the request, stale decisions are refused,
and the worktree subject is pinned before work starts. Re-entry reuses completed
hash-bound calls instead of paying again. Starting an action invalidates the old
staged publication approval immediately. Risk acceptance remains a separate,
explicit recorded user decision, and never publishes by itself.

Finding history keeps stable identifiers, reviewer attribution and first/last
rounds. Repeated unavailable-gate reports are grouped into one environment issue.
A completed later full review resolves absent findings; a failed or incomplete
council cannot resolve them. Closing repairs mark remaining code concerns as
fixed but awaiting verification. Failed executable checks are selectable repair
findings too. Legacy ledgers receive a read-only projection from their saved
councils and validation evidence; no run-state migration is required. Snapshot and
SSE updates carry validation, environment, finding history and action revisions.

A requested pass that stops on executable validation failures parks in `waiting`,
without a run error or execution slot. The handoff leads with the failed commands
and a repair action scoped to their stable finding IDs. Detailed output remains
in command disclosures and durable evidence, instead of the session-failure
banner. Legacy failed runs render the same handoff without rewriting history.
Unavailable baseline checks never establish a regression comparison. Review
findings and failed checks are counted separately; findings absent from a later
completed council are labelled "No longer reported".

## Trusted inputs and stage-only boundary

Preflight snapshots validation policy from the base ref, advisor bindings from
the trusted project checkout and selected skills outside the writable worktree. The deterministic runtime is sealed
with its companion files and hashed before use. Resume re-verifies these hashes;
a model cannot replace its reviewer instructions or validation policy mid-run.

Claude uses an invocation-scoped guard plus a required Bash sandbox. macOS uses
the optional `@anthropic-ai/sandbox-runtime` dependency; unavailable sandboxing
fails the harness phase closed without preventing ordinary cezar boot. Codex uses
workspace-write isolation with only the worktree, phase output and run-specific
temp roots writable. Harness agent environments remove dispatch and publish
capabilities, GitHub/SSH credentials and network-enabled Git transports.

Capture pins HEAD, the task branch ref and their reflogs. Verification runs between
phases and before staging, detecting commits even when subsequently reset away.
A scratch index computes review subjects without mutating the task's live index.
Staging must exactly match the Git-derived allowlist, including deletions, renames,
sparse worktrees and nested gitlinks. Publishing rechecks the pinned worktree and
staged outcome rather than trusting stale UI state.

The boundary has limits: Codex cannot deny reads of arbitrary credential files,
and validation commands execute repository code outside the agent sandbox. The
validation environment removes provider/publish credentials, but cannot prevent
code from reading the user's disk. Human review before publication remains required.

## Recovery, feedback and publication

Completed invocations are reusable only when their input and artifact hashes match.
In-flight work is reconciled as interrupted after owned process cleanup. Round
cursors preserve findings, consumed repair budgets and council history; completed
rounds are not charged or evaluated again against a later diff. Council decisions
are invalidated when the reviewed subject changes.

Feedback posted between phases persists in the ledger and enters the next phase
prompt. Feedback on a completed implementation clears its implementation cursor
and re-runs validation/review. Issue claims and owned process resources are released
on terminal paths. Retention preserves review evidence while the task is resumable.

Commit/push/PR/accept actions stay blocked until the ledger records an intact staged
outcome. A contested outcome additionally requires an explicit, recorded user
acceptance. Server checks apply to every publication entry point, including command
palette and workspace actions; disabled UI buttons are not the enforcement layer.

## HTTP, events and cockpit

All routes are chained into the project family under `/api/v1`, with matching
`/api/v1/p/:projectId` aliases. Inputs use the shared Zod middleware; contract parity
and typed-body tests cover the inferred Hono client.

| Route | Purpose |
| --- | --- |
| `GET /harness/status` | Enablement, runtime provenance, model and advisor capabilities |
| `POST /harness/probe` | Readiness for submitted roles |
| `POST /runs` with `harness` | Start one of the built-in workflows |
| `GET /runs/:id/harness` | Durable review and progress evidence |
| `GET /runs/:id/harness/invocations/:invocationId` | One invocation's evidence |
| `POST /runs/:id/harness/council-decision` | Retry or explicitly proceed after lost quorum |
| `POST /runs/:id/harness/accept-contested` | Accept the current contested staged outcome |
| `POST /runs/:id/harness/review-action` | Explicitly prepare, verify once, or repair selected findings once |

Progress uses the existing SSE/query-cache path, with reconciliation on reconnect;
there is no feature-specific polling loop or WebSocket. The Multi-model composer
loads lazily. Readiness can block sending while the user continues editing the
prompt. Models, council results and phase history use existing buttons, dialogs,
semantic theme tokens and keyboard interactions.

Ordinary task widths and transcripts remain unchanged. Harness views share a
responsive shell, with rail layout based on available container width and a measured
sticky header offset. Narrow layouts expose the same evidence through drawers and
dialogs. Feature-off, ordinary-thread, responsive, accessibility, lifecycle,
contract, sandbox, recovery and packaging tests cover these boundaries.
