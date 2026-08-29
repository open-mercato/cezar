# Follow-up tasks: a fresh run that follows a prior one

> Covers: #817 (start a fresh run that carries a prior session's context), #779 (a task keeps only its last PR link). Builds on: `2026-08-11-reference-status-chips.md` (the chip grammar the chain rides), spec 010 (parallel variants — the `groupId` pattern this mirrors).

## TLDR

A task can be started *from* another task. The new run is a clean session with its own worktree and its own steps, but it knows its predecessor: one optional field, `follows`, points at the prior run, and from that one pointer the engine inherits the branch and the pull request, seeds the handoff journal with the predecessor's resume notes, and the cockpit draws the chain — in the thread header, the sidebar and the tables. No tree, no sub-tasks, no blocking: a task follows at most one task, and "the chain" is what you get by walking the pointers. That is the whole model, and it is the smallest one that closes both issues.

## Resolved assumptions (autonomous defaults)

| # | Question (from #817) | Applied default | Why |
|---|----------------------|-----------------|-----|
| Q1 | What does "carry history" mean? | **Handoff resume notes + a summary, not the transcript and not a provider fork.** The new run's handoff file is seeded with the predecessor's `## Resume notes` and its progress excerpt; the composer is prefilled with a one-paragraph summary the user can edit. | Re-feeding a whole transcript costs the context window the fresh run exists to reclaim, and a provider-native fork exists for exactly one runner. The handoff journal already is the engine's answer to "what should the next session know" (`handoff.ts`) — this spec makes it flow across runs instead of dying with each one. |
| Q2 | Entry point? | **"Follow up" in the thread header's action row** (and in the kebab below `md`), on any run that is not queued or running. It opens the `/new` composer prefilled; nothing starts until the user sends. An option on Continue is rejected. | Continue means "same session, same run". A follow-up is a new task and must be created where tasks are created, with every composer choice (runner, model, workflow, variants) still available. Putting it under Continue would hide the one decision that matters — new task or same session. |
| Q3 | Worktree? | **Inherit the predecessor's branch; fresh worktree checked out on it.** The in-place (`worktree: false`) policy is inherited too. | The work lives on the branch, not in the directory: a fresh worktree on the same branch keeps the follow-up isolated from the predecessor's leftover state while continuing its commits — and a PR opened on that branch keeps growing, which is what "follow-up" means to a user. Retention (#483) may already have reclaimed the old directory; the branch survives it. |
| Q4 | How does the new run link back? | `follows: <runId>` on the record, set at creation, immutable. The predecessor is not written to — its `followedBy` is derived by the index. | One direction of truth is enough and cannot drift; the reverse edge is a query. Writing both would make every delete a two-record transaction for no gain. |
| Q5 | What about the PR? | The follow-up **inherits the predecessor's PR as its own** (`pullRequestUrl`/`prNumber`) when one exists and is open. If the follow-up later opens a different PR, both are kept (#779): the record gains `pullRequestUrls[]`, the chip shows the newest and the panel lists the rest. | Single-valued `prNumber` is the bug #779 describes, and a chain is where it bites hardest. Additive: existing fields keep their meaning as "the newest", the list is the history. |
| Q6 | Stacked PRs? | **Out of scope for the engine, enabled for the user.** A follow-up whose predecessor has an open PR may choose *Start a new branch from it* in the composer; the new branch's base is the predecessor's branch, and a PR the agent opens targets it. Cezar records `baseBranch` and draws the stack; it does not rebase or retarget anything. | Graphite-grade stack management is a product of its own. What cezar owes a user is to not get in the way and to show the shape — which the `follows` chain plus `baseBranch` already says. |
| Q7 | Cross-project follow-ups? | No. `follows` must name a run in the same project. | A branch and a PR are project facts; a follow-up that crosses repos has nothing to inherit and is simply a new task that mentions another. |
| Q8 | Variants? | A follow-up can be started with `variants: 2|3` like any task; every member gets the same `follows`. Following a *variant* follows that member, not the group. | The group is a sibling relationship, the chain is a sequence; they compose without special cases. |

## Problem Statement

Three carry-over mechanisms exist and none is "a fresh run that knows what came before" (the issue's own analysis, confirmed in `src/workflows/run.ts` and `src/handoff.ts`):

- **Continue** reopens the same provider session in the same run — no fresh context, no new worktree, no new runner choice.
- **The handoff journal** is keyed by `runId`; a new run starts with an empty one.
- **Inbox → start** seeds a new run from a follow-up's *suggested prompt* — a suggestion, not the work's state.

Users route around it by pasting summaries into new tasks and by re-using Continue past the point where the session is worth keeping. Both lose information: the first loses the branch and the PR (a second PR appears for the same work — #779's first bullet), the second loses the fresh start the user wanted.

## Research

- **Record surface.** `RunRecord` already carries everything a follow-up inherits: `branch`, `baseBranch`, `worktree`, `pullRequestUrl`/`prNumber`, `issueNumber`, `referencedIssueUrl`. `groupId`/`variant` (spec 010) is the precedent for a relation expressed as a plain field and rendered as a group.
- **Creation input.** `createRunInputBaseSchema` has `todoId` — a run created *from* something else, validated server-side. `follows` takes the same shape and the same seam.
- **Handoff.** `seedHandoffFile(dataDir, run)` writes the initial journal; `readHandoff` + `handoffProgressExcerpt` already extract the resume-worthy part for the compare view (`handoffExcerpt`). Seeding a follow-up from its predecessor is a read and a write on existing functions.
- **Index.** `runIndexEntrySchema` is the slim cross-project shape the palette, the global page and the sidebar band read. Adding `follows` there is one optional field; deriving `followedBy` is one pass over the list.
- **UI.** The reference chip (spec 2026-08-11) is the established way to say "this task points at a thing". A chain link is the same grammar pointing at a task.

## Proposed Solution

1. **Contract.** `RunRecord.follows?: string` (same project's run id). `createRunInputBaseSchema.follows?: string`. `pullRequestUrls?: string[]` (history, newest last) beside the existing single-valued fields, which keep meaning "the newest". `RunIndexEntry.follows?: string`.
2. **Creation.** `POST /p/:projectId/runs` with `follows`: validate the predecessor exists in this project and is not queued/running; copy `branch`, `baseBranch`, `worktree`, the open PR, the issue reference; create the worktree on the inherited branch; seed the handoff file with the predecessor's resume notes under a `## Followed from <id>` heading. Reject (409) a predecessor mid-run: its branch is being written to.
3. **Composer.** `/new?follows=<id>` prefills the prompt with the predecessor's title and progress excerpt, shows a **Follows** chip (with ×) above the prompt, and offers *Start a new branch from it* when a PR is open (Q6). Everything else is the normal composer.
4. **Header action.** *Follow up* beside the primary CTA on done/cancelled/failed/review/waiting runs (the kebab below `md`). Navigates to the composer; starts nothing.
5. **Chain rendering.** Thread header meta row: a `follows #<short>` chip linking back, and `→ <next>` chips for runs that follow this one. Sidebar and tables: a chain collapses like a variant group (one tile, expand to walk it), newest on top; the group tile carries the newest status and the chain's summed cost.
6. **PR history (#779).** Every PR the task ever declared stays in `pullRequestUrls`; the chip shows the newest, its panel lists the rest with their statuses (the status provider already batches by number).

## Architecture

### Engine

- `startRun` gains an optional `follows` branch before worktree creation: `inheritFromPredecessor(record, predecessor)` — a pure function over two records, unit-tested alone. Fields copied: `branch`, `baseBranch`, `worktree`, `pullRequestUrl`, `prNumber`, `referencedIssueUrl`, `issueNumber`, `referencedPullRequestUrl`. Not copied: anything about sessions, steps, tokens, cost, usage, `seenAt`, `archived`.
- Worktree: `git-worktree.ts` already checks out an existing branch when asked; the follow-up path asks. A reclaimed directory (#483) is recreated from the branch. An in-place predecessor (`worktree: false`) yields an in-place follow-up on the same checkout; the 409-while-running rule above is what makes that safe.
- Handoff: `seedHandoffFile` accepts an optional `inherited: { fromRunId, resumeNotes, progressExcerpt }` and writes them under `## Followed from`. The agent's resume prompt (already built from the journal) picks them up with no prompt changes.
- Store: `applyMarkerRefs` appends to `pullRequestUrls` instead of overwriting; the single fields keep being assigned the newest. Migration: none — absent list means "only what the single fields say".
- Index: `follows` is copied onto the entry; `followedBy` is not stored (derived client-side with one `Map<follows, id[]>`).

### Web

- `lib/task-chains.ts` — pure: `chainsOf(runs)` returns `{ root, members[] }` groups from `follows` pointers (orphans whose predecessor is archived or deleted render as roots; a cycle is impossible because `follows` is set once at creation to an existing older run, but the walker still caps depth). Table-tested like `task-groups.ts`.
- `task-groups.ts` learns a third row kind next to `run` and `group`: `chain` — collapsed tile with the newest member on top. Reuses the group tile's expand/collapse.
- Composer: reads `?follows`, fetches the predecessor, prefills, renders the chip. Unset on ×.
- Header: `run-actions.ts` `runActionFlags` gains `followUp` (true unless queued/running); `run-header.tsx` renders the button and the chain chips in `MetaRow`.
- Chips: `ReferenceChip` gets a `kind: 'Task'` that links within the app (no status fetch); the PR chip's panel lists `pullRequestUrls` beyond the newest.

## UI/UX

- **Thread header, done run:** `[Reopen]  [Follow up]  [Open in ▾]  [⋯]`. Follow up is an outline button; Reopen keeps the primary slot (the stateful CTA rule from the cockpit audit).
- **Composer with `?follows`:** under the title, a quiet chip row: `follows  #8f31 Structured changes endpoint  ×`. Prompt prefilled: *"Follow-up to: Structured changes endpoint. Where it left off: <progress excerpt>."* Below the runner/model pickers, when the predecessor has an open PR: a checkbox *Start a new branch from `cez/8f31ab02` (stacked PR)* — off by default.
- **Meta row:** the chip row gains `follows #8f31` after the workflow, branch and PR chips (chips spaced by the row gap, never glyph separators), and on the predecessor: `2 follow-ups` with a chevron, opening a small list.
- **Sidebar / tables:** a chain is one row with a `⟩ 3` tail like the `×3` variant badge; expanded, members indent under it newest-first, each with its own status dot. The chain's cost in the table is the sum; the tooltip breaks it down.
- **Empty predecessor context:** a run with no handoff notes still seeds the title; the composer says so in the placeholder rather than inventing a summary.

## Edge Cases & Failure Scenarios

- Predecessor deleted after the follow-up was created → `follows` dangles; the chip renders as `follows (deleted)` inert, the chain walker treats the follow-up as a root. Nothing else changes.
- Predecessor archived → still followable (the branch exists); the chain shows the archived member dimmed.
- Predecessor's branch deleted on the remote / locally → creation fails with the git error verbatim (same path as any worktree failure); nothing is written.
- Follow-up of a follow-up → a chain of three; depth is unbounded in data and capped at 50 in the walker.
- Two follow-ups of one run → a fork; both render under the same root, ordered by creation. No merge semantics — they are two tasks on one branch, and the user chose that.
- Predecessor in-place and running → 409 with `predecessor is running` (Q3).
- `variants: 3` with `follows` → three members, one `follows` each; the chain tile nests a variant tile.

## Risks & Impact Review

- **Compatibility:** additive only — new optional fields on `RunRecord`, `RunIndexEntry` and the create input; `pullRequestUrls` supplements rather than replaces. Per `BACKWARD_COMPATIBILITY.md` this stays `risk-medium`; the handoff file gains a heading, which older versions ignore.
- **Wrong inheritance** is the real risk: a follow-up silently committing to a branch the user did not expect. Mitigation: the composer chip names the branch, and the stacked-PR choice is explicit and off by default.
- **Chain rendering** touches the two most-tested lists in the cockpit; the `chain` row kind goes through `task-groups.ts` so the ordering tables catch regressions.

## Testability

- Unit: `inheritFromPredecessor` (field table, never copies session/cost fields), `chainsOf` (roots, forks, dangling, depth cap), `applyMarkerRefs` history (newest wins the single field, list keeps all).
- Integration: finish run A with resume notes → create B with `follows: A` → B's worktree is on A's branch, B's handoff contains A's notes, B's first prompt sees them; A running → 409.
- Web: composer prefill from `?follows`; header shows Follow up on every non-running status; chain tile expands newest-first; PR chip panel lists history.
- e2e: the full loop through the fixture server with `CEZ_DRY_RUN=1`.
