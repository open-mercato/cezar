# Multi-model workflows

Multi-model workflows separate planning, implementation and review into fresh
model sessions. They produce a validated, staged diff and stop at the task's review
gate. Publishing remains a separate user action.

## Enable the feature

The feature is off by default, per cezar instance. Start the instance with:

```sh
CEZ_MULTI_MODEL=1 cezar
```

This reveals the **Multi-model** composer, **Harness** settings, built-in workflows
and bundled skills for every project served by that instance, including projects
added later. Other cezar instances remain unaffected. Only the exact value `1`
enables the feature; restart the instance after changing its launch environment.

Repository config files and the project config API cannot enable or disable it.
`GET /api/v1/p/:projectId/config` reports the effective instance flag as the
read-only `multiModel` field. Earlier local `multiModel` config keys are ignored.

Restart without `CEZ_MULTI_MODEL=1` to disable new runs and live probes. Existing
tasks retain their evidence and can continue using their saved workflow.
`CEZ_DRY_RUN=1` blocks live harness execution and probing.

## Start a task

Choose **Build a feature** for specification, implementation, validation and review,
or **Fix an issue** for qualification, diagnosis, implementation and review. Both
use isolated worktrees, including in projects configured for trunk development or
automatic landing. Supply a text task; attachments are not supported by these phases.

Choose an orchestrator, implementer and 2–5 distinct reviewers spanning at least two
model families. Claude and Codex can orchestrate or implement. OpenCode catalog
models can review through structured gateway calls. Models from the same family
remain one family even when accessed through different gateways. Native model
locking must be off to choose a lineup.

The composer probes the selected bindings and shows readiness beside the models.
Readiness checks model access even outside a Git repository; starting a writing
workflow still requires a Git checkout for its isolated worktree.
You can keep editing the prompt while a check blocks submission. Fix missing
logins or unavailable models before starting; execution does not silently substitute
another model. Omitting a lineup through the API selects the standard Claude flow
with a fresh Claude review.

Use the generic skill profile for other repositories. The Open Mercato profile is
an explicit choice for repositories that have the canonical `om-*` playbooks.
Bundled generic skills require no separate installation or startup download.

## Follow progress and resolve decisions

The task shows the current phase, validation results, review findings and model
usage. Open the timeline for phase history or a reviewer for its evidence. Each
phase receives saved conclusions and artifacts, rather than earlier transcripts.

Validation regressions trigger a bounded repair loop before reviewers run. Review
findings can trigger up to three review rounds. A council normally needs two
completed reviewers from two independent families. If it loses quorum, the task
asks you to retry failed reviewers or explicitly proceed with the survivors.

A final fix that was validated but not reviewed again produces a **contested**
outcome. Inspect its findings and staged diff before explicitly accepting it.
Publication actions stay blocked until the server verifies a staged outcome and,
for contested work, records that acceptance.

Feedback sent between phases is queued durably. Feedback on completed work starts
implementation again and reruns validation and review. After interruption, Continue
uses the saved phase and round state; completed model calls are reused only when
their input and artifact hashes still match. Corrupt or unsupported state fails
closed rather than starting another paid run. Stop cancels the owned sessions and
adapter processes.

## Execution boundary

The harness does not commit, push or open PRs. Writing phases run under a required
sandbox, with dispatch and publish capabilities removed from their environment.
Codex permits writes only to the worktree, phase output and run-specific temp
directory; the shared `/tmp` and host `TMPDIR` are excluded.
Git verification checks HEAD, the task branch and their reflogs between phases;
staging must match the changed paths derived from Git. Trusted skills, runtime and
validation policy are pinned outside the model-writable worktree.

Two limits matter when choosing a repository to run: Codex cannot deny reads of
arbitrary credential files, and validation commands execute repository code outside
the agent sandbox. Validation removes provider/publish credentials from its
environment but does not prevent code from reading the user's disk. Review the
staged deliverable before publishing.

Claude's macOS sandbox requires the optional bundled sandbox runtime. If sandboxing
is unavailable, the harness phase refuses to run; ordinary cezar tasks keep working.
A missing reviewer or provider failure is shown as readiness or run evidence.

## Implementation references

| Area | Source |
| --- | --- |
| Current execution, recovery, API and UI design | [Orchestration spec](../.ai/specs/2026-07-23-harness-orchestration.md) |
| Skill provenance and materialization | [Bundled skills spec](../.ai/specs/2026-07-24-vendored-cez-skills.md) |
| Phase driver and durable ledger | `packages/cezar/src/harness/driver.ts`, `ledger.ts`, `types.ts` |
| Deterministic operations | `packages/cezar/src/harness/runtime.ts`, `packages/cezar/vendor/skills/cez-harness/scripts/harness.mjs` |
| Reviewer transports and quorum | `packages/cezar/src/harness/reviewer-binding.ts`, `council-quorum.ts` |
| Model families and HTTP schemas | `packages/contract/src/model-family.ts`, `harness.ts` |
| Composer and review UI | `packages/web/src/routes/new-task-multi.tsx`, `task-harness/` |
