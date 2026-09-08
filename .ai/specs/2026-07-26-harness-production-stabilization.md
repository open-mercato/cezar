# Harness Production Stabilization

## TLDR

Make Cezar's multi-modal harness safe for expensive, long-running feature and
issue workflows. A run must survive process restarts without repeating verified
model work, terminate every child process when cancelled, fail closed on
ambiguous state, expose truthful blocked/degraded outcomes, execute all five
profiles, and render its durable state in the cockpit.

This specification completes and hardens
`2026-07-23-harness-orchestration.md`,
`2026-07-24-advisor-reviewers.md`, and
`2026-07-24-vendored-cez-skills.md`. Those documents remain the design history;
this document owns the production-readiness delta.

## Resolved Assumptions

- This is a core Cezar capability. Extension packaging cannot provide process
  recovery, RunManager integration, protocol events, or task-thread routes.
- The current `feat/multi-modal` branch is the implementation branch and Cezar's
  canonical base remains `main`.
- Existing run records, protocol event names, workflow names, and API routes
  remain backward compatible. New fields and endpoints are additive.
- Work is preserved when review cannot converge, but it is represented as
  blocked/contested and is not publishable until the user records an explicit
  acceptance decision.
- A model invocation is the smallest durable recovery unit. A completed
  invocation is reusable only when its input, binding, and output hashes match.
- The five profile names remain stable: `standard`, `optimized`, `multi`,
  `multi-optimized`, and `high-assurance`.

## Problem Statement

The current port can repeat an entire council after a restart, silently replace
a corrupt or unsupported ledger with a new one, leave provider descendants
running after cancellation, continue from a stale base branch, and stage work
that still has blocker findings as though the handoff were verified. The
cockpit defines harness events and a ledger API but does not consume them, so
operators cannot see model readiness, council evidence, packet leases, degraded
execution, or recovery.

These failures are especially costly because intended runs last 10–16 hours and
use five or six independent models. The original Claude-hosted harness worked
because one conductor owned the whole lifecycle. Cezar must replace that
implicit ownership with durable, testable orchestration.

## Proposed Solution

Use the harness ledger as a versioned operation journal rather than a
phase-summary file:

1. Load ledgers with a discriminated result: missing, valid, corrupt, or
   unsupported. Only missing creates a new ledger.
2. Persist every model/runtime invocation before launch and after completion.
   Reuse completed artifacts after validating hashes; restart only unfinished or
   invalid attempts.
3. Supervise deterministic runtime and validation commands in dedicated
   process groups, journal agent-runner roots, and apply bounded termination
   plus startup orphan reconciliation to both.
4. Resolve the selected profile into an explicit execution plan. Role-based
   custom runs remain supported as a custom council plan.
5. Treat validation failures, surviving blocking findings, lost leases, stale
   bases, and unverified required models as blocking outcomes.
6. Fold persisted ledger snapshots and live `harness.*` events into a dedicated
   React harness state. Render the start readiness surface, session phase/model
   status, council matrix, packet board, and blocked handoff.
7. Queue operator messages durably while no phase session is open and consume
   them at the next safe phase boundary.

## Architecture

### Durable state

`src/harness/types.ts` adds:

- `HarnessInvocation`: stable id, phase/round/role, binding, family, status,
  attempt, input hash, artifact path/hash, timestamps, duration, process
  identity, and error.
- `HarnessOutcome`: `ready`, `blocked`, `contested`, or `no-action`, with
  blocking reasons.
- Structured council and packet schemas. Unknown additive fields continue to
  pass through.
- Durable pending operator messages with consumed timestamps.

`src/harness/ledger.ts` exposes a discriminated reader and preserves the
existing nullable `loadLedger` helper for read-only compatibility. Driver and
API control paths use the discriminated reader.

### Invocation execution

The driver creates an invocation record before spawning. Invocation completion
is atomically persisted before the enclosing phase/council advances. Recovery
checks the record and artifact hashes:

- valid completed invocation: reuse;
- running invocation whose process is gone: mark interrupted and retry within
  budget;
