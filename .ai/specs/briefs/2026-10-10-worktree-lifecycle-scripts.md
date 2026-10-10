# Local worktree lifecycle scripts

- Date: 2026-10-10
- Category: feature
- Owner: repository owner / requesting user
- Status: agreed discovery direction; prototype requested, not a final specification
- Priority signal: medium — automate local environment preparation and cleanup alongside worktree lifetime.
- Risk signal: high — script failures and interrupted execution intersect with destructive worktree removal.
- Next activity: `om-mockup-prototype`, authorized by the user; stop for prototype review.

## Problem

A Cezar user may need to build/start a Docker Compose environment before an agent uses a worktree, then remove its containers and volumes before that worktree disappears. Manual commands or workflow-only setup are disconnected from automatic worktree reclamation. Different users may need different scripts for the same project. This need is reported directly by the requesting user; frequency, broad demand and time savings have not been measured.

## Product and scope

Cezar is a local coding-agent cockpit. This first slice concerns the lifetime of Cezar-managed worktree directories, not general task lifecycle events. The actor is a local project user configuring and operating their own script lists. Scripts can operate on Docker or other resources; Cezar is not becoming a Docker environment manager.

## Agreed direction

Two ordered lists of scripts, configured locally per project through Project Settings and held in existing `.ai/cezar/config.json`: setup after worktree preparation and before the agent starts, and teardown immediately before physical worktree removal while its files remain available. Empty lists leave current behavior intact. Multiple scripts execute sequentially and stop at the first failure, with visible results and recovery choices.

The conversation considered built-in Compose environment management, generic lifecycle scripts, and building nothing (workflow setup plus manual cleanup). Generic scripts fit differing local needs and address removal/retention paths that workflow setup does not cover. Shared, committed hook lists were explicitly deferred because users need different local commands.

## Decisions and business rules

Source for D01–D09: this brainstorming conversation, reaffirmed by the user's instruction to preserve agreed decisions. Owner: requesting user. These are the agreed direction; changes require that user's confirmation.

| ID | Decision |
|---|---|
| D01 | Scope is worktree lifecycle first. Tasks without worktrees execute neither list. |
| D02 | Setup runs after a worktree is prepared and before the agent begins. Continuing in a recreated, previously reclaimed worktree runs a fresh setup sequence. |
| D03 | Teardown runs before worktree removal, while files still exist. Include explicit task deletion with a worktree, manual worktree removal and automatic retention reclamation. |
| D04 | Each lifecycle hook supports multiple ordered scripts, executed sequentially. A failure stops the sequence. |
| D05 | Setup failure keeps the agent from starting until the user chooses Retry, Start task anyway, or Cancel task. Start task anyway skips the failed and remaining setup scripts for that attempt. |
| D06 | Teardown failure preserves the worktree. Offer Retry, Keep worktree, or Force delete. Force deletion skips the failed and remaining scripts without re-executing them and explains that external resources may remain. |
| D07 | Within the same recorded attempt, Retry resumes at the failed script and then executes remaining scripts; known successful scripts are not repeated. Crash ambiguity remains unresolved; this is not an exactly-once promise. |
| D08 | Automatic cleanup failures create a persistent needs-attention item rather than an unsolicited modal or repeated automatic retries. Other eligible worktrees can still be reclaimed; the retained count may temporarily exceed the limit. |
| D09 | Configuration is local/non-shared per project, editable in Project Settings. Empty lists are the default. Finishing or archiving without removing a worktree does not execute either list. |

## Complete user flow

### F01 — Configure scripts

1. Open the project's Settings → Worktrees (existing section; placement of the new controls is A01).
2. See separate setup and teardown lists, their trigger descriptions, and that they apply locally to this project.
3. Add multiple entries, edit them, change their order and remove them. An empty list is valid.
4. Save explicitly. Blank added entries produce a useful inline validation error and can be corrected or removed; successful save is acknowledged.
5. Leave and return without losing saved configuration during the simulation. No prototype setting is written to Cezar's real config.

### F02 — Execute setup

1. Start a simulated task with a worktree. The task can be queued before the worktree exists; setup belongs to actual preparation, not initial record creation.
2. After the worktree is ready, show setup progress, script order and individual status/output. The agent is waiting.
3. On success, begin the agent task. With no scripts, begin directly. Without a worktree, do not execute setup.
4. Finishing or archiving preserves the worktree and triggers no scripts. Continuing with an existing worktree does not imply a fresh creation event.

### F03 — Recover from setup failure

1. Show the failed script and logs, earlier successes and later scripts not run; retain the worktree and keep the agent waiting.
2. Retry reruns the failed entry, then remaining entries, and starts the task after success.
3. Start task anyway explicitly skips failed/remaining setup entries for this attempt, then starts the task.
4. Cancel prevents the agent from starting. Post-cancellation resource policy is unresolved (Q01); the prototype conservatively retains the directory and makes explicit removal available (A04), without claiming rollback.

### F04 — Remove a worktree or delete a task

1. From an inactive task or worktree-management view, choose removal or task deletion. Confirm the destructive operation, using Cezar's existing confirmation-dialog pattern.
2. Keep the worktree available while executing the teardown list in order with statuses and logs.
3. On success, perform the original removal operation. Reclamation retains the task and branch; explicit worktree deletion uses current semantics (directory and branch removed); task deletion removes its record as well.
4. With no teardown entries, proceed directly. Task deletion without a worktree does not run teardown.

