# Local inline code review in task Changes

- Date: 2026-09-21
- Category: feature
- Priority signal: medium — a new local review capability; no outage or release deadline was identified.
- Risk signal: high — durable review data and delivery to an existing task touch persistent-state and API compatibility, which SDLC.md classifies as high-risk surfaces.
- Routing: Next: om-spec-writing "Local inline code review in task Changes — brief: .ai/specs/briefs/2026-09-21-local-inline-review.md"
- Decision owner: Jakub Tobiasz.

## Problem

Cezar's optional end-of-task review panel accepts general feedback in one textarea and can send it back to the same agent session. Task Changes displays the diff but has no line/range comment authoring. Jakub wants to give precise feedback, inspect the agent's fixes, and polish a task locally before pushing, avoiding premature remote CI runs. The existing textarea can already support local review with manually assembled file and code references; this feature improves precision and convenience. No broader demand measurement or quantified CI savings was established.

## Agreed direction

Add comments directly beneath selected lines or ranges in each task's Changes tab. The user explicitly selected inline placement over a separate side panel because the proposed inline approach keeps feedback beside its code and matches the requested GitHub-style experience; the trade-off is a taller diff. Preserve the existing general-feedback flow and setting. Deliver one coherent local review cycle: author and persist drafts after the task stops working, explicitly send a batch to that same task, inspect fixes with submitted history available, and submit only new drafts in the next cycle.

Alternatives considered:

- **Inline comments, selected:** feedback appears beside the selected code, at the cost of interrupting the diff's vertical flow.
- **Side-panel comments, not selected:** keeps the diff more compact but separates comments from their code context.
- **Build nothing/use the existing textarea:** requires no new feature and can already avoid a remote push, but the reviewer must manually assemble file paths, line references, and code context. Jakub chose inline authoring instead.

Proceed through interactive specification writing: Jakub explicitly chose to co-design the specification rather than have it drafted autonomously. This is not a small UI-only change: anchoring across edits, persisted drafts/history, and safe batch delivery require design. The brainstorm does not authorize implementation.

### Design questions for the interactive specification

The following remain open; none is an approved default:

- Map “after the task stops working” to precise run states and continuation eligibility, including absent sessions, missing/reclaimed worktrees, and a task resuming while a draft is open.
- Define accessible single-line/range selection and inline composition in existing unified/split layouts, including deleted-side lines, context lines, truncated diffs, binary files, and unavailable content.
- Choose the submission control and any confirmation/preview. A persistent “Submit review · N comments” action was suggested during brainstorming but was not independently confirmed.
- Define the original diff snapshot/context, reliable matching, renamed/deleted files, changed diff bases, and where outdated comments appear when their original code is absent.
- Design locally durable draft/history storage, absent-data compatibility for older tasks, concurrent browser updates, worktree reclamation, explicit task deletion, and upgrade/downgrade behavior.
- Specify delivery guarantees: preserve drafts after refusal/failure, avoid duplicate delivery on retry or a lost response, and define precisely when a batch becomes submitted history.
- Preserve shared diff behavior, including virtualization, navigation, wrapping, unified/split rendering, and existing non-review consumers.
- Assign the technical owner and complete the repository's compatibility and UI validation requirements before implementation sign-off.

The untested product assumption is that inline authoring materially reduces the effort of preparing actionable feedback compared with the existing textarea. Jakub's preference and desired workflow are established; frequency and measured savings are not. During interactive specification, walk through a representative multi-file review in unified and split views and inspect the exact batch the agent would receive.

The main untested engineering assumptions are that conservative anchoring preserves useful context through repeated agent edits and that submission retries can avoid both lost feedback and duplicate agent work. A small design prototype should exercise repeated identical lines, insertion/deletion/rename cases, stale snapshots, and failed/lost-response submission retries before relying on those mechanisms.

## Resolved unknowns

Every answer below was confirmed by Jakub Tobiasz during discovery or brainstorming on 2026-09-21. These answers are reproduced here so the specification can stand alone.