- running invocation whose process still belongs to this run: reconcile/stop
  before retry;
- malformed/missing artifact: invalidate and retry;
- exhausted retry budget: block the run.

### Process supervision

`HarnessRuntime` and validation commands use a shared process-group helper. On
cancel/timeout it terminates the group, waits a bounded grace period, escalates
to SIGKILL, and records the outcome. Agent sessions also persist the runner
root PID before paid work is awaited; their existing session implementation
owns descendant cleanup. Startup recovery scans only process identities
recorded by the run and never signals an unrelated PID without a matching
identity token. Runtime operations reconcile their private group; runner
sessions reconcile their owned root.

### Profiles

- `standard`: host orchestrates/implements; fresh host review.
- `optimized`: configured worker implements; host orchestrates/reviews.
- `multi`: host implements; configured council reviews.
- `multi-optimized`: configured worker implements; configured council reviews.
- `high-assurance`: bounded path-disjoint packets, leases, worker/fixer budgets,
  blind risk-scaled council review, validation gate, and aggregate final review.

Custom role selection resolves to the same execution-plan representation while
retaining the existing requested/effective profile fields for older clients.

### Server and protocol

- Existing `GET /api[/p/:projectId]/runs/:id/harness` remains and returns
  conflict diagnostics for corrupt/unsupported ledgers.
- Add a mutation to accept a contested handoff explicitly.
- Existing `harness.*` events remain stable; snapshots are authoritative after
  reconnect.
- Harness start validation includes every dynamic runner/provider role.
- A stale configured base blocks a harness start before worktree creation unless
  an explicit run-scoped acknowledgement is supplied.

### Cockpit

- New-task Multi-model surface offers the five profiles, role customization, and
  measured readiness.
- Session shows the phase rail, packets/workers, model roster, degraded/blocked
  state, and a phase-boundary message composer.
- Review shows reviewer status and a finding-by-model matrix from immutable
  council artifacts.
- Packets shows leases, dependencies, budgets, review cycles, and gate evidence.
- Reconnect fetches the ledger snapshot, then applies newer live events.
- Generic non-harness task routes and components remain unchanged.

## Data Model

All state remains JSON/NDJSON under `.ai/cezar/`; no database is introduced.
Ledger version 2 is additive and migrates version 1 in memory, then writes v2 on
the next mutation. Unsupported future versions are never overwritten.

Invocation and message payloads contain no credentials or model prompt bodies.
They store hashes and run-local artifact paths. Provider output remains capped
and stored under the run artifact directory.

## API Contracts

### `GET /runs/:id/harness`

- `200`: validated ledger snapshot.
- `404`: run or ledger is genuinely absent.
- `409`: ledger exists but is corrupt or from an unsupported version; body
  includes a safe diagnostic and recovery is stopped.

### `POST /runs/:id/harness/accept-contested`

Body:

```json
{ "reason": "Human-reviewed explanation" }
```

Allowed only when the run is at a contested review gate. It appends an explicit
user decision to the contested outcome, makes the result eligible for
human-controlled publishing, and never deletes or relabels the surviving
findings.

### `POST /runs/:id/messages`

For an active harness run with no open phase session, the existing route returns
`{ "queuedForPhase": true }` after atomically appending the message to the
ledger. The server emits the ordinary `user-message` event immediately so the
authored message remains visible in the transcript, and the driver consumes it
exactly once at the next phase boundary without emitting a duplicate bubble.

## UI/UX

- Readiness is never represented as green for `unknown` or `unverified`.
- Degraded councils and contested handoffs use text plus icon/status, never
  color alone.
- The primary publish actions are disabled while contested, with an explicit
  “Accept risk and continue” action requiring a reason.
- All tables and packet cards remain keyboard accessible and responsive.
- Existing light/dark/system themes and mobile safe areas are preserved.

## Edge Cases and Failure Scenarios

- Corrupt ledger: run stays stopped; original bytes remain untouched.
- Newer ledger version: older Cezar refuses to mutate it.
- Crash after one reviewer completes: completed review is reused exactly once.
- Crash while a provider process is alive: recovery reconciles or terminates it
  before retry.
