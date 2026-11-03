# Remove completed task worktree (#1600)

## TLDR
Add a task-detail action that frees a finished task checkout while keeping its branch, record and transcript. Reuse lifecycle reclaim, including legacy worktrees with no hooks.

## Resolved assumptions (autonomous defaults)
| Question | Chosen answer | Reason |
| --- | --- | --- |
| Also add bulk/list actions? | Desktop task-detail More actions and mobile Run actions only. | One bounded capability; list actions have separate ownership. |
| Remove dirty worktrees? | Refuse tracked/untracked changes; explain ignored build files are removed. | Existing reclaim force-removes the directory, so the UI must check before requesting it. |
| Keep unpushed commits? | Permit removal and retain the local branch. | Unpushed commits live on the retained branch, not in the checkout directory. |
| Require lifecycle hooks? | No; enroll legacy worktrees through the existing operation. | Zero-config users must receive the same action. |

## Proposed solution
Desktop More actions and mobile Run actions open one confirmation. The existing lifecycle operation owns cleanup and recovery.

## Problem Statement
Issue #1600 requests freeing completed task disk space. Its maintainer comment identifies the gap: Delete task removes the record/transcript/branch, while Settings requires finding the task elsewhere. Retention already keeps branches; this action should have that outcome for one selected task.

## Architecture and API Contracts
Use `startLifecycleRemoval({requestId, runId, intent: 'reclaim'})` on the existing project-scoped lifecycle endpoint. `LifecycleCoordinator.enroll` accepts legacy task worktrees without hook configuration; `commit` passes no branch to `removeWorktree` for reclaim and writes `worktreeReclaimedAt`. No API, schema, state format, dependency or environment change.

A dedicated task-worktree-removal dialog checks the existing `/runs/:id/git/status` while open. Submit stays disabled during loading/error and for uncommitted tracked or untracked files. The mutation rechecks that endpoint immediately before requesting reclaim and refuses dirty/invalid data. This narrows the browser-to-removal race; the existing coordinator remains authoritative for active tasks, managed paths and concurrent operations. External filesystem edits between the preflight and removal remain an existing backend limitation, not an atomic safety guarantee.

Seed the returned operation into the existing lifecycle query cache, mark the task projection busy and invalidate run/lifecycle/worktree queries. Stay on the task page so the existing operation panel shows progress, cleanup failure and recovery. Do not report directory removal merely because the operation was accepted.

## UI/UX
Offer **Remove worktree…** only for done/failed/cancelled/review tasks with a worktree path, no reclamation marker, `worktree !== false`, and no active lifecycle operation. Review has released the agent and can be recreated from its branch like other settled tasks. Active queued/running/waiting tasks are excluded.

The confirmation names the task and path, says the task/transcript/branch (including unpushed commits) remain, and warns that ignored local files such as build artifacts are deleted. Commit or stash uncommitted changes first; no Force option. Cancel is the default safe choice. Loading, missing checkout, server errors and dirty state explain why removal cannot proceed. Existing AlertDialog/DropdownMenu components preserve keyboard focus and narrow-screen layout.

## Edge Cases & Failure Scenarios
- Reclaimed/absent/in-place: hide the entry; a stale recorded path fails the status preflight and sends no removal request.
- Live/conflicting operation races: show server refusal and refresh the task; never fall back to the legacy endpoint which deletes branches.
- Cleanup failure/interruption: task and directory remain under the existing lifecycle recovery panel; Retry/Keep/Force retain their established meanings. Force is an explicit separate existing operation decision.
- No configured hooks: accepted reclaim still runs as a lifecycle operation and keeps the branch.
- Unpushed/no upstream: explain local branch preservation; never claim it was pushed or backed up.
- Browser/network failure: show error, do not navigate away; ordinary task deletion stays separate.

## Research and Risks & Impact Review
[Git worktree documentation](https://git-scm.com/docs/git-worktree) separates directory removal from branch deletion and refuses dirty directories unless forced. Cezar's existing reclaim uses forced removal, so dirty preflight and an explicit ignored-file warning are necessary. No new cleanup mechanism or required configuration is introduced.

The only new surface is an additive task-detail UI action. No protected API/state/default changes; the parent owns any central compatibility note. Existing lifecycle operations provide durable recovery rather than a new state machine. Rollback removes the UI action; completed removal is recovered through Continue from the retained branch, while ignored artifacts must be rebuilt.

Design-stage visual limit: this isolated worktree has no running test-environment descriptor. Real desktop/mobile screenshots will accompany implementation QA using a private disposable project; no real task worktree or branch may be removed.

## Phasing
One phase: expose, safeguard and verify the single task-detail reclaim action.

## Implementation Plan
1. Add eligibility policy, confirmation and reclaim mutation, keeping legacy deletion behavior intact; test legacy/managed, active/in-place/reclaimed gates and dirty/error safety.
2. Wire desktop/mobile menus and verify explicit confirm/cancel, no legacy DELETE or remove-worktree endpoint requests, cache/route behavior and regression red/green.
3. Run configured five-command gate and review/autofix; verify a disposable checkout is removed while branch/record/transcript survive, including cleanup recovery and mobile QA. Publish an independent ready implementation PR with exact-head CI and evidence.

