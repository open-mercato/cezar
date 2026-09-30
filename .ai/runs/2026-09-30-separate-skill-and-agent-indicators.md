# Separate the skill indicator from the agent indicator

Engine: om-auto-create-pr (steps: 8, --loop: no)

## Goal

A skill invocation must never be reported as a running sub-agent: the cockpit marks **skills** and
**sub-agents** separately, so `Agents · N/M` counts only real fan-out.

## Background

The user ran `/om-auto-create-pr` on a task and the thread showed `Agents · 1/1 — starting…` above
the composer, although no sub-agent had been dispatched — only a skill had been invoked.

The cause is two correct-in-isolation decisions that collide:

1. **#529 / PR #532** mapped claude's `Skill` tool to `toolKind: 'task'` on purpose, so the row
   would get `BotIcon` instead of the generic wrench. That issue explicitly reasoned "`task` is
   already a member of the `ToolKind` enum, so this is not a protocol change."
2. **#474 / PR #550** then built the Agents dock, whose collector defines a sub-agent as *any
   parent-less `toolKind: 'task'` item* (`subagent-dock.ts:11`).

So every skill invocation is now counted as a sub-agent. Because a `Skill` call settles as soon as
the instructions are returned and never adopts children, the dock reads `1/1` with the activity
line `starting…` — an agent that is simultaneously finished and not started — and stays pinned
above the composer for the rest of the turn.

`packages/cezar/src/runs/event-history.ts:573` uses the same `toolKind === 'task'` test to decide
which "agent episode" to retain when progressively loading a long session, so the conflation
reaches the history-hydration path too.

## Scope

- Give skills their own `ToolKind` (`'skill'`) in the protocol and both `tool-display` mirrors.
- Skills consequently drop out of the Agents dock and out of the history root-episode retention —
  locked in with regression tests, not left implicit.
- Mark skills separately in the UI: their own icon and title split in the transcript, plus a slim
  Skills dock line naming the skill(s) governing the run. Not gated on the run being live — a
  finished run should still say which skill produced it, and unlike a fan-out there is nothing
  transient to go stale.

## Non-goals

- No change to sub-agent collection, nesting, the drill-down sheet, or the dock's visibility rules.
- No new lifecycle for skills. A `Skill` call settles immediately and has no observable "running"
  phase, so the Skills dock deliberately shows **no `N/M` odometer** — inventing one would be a
  fabricated progress signal. It names the skill, nothing more.
- No change to how runs are launched with a skill or workflow, and no change to the run-level
  lifecycle lines (`run started — workflow …`).
- Historical NDJSON recorded before this change still carries `toolKind: 'task'` for skills and is
  left as-is; it replays exactly as it did.

## Compatibility

Additive per BACKWARD_COMPATIBILITY.md's general rule: a new member of the `ToolKind` union. No
runtime validator rejects an unknown `toolKind` — the web's only exhaustive consumer is
`TOOL_ICONS`, which is already read through a `?? WrenchIcon` fallback — so an older cockpit
reading a newer run's events degrades to the generic wrench rather than breaking.

## Implementation Plan

### Phase 1: Give skills their own tool kind

- 1.1 Add `'skill'` to the `ToolKind` union in `packages/cezar/src/core/ui-events.ts` and its
  api-client mirror `packages/api-client/src/protocol/ui-events.ts`, documenting what separates it
  from `task`.
- 1.2 Map the `skill` tool case to `toolKind: 'skill'` in both `tool-display` mirrors, and update
  the three expectation tables that pin the old value (`core/tool-display.test.ts`,
  `api-client/protocol/tool-display.test.ts`, `server/tool-display-mirror.test.ts`).

### Phase 2: Stop counting skills as agents

- 2.1 Regression test in `subagent-dock.test.ts`: a parent-less `toolKind: 'skill'` item yields no
  dock row, and a mixed turn counts only the real agent.
- 2.2 Regression test for `deriveRunContextEvents`: a skill item is not retained as a root agent
  episode, while a sibling `task` item still is.

### Phase 3: Mark skills separately in the UI

- 3.1 Transcript: give `toolKind: 'skill'` its own icon in `TOOL_ICONS` and add `Skill:` to
  `splitToolTitle`'s verb list, so the card reads a bold **Skill** plus the skill name in mono —
  visually distinct from a bot-iconed Agent card.
- 3.2 Add `collectSkills` beside `collectSubagents`: the parent-less, non-failed `toolKind: 'skill'`
  items of a live run, newest last.
- 3.3 Add a slim `SkillsDock` component (name only, no odometer) and mount it in the dock region
  above the Agents dock.

### Phase 4: Validate

- 4.1 Run the full validation gate (`npm run typecheck`, `npm test`, `npm run test:unit`,
  `npm run build`, `npm run test:package`) with `TMPDIR`/`TMP`/`TEMP` and `CEZ_*` cleared.

## Risks

- **Low.** The behavioral core is a one-line kind change; everything downstream already keys off
  the kind, so the dock and history fixes fall out of it rather than being separately coded.
- The `tool-display` mirror parity test (`server/tool-display-mirror.test.ts`) runs both
  implementations over a shared table, so forgetting either mirror fails the gate rather than
  shipping a client/server disagreement.
- No browser is available on this machine (Chrome cannot launch), so the UI additions are verified
  by unit tests and code reading, not screenshots. Disclosed on the PR.
- **Known consequence, deliberately not fixed here.** `pruneSettledHistory` in
  `event-history.ts` only splices retained turn boundaries when the run has at least one root
  episode, so a run with no root keeps every boundary in its `/context` response. That is the
  pre-existing behavior of every run that dispatches no sub-agent; a skill-launched run used to
  escape it only by accident, because the skill itself counted as a root. Such runs now get the
  same treatment as the rest. The real defect is the retention walk's dependence on roots, which
  predates this change — fixing it means reworking the fan-out carry-over semantics and does not
  belong in this diff.

## Progress

PR: #1202

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Give skills their own tool kind

- [x] 1.1 Add `'skill'` to the `ToolKind` union in both mirrors — 06af9d00
- [x] 1.2 Map the `skill` tool to `toolKind: 'skill'` and update the expectation tables — 06af9d00, 88ee8ea6

### Phase 2: Stop counting skills as agents

- [x] 2.1 Agents-dock regression test: a skill yields no dock row — 06af9d00
- [x] 2.2 History regression test: a skill is not a retained root agent episode — 06af9d00

### Phase 3: Mark skills separately in the UI

- [x] 3.1 Distinct transcript icon and title split for a skill card — 06af9d00
- [x] 3.2 `collectSkills` collector for the live run's skills — 06af9d00
- [x] 3.3 Slim Skills dock mounted above the Agents dock — 06af9d00

### Phase 4: Validate

- [x] 4.1 Full validation gate green — 88ee8ea6