- PID reuse: identity mismatch prevents termination.
- Required model is unverified: strict profiles do not start.
- Reviewer failure with a resilient profile: degraded quorum is recorded and
  requires the policy-defined decision; strict profiles remain blocked.
- Blocking findings survive the fix budget: work is preserved as contested,
  never represented as verified.
- Packet lease owner dies: lease expires/reconciles from recorded process
  identity; overlapping packets never run together.
- Operator message arrives between phases: it is persisted and delivered once
  at the next boundary.
- SSE reconnect: ledger snapshot wins, then events with newer sequence numbers
  apply.

## Migration and Backward Compatibility

- RunRecord fields remain optional.
- Ledger v1 migrates additively to v2. No existing file is rewritten merely by a
  read.
- Existing workflow/profile/event/route identifiers remain unchanged.
- Existing clients that ignore new harness fields continue to function.
- The nullable `loadLedger` helper remains for non-control read paths while new
  control paths use the discriminated result.
- Generic review gates and ordinary run messaging retain their existing
  semantics.

## Risks and Impact Review

- Process groups differ across Unix and Windows. The supervisor must have a
  platform adapter and tests that assert graceful degradation.
- Invocation replay correctness depends on stable input hashing. Hash inputs are
  explicitly versioned and include subject, diff/packet hash, binding, model,
  effort, rubric, and validation evidence.
- High-assurance packets are the largest scope. They reuse the vendored runtime
  contracts instead of duplicating packet mechanics in RunManager.
- UI event ordering can race snapshot fetches. The client applies snapshots
  first and deduplicates live events by sequence/version.
- Vendored runtime changes must be made in the upstream skills source and
  regenerated when possible; Cezar-local emergency patches are recorded in the
  manifest and covered by parity tests.

## Integration Test Coverage

1. Start-surface profile readiness: unavailable and unverified required models
   block start; ready profile submits the exact profile.
2. Restart mid-council: completed reviewers are not re-invoked; unfinished
   reviewers resume; the UI reconstructs the same matrix.
3. Corrupt/future ledger: API returns 409 and no new ledger is written.
4. Cancel advisor council: provider process tree exits and the run becomes
   cancelled.
5. Stale base: harness start is refused with actionable guidance.
6. Contested review: publish controls remain disabled until an explicit
   acceptance decision, after which findings remain visible.
7. Phase-boundary message: message persists between sessions and is delivered
   exactly once to the next phase.
8. High-assurance packet board: packet transitions and lease conflict are
   visible and survive reload.

## Phasing and Implementation Plan

### Phase A — Durable orchestration

1. Add ledger v2 schemas, migration, discriminated load results, and tests.
2. Add invocation journal helpers and artifact hashing.
3. Checkpoint/reuse each runner and advisor review invocation.
4. Add crash-injection recovery tests at every invocation boundary.

### Phase B — Supervision and truthful gates

1. Add process-group supervision and orphan reconciliation tests.
2. Block stale bases and dynamic provider-role failures before execution.
3. Add blocked/contested outcome and explicit acceptance API.
4. Preserve unresolved findings in stage/handoff metadata.

### Phase C — Profile execution

1. Resolve configured profiles into execution plans.
2. Implement optimized and multi-optimized workers.
3. Integrate resumable packet operations for high assurance.
4. Add profile and packet unit/integration coverage.

### Phase D — Cockpit

1. Add authoritative harness query/reducer.
2. Implement profile/readiness start surface.
3. Implement session model/phase and boundary-message surfaces.
4. Implement council Review and Packets tabs.
5. Add responsive/accessibility/browser coverage.

### Phase E — Vendored runtime hardening

1. Replace credential denylisting with an explicit environment allowlist.
2. Detect reviewer worktree/index mutation and complete Git mutation capture.
3. Bound output/JSON extraction and make artifact writes atomically readable.
4. Expand language-neutral test freezing and security tests.

### Phase F — Verification

