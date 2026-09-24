# Execution plan — mobile task reading mode

**Branch:** `fix/mobile-task-reading-mode-contrib`
**Base:** `main`
**Skill:** `om-auto-create-pr`
**PR:** [#764](https://github.com/open-mercato/cezar/pull/764)

## Goal

Give the task history substantially more usable height on small phones. The global mobile bar,
run header, workflow rail, plan dock, and composer currently stack into persistent chrome that can
leave roughly half of a 320×568 viewport for the agent transcript.

## Scope

- `packages/web/src/components/app-shell.tsx` — reduce the mobile top bar to the 44px touch-target
  baseline.
- `packages/web/src/routes/task-thread/run-header.tsx` and `step-rail.tsx` — let run details scroll
  away on phones while retaining the sticky desktop header, and tighten mobile-only spacing.
- `packages/web/src/routes/task-thread/task-thread.tsx` and `plan-dock.tsx` — compact the persistent
  bottom dock without changing its behavior.
- `packages/web/src/components/composer/composer.tsx` — use a one-row, 44px minimum prompt input on
  phones while retaining the current desktop dimensions and iOS-safe 16px text.
- Focused component tests plus mobile browser verification at 320×568, 360×640, and 390×844.

## Non-goals

- Redesigning the task thread, changing its information architecture, or hiding run metadata.
- Changing desktop layout, run status behavior, workflow semantics, or composer actions.
- Adding new persistence, settings, API contracts, or responsive JavaScript state.

## Implementation plan

### Phase 1 — reclaim mobile viewport height

- **1.1** Reduce the global mobile bar from 52px to 44px without shrinking the menu touch target.
- **1.2** Make the run header sticky only from the desktop breakpoint and tighten phone spacing.
- **1.3** Compact the workflow summary, transcript padding, plan dock, and composer on phones.

### Phase 2 — regression coverage

- **2.1** Lock the responsive class contract and one-row composer behavior in focused unit tests.
- **2.2** Verify the task thread in a real browser at 320×568, 360×640, and 390×844.

### Phase 3 — validation and review

- **3.1** Run the full repository validation gate.
- **3.2** Attach mobile before/after evidence to the pull request.
- **3.3** Review the complete diff and resolve all blocking findings.

## Risks

- **Low.** The change is limited to responsive Tailwind classes and one textarea `rows` default.
- The main regression risk is accidentally changing desktop behavior. Every mobile override therefore
  carries an explicit `md:` restoration, covered by focused assertions and browser checks.
- A shorter composer must still grow for multi-line text and keep every 44px touch target; existing
  auto-grow logic and controls remain unchanged.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reclaim mobile viewport height

- [x] 1.1 Reduce the global mobile bar to 44px — 5877ba7c
- [x] 1.2 Make the run header sticky only on desktop and tighten phone spacing — 5877ba7c
- [x] 1.3 Compact workflow, transcript and bottom composer surfaces on phones — 5877ba7c

### Phase 2: Regression coverage

- [x] 2.1 Add focused responsive component tests — 5877ba7c
- [x] 2.2 Verify 320×568, 360×640, and 390×844 in a real browser — 2/2 changed scenarios passed

### Phase 3: Validation and review

- [x] 3.1 Full validation gate green — typecheck; Vitest 4969/4969; node:test 35 pass + 1 platform skip; build/pack; package 12/12
- [x] 3.2 Mobile before/after evidence attached to the PR — [evidence](https://github.com/open-mercato/cezar/pull/764#issuecomment-5150618643)
- [x] 3.3 Complete diff review clean — touch-target regression found and removed before the replacement PR