| Question | Answer (from the conversation) |
|----------|--------------------------------|
| Does this replace general feedback? | No. Keep the optional textarea feedback and its existing setting unchanged. |
| Must the optional feedback gate be enabled? | No. Inline review in Changes is available independently of the gate. |
| Which screens are included? | Each task's Changes tab only. Repository-wide Changes and GitHub PR Changes are outside this version. |
| Where do comments appear? | Directly in the diff beneath the selected line or range, not in a side panel. |
| What comment capabilities ship first? | Comments on individual lines and line ranges. Replies, resolve/reopen, and suggested code edits are deferred. |
| When can a user author comments? | After the task stops working. Authoring during active agent work is outside this version; exact run-state mapping remains for the spec. |
| When does the agent receive feedback? | Only when the reviewer explicitly submits the collected comments together to the same task. Creating a comment does not trigger agent work. |
| Do drafts survive interruptions? | Yes. Save locally across navigation and restarts, with edit/delete before submission. |
| What happens when code changes? | Preserve original code context. Keep comments attached when the match is reliable; otherwise mark them outdated rather than attach them to potentially unrelated lines. |
| Does outdated mean fixed? | No. It describes changed/uncertain code context, not resolution. |
| What happens after submission? | Keep submitted comments as read-only history. Later batches send only new drafts. |
| What is the acceptance outcome? | Review a completed task, submit several precise comments, inspect the agent's fixes, and only then push—all within Cezar. No numerical CI-savings target is required. |
| How should design proceed? | Interactively with Jakub, rather than autonomous specification drafting. |

## Non-goals

- Replacing, enabling by default, or otherwise changing the existing optional general-feedback gate.
- Inline authoring in repository-wide Changes or GitHub PR Changes.
- Drafting comments while the agent is working.
- Replies, resolve/reopen, or suggested code edits in this version; deferral is not a delivery commitment.
- A measured or guaranteed CI-savings percentage.
- Implementing code, opening an issue/PR, or changing tracker state during this brainstorm.

## Affected areas (if known)

- `packages/web/src/routes/task-git/task-changes.tsx`: task Changes route and diff/actions composition.
- `packages/web/src/components/diff/types.ts`, `diff-view.tsx`, and `diff.tsx`: shared diff interface, unified/split renderer, virtualization, and fallback behavior. Off-screen files can unmount, so transient per-line component state cannot be the only home for drafts.
- `packages/web/src/routes/task-thread/review-panel.tsx`: existing general-feedback Send back flow, which remains intact and provides evidence for same-task continuation.
- `packages/web/src/routes/task-thread/run-actions.ts`: current active/resumable task eligibility; the user-facing rule must be mapped without inventing lifecycle behavior.
- `packages/contract/src/`, `packages/cezar/src/server/server.ts`, and `packages/cezar/src/server/validators.ts`: contract schemas and typed, validated, versioned project routes if review operations add an API surface.
- `packages/cezar/src/runs/store.ts` and `BACKWARD_COMPATIBILITY.md` §3: existing run-state, cleanup, and additive compatibility constraints; exact review storage is not chosen.
- `packages/cezar/src/git-diff-base.ts`: existing task-diff anchor semantics that the review design must account for; no change to this helper is preselected.
- `AGENTS.md` and `SDLC.md`: zero-config, shared-component/API/state invariants, and validation/QA requirements.

### Evidence and handoff limits

The local discovery records are `.ai/specs/research/decisions/2026-09-21-local-inline-review-d01.md` through `d09.md`. They contain Jakub's confirmed decisions, but the resolved-unknowns table above reproduces their requirements; the downstream skill must not depend on those uncommitted records being present in a new worktree. The discovery product brief was not written: its final confirmation was pending when Jakub invoked brainstorming.

The configured checkout remote is `jakubtobiasz/om-cezar`. Its issues are disabled, so issue deduplication could not be completed there. Open-PR searches for “inline review”, “review comments”, and “line comments” returned no matches on 2026-09-21; this is a limited search of that remote, not proof that no related work exists upstream.

GitHub's [review documentation](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request), checked 2026-09-21, supports line/range comments collected into a pending review as an interaction benchmark. It is not evidence of Cezar adoption or savings.
