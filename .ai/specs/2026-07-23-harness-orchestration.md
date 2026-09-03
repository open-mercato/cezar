# Programmatic control of the om-harness multi-model pipeline

Harness source of truth: [open-mercato/skills PR #43](https://github.com/open-mercato/skills/pull/43) (`skills/om-harness`).

> **2026-07-24 amendment — advisor reviewers**: role-based runs can seat configured `agentHarness` bindings (kimi-subscription, deepseek-api, Zen presets) as reviewers, executed as one packet-less runtime council — see [`2026-07-24-advisor-reviewers.md`](2026-07-24-advisor-reviewers.md).
>
> **2026-07-30 amendment — selectable development profile.** The task prompt remains only the user's business, defect, or product requirements; it never has to explain the harness sequence. The Multi-model start surface separately persists `skillProfile: generic | open-mercato` (default `generic`). The fixed graph selects complete playbooks by profile:
>
> | Phase | Generic project | Open Mercato |
> | --- | --- | --- |
> | specification | `cez-spec-writing` | `om-spec-writing` |
> | pre-implementation audit | `cez-pre-implement-spec` | `om-pre-implement-spec` |
> | implementation | `cez-implement-spec` | `om-implement-spec` |
> | review | `cez-code-review` | `om-code-review` |
> | issue qualification | `cez-verify-in-repo` | `om-verify-in-repo` |
> | root cause | `cez-root-cause` | `om-root-cause` |
> | fix | `cez-fix` | `om-fix` |
>
> Generic skills are complete, bundled project-neutral playbooks, not abbreviated prompts. The Open Mercato option uses the exact mature `om-*` trees discovered from the normal catalog; a repo-local `om-code-review` extension is composed over the complete shared definition. Preflight materializes every selected directory and reference, copies it outside the model-writable worktree, and pins its tree hash before any paid judgment phase. The profile is immutable across recovery. Cezar's `cez-harness` runtime and `cez-setup-harness` model configurator remain shared by both profiles.

## TLDR
The staged-only multi-model harness (om-fix-issue / om-implement-feature + `harness.mjs`) is today conducted by a single Claude context in the desktop app. Over 10–14 h runs that context compacts: it loses its place in the workflow, drops loop counters, and stops rendering the reviewer tables in the contracted format. This spec moves the **conductor** into cezar: a TS-defined phase driver inside `RunManager` owns sequencing, bounded loops, council policy, and report rendering; every judgment phase (qualify, root-cause, implement, fresh review) runs as a **fresh, bounded claude session** whose input is a distilled brief assembled from on-disk artifacts; every deterministic phase (probe, capture, prepare-review, review council, packet-run, stage) is a direct child-process call into the unchanged `harness.mjs`. No LLM context ever outlives its phase, all state lives in a persisted harness ledger + NDJSON events, and the UI renders councils and per-model activity from JSON — so nothing can compact away and nothing can drift. The wrapper skills in the skills repo stay canonical for non-cezar users; cezar re-uses their phase *content* (the installed om-* skills) and their runtime verbatim.

## Problem Statement
The harness has a clean separation on paper: `harness.mjs` is deterministic (adapters, councils, packets, staging — all versioned JSON artifacts), the om-* sub-skills hold the judgment work, and the wrapper SKILL.md tells the conductor how to sequence them. In practice the conductor is an LLM following ~350 lines of prose contracts for hours:

- **Context compaction loses the thread.** Phase position, `≤3` loop counters, artifact paths, the claim state, and the "paste the reviewer-status table verbatim" discipline all live in the conductor's transcript. After compaction the run continues but degrades — wrong format, skipped gates, re-done phases.
- **Progress is prose.** The only live view is chat text. `review-summary.md` tables are re-rendered by the model instead of by code, so the format drifts exactly when the run is longest.
- **No resumability.** A desktop-app conversation cannot be re-entered at a phase boundary after a crash, sleep, or window close. A 12-hour run is a 12-hour bet.
- **Human gates block the whole run.** Profile-unready reroutes, fallback consent, and force-claim confirmations are chat questions inside one long conversation; there is no queue, no notification, no structured decision record.

Cezar already has the machinery the conductor lacks: a persistent run state machine with crash recovery (`RunManager`, `src/workflows/run.ts:283`; `recover()` at `run.ts:637`), append-only NDJSON events + SSE (`src/runs/store.ts:185`, `src/server/server.ts:2672`), fresh-session process control per step (`buildClaudeArgs`, `src/core/claude-cli-runner.ts:311`), worktree isolation, ask cards, and a review gate. What it lacks is a run whose phases fan out across multiple models with a structured ledger — the survey's conclusion verbatim: the server models *one live session per step*, not "provider A implementing / providers B,C,D reviewing".

## Proposed Solution
Add a **harness driver** to cezar: two built-in workflows (`harness-fix-issue`, `harness-implement-feature`) executed by a TS phase graph instead of the linear YAML step list. Three ownership rules:

1. **Cezar owns control flow.** Phase sequencing, the `≤3` council/fix loops, redispatch-once, retry policy, profile gating, human decision points, cancellation and claim cleanup — all TS in `src/harness/driver.ts`, driven by `RunManager` like any other run.
2. **The selected complete skills own judgment.** The generic `cez-*` or explicit Open Mercato `om-*` phase skill runs as a **new agent session** — never a resumed transcript across phases — with the full skill plus a TS-assembled phase brief as input. Cezar adds the deterministic boundary contract, not a replacement summary of the playbook.
3. **`harness.mjs` owns mechanics.** Probe, capture, prepare-review, the advisor council, worker packets, packet-run/gate, and stage are spawned directly by cezar as child processes, exactly as the wrapper skills would; their JSON artifacts are the authoritative state cezar ingests and streams.

**Alternatives considered and rejected:**

- *Run the wrapper skill as one cezar agent step* (what `skills: [om-fix-issue-multi]` does today). Cezar adds persistence and a transcript, but the conductor is still one 10–14 h LLM context: compaction, format drift, and prose-only progress all remain. This stays available as the fallback path but is not the design.
- *Reimplement the whole harness in TS* (port councils, adapters, packets into cezar). Maximum determinism, but it forks the skills product — every non-cezar user keeps the `harness.mjs` behavior while cezar's copy drifts, and the audited safety surface (ref snapshots, credential stripping, packet leases) would be re-implemented rather than re-used. Rejected outright.
- *Keep the LLM conductor but checkpoint it* (periodic structured checkpoints + restart-on-compaction). Cheaper, but the conductor still does deterministic control flow probabilistically, and the checkpoint quality depends on the very context that is degrading. The phase driver is the same work done honestly.

## Architecture
Six seams, all additive.

**1. Built-in harness workflows + driver (`src/harness/driver.ts`).** `workflowStepSchema` (`src/workflows/types.ts:12`) is agent-XOR-check with backwards-only `onFail` loops — it cannot express parallel joins (host review ∥ advisor council), profile-conditional phases, or forward loops, and it should not grow to. Instead `harness-fix-issue` / `harness-implement-feature` register as built-in `WorkflowDef`s (like `QUICK_TASK_WORKFLOW`, `types.ts:179`) whose steps are *materialized by the driver at start* from the requested profile: the step list IS the phase list (preflight → qualify → capture → diagnose → [diagnosis council] → implement → validate → final council ×N → stage), so the existing step rail, `StepState`, and per-step `sessionId`/`backend` bookkeeping (`src/runs/store.ts:27`) all apply unchanged. `execute()` (`run.ts:1523`) dispatches to the driver when the workflow is harness-kind; the driver calls the existing `runAgentStep()` (`run.ts:1779`) for judgment phases and a new `runHarnessOp()` for runtime calls. Council rounds appended by the fix loop become dynamically added steps (the step model already tolerates synthetic steps — `continue-N`, `run.ts:1167`).

**2. Runtime bridge (`src/harness/runtime.ts`).** Locates the materialized `cez-harness` skill (`ensureSkillOnDisk` in `src/skills-materialize.ts` copies directory skills — from the bundled `vendor/skills/` set, a global install, or a team repo — plus their `requires:` closure into the worktree's `.claude/skills/`), spawns `node …/scripts/harness.mjs <cmd>` with an argument array, per-op timeout, and kill-on-cancel wired into `cancel()` (`run.ts:829`). Resolves the **trusted config snapshot** the way `references/issue-workflow.md` mandates: `git show <base>:.ai/agentic.config.json` into the run's artifact dir, plus the user-local overlay named by `OM_AGENT_HARNESS_CONFIG` when set. Parses each op's JSON artifact (probe result, review packet, council result, packet ledger, stage report) against the shipped schemas and rejects — never repairs — mismatches. Stdout is logged, artifacts are authoritative (the harness's own rule).

**3. Harness ledger (`.ai/cezar/runs/<id>.harness.json`).** The conductor's memory, owned by the driver, persisted with the same atomic tmp+rename discipline as `runs.json` (`store.ts:776`). Every mutation also appends a typed event, so the NDJSON stream stays the single replay source for the UI. Shape in **Data Model**.

**4. Protocol: five additive v2 events** (`src/core/ui-events.ts`, mirrored to `web/app/src/protocol/ui-events.ts`): `harness.phase.updated`, `harness.readiness.updated`, `harness.council.updated`, `harness.packet.updated`, `harness.stage.updated`. Emitted by the driver (not by backend mappers — they are run-level, like `plan.updated`), persisted to NDJSON, replayed over the existing per-run SSE (`server.ts:2672`), folded by `reduceThread()` (`web/app/src/routes/task-thread/thread-state.ts:287`) into ledger-shaped UI state. Golden fixtures + a replay test accompany them (the parity suite applies to backend mappers; driver events get their own fixture test).

**5. Fresh host review, structurally attested.** The `multi*` council requires a genuinely fresh Claude context running `om-code-review` concurrently with the advisor pool. The driver starts (a) an agent step with a brand-new session — cezar never passes `--resume`, so `freshContext: true` / `implementationContextInherited: false` is true by construction, not by promise — writing its artifact to the predeclared `--host-review` path, and (b) `harness.mjs review --review-packet … --host-review …` as the concurrent op. The runtime's own validation (hash match, attestation, atomic-rename observation) is unchanged. This is the one place two child processes run inside one phase.

**6. Stage → review gate.** A successful `stage` op parks the run at cezar's existing `review` status (`settleSuccess()`, `run.ts:2202`) with the staged diff in the Changes tab. The handoff report's "publish checklist (human)" becomes the product surface it always wanted to be: the human reviews the staged diff in the cockpit, then uses the existing commit / push / Create-PR actions (`POST /runs/:id/git/*`, `/runs/:id/pr`). Until the human acts, the driver keeps the issue claim (per the stage-only contract) and cezar's git-action buttons carry the suggested commit subject + prepared PR body from the ledger. A post-publish "release claim" action runs the tracker release op. **Guard:** while a harness run is active (pre-review), the server rejects `git/push` and `pr` for that run's worktree — the cockpit-side twin of `hooks/block-push-and-pr.sh`, which the materializer also installs into the worktree for defense in depth.

**Phase contract for judgment steps.** Each agent phase receives: the skill to execute, the phase brief (issue text, root-cause artifact, criteria — all read from artifacts, never from a previous transcript), `CEZ_HANDOFF_FILE` as today, and a `CEZ_PHASE_RESULT` path where it must write a small schema-validated JSON (e.g. qualify → `{outcome: 'work_needed'|'no_action', evidence}`; root-cause → pointer to the diagnosis artifact). Malformed or missing result JSON = one automatic fresh retry, then the run fails resumably. This replaces prose-parsing with the same artifact discipline the harness already uses everywhere else.

**What this fixes, mechanically:**

| Desktop-app pain | Mechanism here |
|---|---|
| Compaction loses the thread | No context outlives its phase; the "thread" is the ledger + artifacts |
| Tables drift from the contract | UI renders council JSON; handoff.md generated by TS from the ledger |
| 12 h runs are unresumable | Phase-boundary checkpoints; `recover()` re-enters the graph; deterministic ops are idempotent re-runs |
| Progress is prose | Typed events → step rail, models dock, council matrix, packet board |
| Human gates block the run | Ask cards + inbox/notifications; decisions recorded in the ledger |
| Freshness by promise | Freshness by construction (new `--session-id`, no `--resume`) |

## Data Model
`HarnessLedger` (versioned, additive to everything else; `RunRecord` gains one optional `harness?: { profile, skillProfile, workflow }` stub for list surfaces):

```jsonc
{
  "version": 1,
  "workflow": "harness-fix-issue",
  "requestedProfile": "multi-optimized",
  "skillProfile": "open-mercato",
  "effectiveProfile": "multi-optimized",          // differs only after an explicit user fallback decision
  "subject": { "kind": "issue", "id": "642", "title": "…" },
  "trustedConfig": { "baseRef": "main@9f21c3a", "path": "…/trusted-config.json", "overlay": false },
  "models": [ { "id": "codex", "family": "openai", "binding": "gpt-5.6-sol", "roles": ["worker","reviewer"],
                "readiness": "ready", "probeNote": null, "invocations": 3, "totalDurationMs": 812000 } ],
  "phases": [ { "id": "diagnose", "kind": "agent", "skill": "om-root-cause", "status": "done",
                "attempts": 1, "sessionId": "…", "startedAt": "…", "endedAt": "…",
                "artifacts": { "result": "…/phase-diagnose.json", "brief": "…/brief-diagnose.md" } } ],
  "councils": [ { "round": 1, "kind": "implementation", "packetSha256": "…", "policy": "all-required",
                  "reviewers": [ { "id": "claude", "status": "completed", "durationMs": 412000, "attempts": 1,
                                   "requestedModel": "claude", "actualModel": "…", "freshContext": true } ],
                  "verdict": "request_changes", "findings": [ /* review-result.schema.json findings + raisedBy + resolution */ ],
                  "artifacts": { "packet": "…", "result": "…", "summary": "…" } } ],
  "packets": [ /* high-assurance: manifest ref + ledger state mirror + gate status */ ],
  "loops": { "fixRounds": 1, "maxFixRounds": 3 },
  "claim": { "held": true, "issueId": "642", "assignee": "…" },
  "stage": { "status": "staged", "startState": "…", "allowlist": "…", "suggestedCommit": "…", "prBody": "…" },
  "decisions": [ { "at": "…", "kind": "profile-fallback-declined", "by": "user", "detail": "…" } ]
}
```

Artifacts (packets, results, briefs, phase results) live under the run's ignored artifact directory — the same dirs the harness contract already reserves — and are retained/pruned with the existing worktree-retention machinery (`src/runs/retention.ts`), except the ledger + council summaries, which are retained with the NDJSON.

## API Contracts
All additive, project-scoped:

- `GET /harness/status` — is the collection installed (om-harness resolvable), does `.ai/agentic.config.json` carry `agentHarness`, which profiles are defined, last probe result per profile (cached).
- `POST /harness/probe { profile }` — run `harness.mjs probe` against the trusted snapshot; returns and caches the readiness table JSON. Used by the new-task surface before start; the driver re-probes at run start regardless (the cache is UX, not a gate).
- `POST /runs` — `startRunSchema` gains an optional `harness: { profile, skillProfile?: 'generic'|'open-mercato', issueId? }`, valid only with the two harness workflow names. Missing `skillProfile` means `generic`; variants are rejected for harness runs.
- `GET /runs/:id/harness` — the current ledger (refetch-on-reconnect companion to the event stream, same pattern as `useRun` + `useRunEvents`).
- Decisions reuse the **existing ask mechanism**: the driver emits `ask.requested` v2 events (profile-unready reroute, fallback consent, force-claim, blocked-council repair, packet-release) and answers arrive through the existing `POST /runs/:id/messages`; the driver records each into `ledger.decisions`. No new decision endpoint.
- Guard (Architecture §6): `POST /runs/:id/git/push` and `POST /runs/:id/pr` return 409 for a harness run before it reaches `review`.

## UI/UX
- **Run view.** The meta-row gains a violet **profile pill**; the step rail becomes the **phase rail** (every phase with state glyphs, the active one shimmering, elapsed time — the rail is `RunRecord.steps`, so this is mostly free). New **Models dock** (sibling of the agents dock, `agents-dock.tsx` pattern): one row per ledger model — role tag (HOST / WORKER / REVIEWER), binding in mono, live activity ("implementing packet 2/3 — src/runs/store.ts", "council: completed in 3m 12s", "waiting for council"), attempt badges. Councils and packet dispatches appear in-thread as cards (verdict pill + one-line summary) that expand.
- **Review tab.** Round stepper (Round 1 → `request_changes` → fixes → Round 2 ●), the **reviewer-status table** (reviewer, family, context=fresh, requested vs observed model, provider, status incl. `retrying 2/4`, duration) rendered *above* the **findings-by-model matrix** — `●` raised / `—` completed-no-finding / `!` failed / `○` skipped / `◐` same-family self-check — with severity chips, per-finding resolution, and single-reviewer (minority) findings visually preserved. The fresh-Claude validation-gate table sits alongside. All of it renders from `councils[]` JSON; the symbols and ordering follow `references/reporting.md` mechanically.
- **Start surface.** Workflow entries "Fix issue (staged, multi-model)" / "Implement feature (staged, multi-model)"; a Development profile control (Generic project / Open Mercato) independent from the model/conduction profile; and the **readiness table** card shown before start. Configure harness runs `cez-setup-harness`; the user's textarea remains a requirement brief.
- **Packets tab** (high-assurance only): packet cards with the ledger state machine (planned → claimed → implementing → reviewing → fixing → awaiting_validation → gated / blocked), risk chip, allowed-path leases, budget bars, reviewer lenses, fix cycles, gate-evidence coverage; `packet-release` as an explicit destructive action on blocked packets.
- **Review-gate finish.** At `review`, the header actions surface the suggested commit subject and prepared PR body from the ledger; after push+PR, a "Release issue claim" chip completes the checklist.

## Edge Cases & Failure Scenarios
- **Process restart / laptop sleep mid-run:** `recover()` re-adopts the run; the driver re-enters the graph at the last non-`done` phase. Deterministic ops are idempotent (`probe`, `prepare-review`, `review` over the same packet re-run cheaply; `capture`/`stage` verify rather than mutate). An interrupted judgment phase restarts **fresh** with the same brief — its partial transcript is worthless by design, which is precisely the point. A killed council re-runs; completed advisor results are not reused across invocations (the runtime treats a council as atomic; re-running is the documented cheap path).
- **Advisor keeps failing after retries:** the runtime exits non-zero with `verdict: null`; the driver surfaces an ask card — retry council / repair binding (starts `om-setup-agent-harness`) / stop — never silently downgrades the council, matching the blocked-council contract.
- **Malformed phase result / missing artifact:** one automatic fresh retry of that phase, then `failed` with the ledger intact; "Resume" re-enters at the failed phase.
- **Cancellation and claim hygiene:** `cancel()` kills agent sessions *and* harness ops, then runs the abort path — release assignee + `in-progress` label + abort comment (the `--abort` contract) — via a short cleanup phase so a leftover claim never fences the issue. If cleanup itself fails, the run records `claim.held: true` and the UI shows a "claim still held" warning with a manual release action.
- **`cez-harness` missing / version skew:** normally impossible — the collection ships in `vendor/skills/` and `/harness/status` reports its source + pinned commit (`runtime`). Preflight still fails closed with a rerun-the-vendor-script hint when even the bundle is gone (broken install), and a repo-local or team override reports as itself; `validate-config` failing on a newer config schema is surfaced as-is.
- **Concurrent harness runs:** per-issue exclusion is the claim protocol's job (qualify blocks on an active claim); path leases are repository-global in the Git common dir, so two high-assurance runs on one repo coordinate correctly; the `WorkspaceSemaphore` bounds total load. A harness run holds one slot; advisor HTTP calls add no slot pressure.
- **Live council granularity, v1:** `harness.mjs review` reports terminal per-reviewer results; between op start and end the models dock shows reviewers as `running` from the resolved profile, and the driver tails `review-result.partial.json` when it appears. True per-attempt streaming needs the upstream `--progress-file` (Phasing §upstream); the UI is built for it, the data just arrives coarser until then.
- **Repo without `agentHarness` config:** `standard` runs need none (probe/validate skipped, capture/stage only) — the harness workflows appear with `standard` preselected and other profiles routing to Configure.

## Risks & Impact Review
- **Blast radius:** the driver is a new module; `run.ts` changes are a dispatch seam in `execute()` plus op-kill in `cancel()`. The YAML workflow model, quick-task, variants, and every existing runner path are untouched. New events are additive; old NDJSON replays unchanged (v1-forever rule holds).
- **Drift vs the skills repo:** the real risk. Mitigation is structural — phase *content* is the installed skills, mechanics are the installed `harness.mjs`, and a contract test pins the driver's phase graph against the wrapper's documented sequence (fails loudly when the skills repo revs the workflow). Cezar never embeds harness prose.
- **Safety parity:** stage-only is enforced three ways — harness runtime assertions (unchanged), worktree hooks (installed), and the new server-side 409 guard. Worker/reviewer env stripping stays in `harness.mjs`; cezar adds no new credential surface (advisor keys are env vars the server already has or the overlay names).
- **Compatibility:** `BACKWARD_COMPATIBILITY.md`-relevant surfaces (NDJSON event vocabulary, `runs.json` shape, `startRunSchema`) change additively; a run started by an older cezar has no ledger and renders exactly as today. `.ai/agentic.config.json` stays owned by the skills pipeline — cezar reads the `agentHarness` object and writes nothing to it (setup runs as an agent task).
- **Rollback:** remove the two built-in workflows; ledgers become inert files; no migrations.

## Phasing
Each phase ships working.

- **Phase 1 — Foundation.** Ledger types + store, the five v2 events + fixtures, runtime bridge with `probe`/`validate-config`, trusted-config snapshot, `GET /harness/status`, `POST /harness/probe`, readiness table in the new-task surface (display-only). *Delivers:* the readiness/config story in the cockpit; no behavior change to runs.
- **Phase 2 — `standard` end-to-end.** `harness-fix-issue` driver: preflight → qualify → capture → diagnose → implement (`om-fix`, fresh session, freeze-tests sentinel) → validation op → fresh host review (new session) → bounded fix loop → `stage` → park at `review` with suggested commit + PR body; claim cleanup on cancel/abort; phase rail + ledger card UI. *Delivers:* the compaction-proof conductor for the default profile — the single biggest pain killed.
- **Phase 3 — Councils (`multi`) + feature entry.** `prepare-review` packets, concurrent host review ∥ `review` op, diagnosis council, council events, Review tab (status table + matrix), Models dock, blocked-council ask flow; `harness-implement-feature` (spec phase + spec council reuse the same machinery). *Delivers:* the multi-model story with live per-model visibility.
- **Phase 4 — Workers (`optimized`, `multi-optimized`).** Packet briefs from the diagnosis/spec artifacts, `worker` op dispatch, redispatch-once, worker activity in the Models dock, self-check (`◐`) rendering. *Delivers:* offloaded implementation under the same gates.
- **Phase 5 — `high-assurance`.** `packet-run`/`packet-gate`/`packet-status`/`packet-release` ops, packet mirror in the ledger, Packets tab, lease-aware messaging. *Delivers:* the full adversarial profile.
- **Phase 6 — Durability & operations.** Restart drills for every phase kind, resume-from-ledger UX, notifications/inbox for ask cards and finished councils, per-model duration/attempt rollups, artifact retention, `cezar harness probe` CLI. *Delivers:* boring 14-hour runs.
- **Upstream (skills repo, additive, non-blocking):** `--progress-file` NDJSON for live per-reviewer/attempt transitions; a short "external conductor" note in `om-harness/README.md` documenting that the runtime is conductor-agnostic (it already is — cezar is proof).

## Implementation Plan
Phase-1/2 step granularity (later phases follow the same pattern):

1. **Ledger + events.** `src/harness/ledger.ts` (types, load/save with tmp+rename, mutation→event emit); extend `src/core/ui-events.ts` + web mirror with the five `harness.*` events. *Test:* ledger round-trip; event fixtures replay through `reduceThread` without unknown-event fallout (v2 forward-compat path).
2. **Runtime bridge.** `src/harness/runtime.ts`: skill-dir resolution, arg-array spawn with timeout/kill, artifact JSON parse + schema validation, trusted-config export (`git show`), overlay pass-through. *Test:* against a stub `harness.mjs` fixture (echoes canned artifacts); timeout kill; malformed-artifact rejection.
3. **Status/probe API + start surface.** Routes per API Contracts; new-task readiness card (display + Configure reroute that starts `om-setup-agent-harness` as a normal run). *Test:* route tests with the stub runtime; probe cache invalidation on config change.
4. **Driver skeleton + `standard` graph.** `src/harness/driver.ts` with the phase-graph executor (sequential + parallel-pair + bounded loop primitives, ledger checkpoints, `execute()` dispatch, `cancel()` op-kill); phases wired to `runAgentStep` with fresh sessions and `CEZ_PHASE_RESULT` contracts. *Test:* dry-run driver against mock runner (`CEZ_DRY_RUN` path) walking the full standard graph, including fix-loop bound and phase-retry-once.
5. **Stage → review mapping + guards.** Stage op, ledger `stage` block, park-at-`review`, git-action prefill, 409 guards, claim release chip. *Test:* staged run exposes suggested commit/PR body; push/pr guarded pre-review; claim cleanup on cancel.
6. **Recovery.** Driver re-entry from ledger in `recover()`; interrupted-phase drill (kill mid-diagnose, mid-validate, mid-stage). *Test:* restart harness mid-run in each phase kind; run resumes or fails resumably, never duplicates a phase's side effects.
7. **Phase-rail + ledger-card UI.** Phase rail states from steps (existing rail) + harness pill; run-detail ledger card (profile, subject, loop counters, claim). *Test:* reducer fixtures.

## Resolved assumptions (autonomous defaults)

| # | Question | Resolved default | Rationale |
|---|----------|------------------|-----------|
| Q1 | Who conducts — TS driver, YAML workflow, or checkpointed LLM? | **TS driver over built-in workflows.** | YAML can't express parallel joins/conditional phases (verified against `workflowStepSchema`); LLM conducting is the pain being removed. Skills stay canonical for judgment content. |
| Q2 | Session policy across phases? | **Fresh session per phase; within a phase (implement+fix loop) one bounded session may iterate.** | Fresh-per-phase kills compaction; the fix loop benefits from implementation context and is bounded by the phase timeout + packet-bound re-review, and high-assurance already mandates separate fixer contexts. |
| Q3 | Where does conductor state live? | **`.ai/cezar/runs/<id>.harness.json` ledger + NDJSON events.** | Matches the file-only doctrine and the harness's artifacts-are-authoritative rule; survives restarts; UI replays events. |
| Q4 | How do human decisions flow? | **Existing ask-card mechanism + `ledger.decisions` record.** | One channel for questions already wired to UI/notifications; decisions become auditable data, matching "record the choice in the report". |
| Q5 | How does the staged handoff end? | **Cezar's `review` status = the publish checklist**, with git actions prefilled and claim-release surfaced. | The stage-only contract's human step is literally cezar's review gate; no new surface. |
| Q6 | Live council streaming v1? | **Phase-level + resolved-profile "running" states + partial-file tailing; upstream `--progress-file` later.** | Ships without forking `harness.mjs`; UI is built for finer data arriving later. |
| Q7 | Who executes tracker claim ops? | **Agent phases (the skills), v1.** | `om-verify-in-repo`/`om-fix` already own the claim protocol; only abort-cleanup gets a driver-invoked cleanup phase. Direct descriptor execution by the server is a later optimization. |
| Q8 | Does cezar write `agentHarness` config? | **Never** — setup runs `om-setup-agent-harness` as an interactive cezar task. | Keeps one config owner, reuses the reroute contract verbatim, and setup's ask-heavy flow fits cezar's waiting/ask states. |

No assumption weakens the stage-only boundary, the fresh-review requirement, or a documented compatibility contract. Q1 carries the most weight and is the spec's core claim: deterministic control flow belongs in code.