### F05 — Recover from teardown failure

1. Stop at the failed entry, show logs, and retain the directory and task record.
2. Retry resumes from the failed entry, then completes removal on success.
3. Keep worktree dismisses the pending removal attempt without claiming cleanup succeeded; resources may already have been partly cleaned.
4. Force delete confirms skipped scripts and possible external leftovers, then removes the worktree according to the original operation without running scripts again.

### F06 — Automatic cleanup and recreation

1. A finished worktree selected by retention executes teardown before deletion.
2. On failure, persist an actionable needs-attention item; no blocking dialog or hot retry loop. The user can navigate away and return to resolve it using F05.
3. On successful reclamation, preserve the task and branch and show that the directory was reclaimed.
4. Continuing the task recreates its worktree and executes a fresh setup sequence before the agent starts.

## Resolved unknowns

| Question | Answer |
|---|---|
| Task events or worktree events? | Worktree creation/removal only for the first slice. |
| One script or several? | Multiple ordered scripts in each of two lists. |
| Setup gating? | Wait before agent start; user can explicitly bypass on failure. |
| Failed cleanup? | Preserve directory and ask user to retry, keep it or force removal without scripts. |
| Shared config? | No. Local per-project configuration; users may need different commands. |
| Build what next? | A clickable prototype for user review, not a final spec or production implementation. |

## Assumptions for the prototype

The user authorized a simulation of the agreed scope with assumptions marked. These are not additional accepted product requirements.

- [ASSUMPTION] A01: Place lists inside existing Settings → Worktrees; show execution cards in the task Session view and cleanup attention in Worktrees. Reuses observed settings/task structures; validate placement with the prototype review.
- [ASSUMPTION] A02: Each entry has an optional display name and required script command text. Paths, quoting, shell selection, arguments and final execution format are unresolved. All displayed script names/commands are fictitious and never executed.
- [ASSUMPTION] A03: Execute relative to the worktree directory; present the directory to the user. Exact environment variables and stable resource identity contract are future design work.
- [ASSUMPTION] A04: Cancel after partial setup retains the worktree/resources and offers explicit removal. This makes the prototype operable without silently inventing an automatic rollback policy.
- [ASSUMPTION] A05: A sequence snapshots its configured list when it begins. Edits affect future attempts; Retry uses that attempt's list. Editing a failed script on disk is outside the simulation. Hook-list edit semantics remain Q03.
- [ASSUMPTION] A06: Prototype test controls advance deterministic script completion and inject one failure (second entry, or first when alone). Retry succeeds in the fixture. Fictitious commands/output prove navigation, not real integrations.
- [ASSUMPTION] A07: Store and task-setting failures can be retried without losing draft input; prototype has a save-failure test state. Persistence/restart mechanics are not implemented.

## Open questions

- Q01: What cleanup/rollback should cancellation after partial setup initiate, if any?
- Q02: Timeouts, cancellation of a running script, exit-code handling, output limits/redaction, shell/argument format and environment context need specification.
- Q03: How should hook-list edits affect existing worktrees and failed attempts? What if a script/runtime no longer exists?
- Q04: How should interrupted attempts and uncertain script completion recover across process restarts? Scripts may need to tolerate retries; no exactly-once guarantee is established.
- Q05: Should startup orphan cleanup invoke teardown, and from which trusted configuration when the task record is missing? This was discovered in code, not explicitly decided by the user.
- Q06: How should execution approvals, remote mode and configuration portability interact with local commands? The local choice to add scripts is established; no new trust system was agreed.
- Q07: How do concurrent worktrees obtain unique external resource names and ports? Docker-specific naming is the script author's concern, but Cezar-provided context needs design.
- Q08: How should cleanup history survive task deletion, and when can a retained cleanup-needs-attention item be retried automatically? No retry schedule was agreed.

## Non-goals

- General task lifecycle events, read/unread hooks, or archive-only hooks.
- Hooks for tasks without worktrees.
- Shared committed hook configuration or global script inheritance.
- Native Docker orchestration, health checks, port allocation or volume ownership management.
- Final specification, production code, actual script execution, tracker changes or deployment during this activity.
- Treating a prototype, synthetic hypotheses or browser verification as demand evidence or Definition of Ready.

## Existing implementation evidence

- `packages/cezar/src/workflows/run.ts`: record creation precedes execution; initial worktree setup and rematerialization are separate paths.
- `packages/cezar/src/runs/retention.ts`: finished-directory reclamation retains branch/task; review/live runs excluded.
- `packages/cezar/src/git-worktree.ts`: creation/removal and startup orphan cleanup.
- `packages/cezar/src/config.ts`: optional project config and defaults.
- `packages/cezar/src/server/server.ts`: configuration writes, archive, deletion and worktree operations.
- `packages/web/src/routes/settings/settings-shell.tsx`, `settings-field.tsx`, `worktrees-section.tsx`, `worktrees-panel.tsx`: section navigation, labelled fields, explicit Save and destructive confirmation dialogs.
- `packages/web/src/routes/task-thread/run-header.tsx`, `task-thread.tsx`: task header, status, Session tab and execution transcript.

Tracker check during brainstorming: matching open PR searches for lifecycle/hooks/docker cleanup returned no hits; issues are disabled on the configured origin. No panel report was supplied. A fresh-context challenger found no routing blocker; its cautions are captured above.
