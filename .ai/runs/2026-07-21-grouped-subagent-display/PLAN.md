# Execution plan — grouped sub-agent display within a single session

**Run:** `2026-07-21-grouped-subagent-display`
**Branch:** `feat/grouped-subagent-display`
**Base:** `main`
**Source spec:** `.ai/specs/2026-07-20-grouped-subagent-display.md` (merged in #522)
**Issue:** #474

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Sub-agent collector (`subagent-dock.ts`) | done | bd205e4 |
| 1 | 1.2 | Codex mapper: fold review mode into one task item | done | 40d23aa |
| 1 | 1.3 | `mock:subagents` trigger in the claude mock | done | ad2ed43 |
| 1 | 1.4 | AgentsDock component + task-thread mount | done | e021935 |
| 2 | 2.1 | SubagentSheet drill-down + dock row buttons | done | a094ea4 |
| 2 | 2.2 | Finished-run parity from replayed state | done | 87ac53a |
| 3 | 3.1 | e2e smoke, opencode mapper hardening, mockup sync | done | 06436c3 |
| 3 | 3.2-review-fix | Sheet outlives the dock's Q6 visibility rule | done | bd35f32 |
| 3 | 3.3-review-fix | Codex latch leaks; anchor drops live agents; plan children; follow-tail | done | 73f15c7 |
| 3 | 3.4-review-fix | Turn-granular bounded carry-over; stalled agents on terminal runs | done | 99c2fb1 |
| 3 | 3.5-review-fix | `review` counts as terminal; head/row share one activity string | done | 27d446b |

## Goal

Ship ask 3 of issue #474: a grouped live display of a session's sub-agents — an **Agents dock**
pinned above the composer plus a **drill-down sheet** — working across claude, codex and
opencode. Asks 1 and 2 (the spec and the HTML mockups) already landed in merged PR #522.

## Scope

Per the spec's Architecture section, this is almost entirely cockpit UI derived from reducer
state that is already on the wire:

- `web/app/src/routes/task-thread/subagent-dock.ts` — new pure collector.
- `web/app/src/routes/task-thread/agents-dock.tsx` — new dock component (PlanDock pattern).
- `web/app/src/routes/task-thread/subagent-sheet.tsx` — new drill-down sheet.
- `web/app/src/routes/task-thread/task-thread.tsx` — one mount point above `PlanDock`.
- `web/app/src/routes/task-thread/thread-items.tsx` — export the currently module-private
  `NestedEntry` so the sheet can reuse it.
- `src/core/codex-ui-mapper.ts` (+ its golden fixture) — fold `enteredReviewMode` /
  `exitedReviewMode` into one task item with a running→completed lifecycle.
- `scripts/mock-claude.mjs` — `mock:subagents` trigger for dry-run QA and e2e.
- `web/app/e2e/` — one smoke spec; `docs/mockups/thread.html` — dock styling sync.

## Non-goals

Explicitly out of scope, per the spec's Research section and Q4/Q5:

- No new protocol event, no schema change, no store/`RunRecord` change, no HTTP route change.
- No new `CEZ_*` env var (pure display ⇒ zero-config, `.env.example` untouched).
- No change to the existing inline thread nesting — the dock and sheet are additive (Q4).
- No cross-run agent trees, per-sub-agent token accounting, or per-agent pause/steer controls.
- No deep-linking to a sub-agent (sheet state is ephemeral component state, Q2/Q5).

## Risks

- **Q6 visibility rule is the subtle part.** The dock anchors to the most recent turn with
  parent-less task items and must survive mid-run steering (a user message opens a new turn
  while agents still run). Covered by dedicated collector unit tests.
- **Cross-turn child gathering.** Late child items land in turns after the anchor; the collector
  must gather children across the anchor turn *and every later turn*, or counts/activity go stale.
- **Codex fixture churn.** Step 1.2 changes a golden fixture expectation; the unpaired-exit
  fallback must keep working so old codex runs still map.
- **Known limitation (deliberately NOT "fixed" here):** the opencode mapper holds a single
  active-subtask slot, so overlapping subtasks can leave the first stuck `running`. Step 3.1
  originally settled the displaced subtask as `completed`; adversarial review showed that
  fabricates a success that never happened while leaving the real defect (foreign parts are
  scoped to whatever occupies the slot, so A's output is misattributed to B) untouched. The
  change was REVERTED — a visibly stuck row is honest; a false `completed` is not. The real
  fix is a session-id-keyed scope map, which is out of scope for this PR.
- **Post-reload activity lines.** `item.delta` frames are live-only and never persisted, so the
  activity line after a reload falls back to the last persisted child snapshot. Accepted and
  documented in the spec.

## External References

None — no `--skill-url` was passed. The authoritative reference is the in-repo spec.

## Implementation Plan

### Phase 1 — Collector + Agents dock

**Step 1.1 — Collector.** Add `web/app/src/routes/task-thread/subagent-dock.ts` exporting
`SubagentSummary`, `collectSubagents(turns)` and `subagentCounts(agents)` exactly as the spec's
Collector section specifies: anchor turn = most recent turn containing parent-less
`toolKind: 'task'` items; children gathered by `parentItemId` across the anchor turn and every
later turn; `activity` from the most recent child (tool `title`, else last non-empty text line,
truncated); `agentType` from `subagent_type` / `subagentType` / `agent`; Q6 visibility.

*Test:* unit — parent-less task items collected in stream order; nested task items excluded;
children counted across later turns (steering scenario); activity derived from last child (tool
title vs text line, truncation); `agentType` from all three input keys; no children ⇒
`activity: undefined`; orphaned `parentItemId` ignored; settled anchor + newer turn ⇒ `[]`;
non-task turns ⇒ `[]`.

**Step 1.2 — Codex-mapper fold.** In `src/core/codex-ui-mapper.ts`, `enteredReviewMode` starts
one task item with status `running`; `exitedReviewMode` completes *that same item*, falling back
to today's standalone-item shape when no entered-item is open.

*Test:* golden fixture — the codex review-mode expectation becomes one task item with a
running→completed lifecycle; an unpaired `exitedReviewMode` still maps.

**Step 1.3 — Mock trigger.** Add `mock:subagents` to `scripts/mock-claude.mjs` (same pattern as
`mock:md`), replaying a canned parallel-Task stream-json sequence: 2–3 `Task` tool_uses,
interleaved child items carrying `parent_tool_use_id`, then the tool_results.

*Test:* the trigger emits `Task` tool_uses and children with `parent_tool_use_id`; reducing the
sequence yields 2 `SubagentSummary` rows.

**Step 1.4 — AgentsDock component.** Add `agents-dock.tsx` modeled on `PlanDock` (module-level
per-run collapse memory, desktop-open/mobile-collapsed default, `data-slot="agents-dock"`,
`--grad` hairline, semantic tokens only, plan-dock glyph language, `BotIcon` in the head);
mount it in `task-thread.tsx` directly above the `PlanDock`, keyed by run id.

*Test:* component — hidden with no task items; collapsed head shows odometer + first-running
activity; expanded rows show glyph/title/badge/count; a completed fan-out shows `N/N`;
`design-guardian` stays green.

### Phase 2 — Drill-down sheet

**Step 2.1 — SubagentSheet.** Add `subagent-sheet.tsx`: a controlled `Sheet` with header (title,
`agentType` badge, status pill, tool-call count) and the selected parent's child entries in
stream order via a newly-exported `NestedEntry`, inside a `ScrollArea` with follow-tail; muted
empty state for a childless agent. Dock rows become `aria-haspopup="dialog"` buttons setting the
selected id.

*Test:* component — row click opens the sheet with exactly that parent's children in order; the
empty state shows for a childless agent; live append while open renders; Esc/overlay closes and
resets; an agent completing while open flips the status pill only.

**Step 2.2 — Finished-run parity.** Ensure the sheet renders from replayed state.

*Test:* reduce a full fixture-derived event list (the `subagent-task` fixture ⇒ client shape),
open each agent, assert content matches the expected children.

### Phase 3 — Polish & docs

**Step 3.1 — e2e smoke + mapper hardening + design mockup sync.** One `web/app/e2e` spec driving
`mock:subagents` (dock appears → expand → open sheet → agent content visible); extend
`docs/mockups/thread.html` with the dock per the shipped styling; optionally harden the opencode
mapper for overlapping subtasks; cite the spec from the new component headers in the house
`spec §` comment style.

*Test:* the e2e spec itself; full validation gate green.

## Handoff & Notifications

- Live handoff: `.ai/runs/2026-07-21-grouped-subagent-display/HANDOFF.md`
- Notifications log: `.ai/runs/2026-07-21-grouped-subagent-display/NOTIFY.md`