1. Run crash, cancellation, recovery, API, and cockpit integration suites.
2. Run the complete repository validation gate.
3. Run browser smoke and harness-specific E2E.
4. Run a fresh-context adversarial review against this specification.

## Final Compliance Report

- Uses Cezar's existing RunStore, NDJSON/SSE, project-scoped route, runner, and
  worktree seams.
- Adds only optional/additive public fields and routes.
- Keeps publishing user-controlled.
- Defines deterministic failure behavior and executable integration scenarios.
- Requires semantic tokens, accessible status text, and existing UI primitives.

## Changelog

- 2026-07-26: Initial production-stabilization specification created from the
  multi-modal branch audit.
- 2026-07-26: Implemented phases A–E; clarified contested acceptance and
  phase-boundary transcript semantics to match the shipped contracts.
- 2026-07-26: Completed recovery, package, cockpit, and fresh-context
  verification. The repository's pre-existing browser-smoke baseline remains
  separately tracked; harness component/integration coverage is green.
- 2026-07-30: Hardened phase completion after live run
  `9274bfa3-3d0c-4e80-a9f2-6fc2736a3d3d`: model-authored results now live in
  a dedicated agent-output subtree instead of Cezar's trusted artifact root,
  result files start absent so Claude Write can create them, macOS Claude Bash
  runs through Anthropic's standalone sandbox runtime to avoid the native
  2.1.193 `E2BIG` spawn regression, and small-command `E2BIG` failures stop the
  phase immediately instead of consuming the informed retry.
- 2026-07-30: Corrected the bounded council semantics after live run
  `475853b0-fdab-4821-85e4-c9cd9b474fbe`: the three spec cycles now use
  `*-pre-implement-spec` and each request-changes verdict, including cycle
  three, receives a `*-spec-writing` repair. Likewise, findings from the third
  `*-code-review` cycle receive a closing implementation repair and validation.
  The bounds limit fresh paid reviews; they no longer discard findings already
  paid for at the terminal review.
- 2026-07-30: Corrected macOS shell bookkeeping after live run
  `c9652713-8def-4dcd-ae36-574ccad3f5a3`: the standalone sandbox permits only
  Claude's canonical `/private/tmp/claude-*-cwd` marker shape, so successful
  Bash commands are not misreported as failed while unrelated temporary writes
  remain denied. Every phase also receives one concise location contract naming
  its worktree and output root and stating that its complete playbook is already
  injected; agents no longer need to guess checkout/artifact paths or invoke an
  unavailable Skill tool.

## Implementation Status

| Phase | Status | Date | Notes |
|---|---|---|---|
| Phase A — Durable orchestration | Complete | 2026-07-26 | Ledger v2, fail-closed reads, atomic invocation artifacts, hash-checked reuse, and partial-council recovery implemented. |
| Phase B — Supervision and truthful gates | Complete | 2026-07-26 | Process groups, PID/token reconciliation for paid subprocesses, dynamic provider gating, stale-base acknowledgement, contested outcomes, and publish guards implemented. |
| Phase C — Profile execution | Complete | 2026-07-26 | All five trusted-config profiles and resumable, path-disjoint high-assurance packets implemented. |
| Phase D — Cockpit | Complete | 2026-07-26 | Readiness, phase/model status, snapshot/event reconciliation, Review, Packets, recovery, and boundary messaging surfaces implemented with component integration tests. |
| Phase E — Vendored runtime hardening | Complete | 2026-07-30 | Explicit environment forwarding, review-mutation detection, bounded provider output/JSON extraction, checked regeneration patches, isolated agent-output artifacts, and sandboxed macOS shell fallback implemented. |
| Phase F — Verification | Complete with baseline exceptions | 2026-07-26 | Typecheck, full Vitest, core unit, production build/pack, release-package E2E, focused harness/cockpit suites, diff checks, and fresh-context adversarial review pass. The existing browser suite still has unrelated legacy fixture/order/cleanup failures (178 passed, 5 skipped, 16 failed, plus 2 cleanup-suite failures); no harness component regression failed. |
