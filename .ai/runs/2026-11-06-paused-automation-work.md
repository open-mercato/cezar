# Paused automations: stop agent dispatch, disclose and cancel pending work (#1980)

Source: https://github.com/open-mercato/cezar/issues/1980

## Goal

Pausing an automation must stop it from generating new autonomous work: its surviving execution
trees can no longer dispatch fresh children, and the user can see — and explicitly cancel — the
queued work it already created.

## Decision (autonomous run, most-reversible call)

The issue asks a maintainer to choose between (1) disclose + a separate action and (2) Pause holds
pending work by default. The triage comment recommends option 1; the reporter's Nov 6 clarification
requires that pausing stops descendant dispatch. This run does both, without changing what the
`pause` route itself does:

- **Pause keeps its contract** — `POST /automations/:id/pause` is unchanged. Already-queued tasks
  stay ordinary tasks (spec 2026-09-14 §queued work) unless the user cancels them.
- **New, additive:** `GET /automations/:id/work` lists the automation's pending work (queued,
  split into never-started vs queued continuation) and active work (running/waiting), across the
  whole dispatch tree. `POST /automations/:id/cancel-queued` cancels the queued ones; cancellation
  is the existing durable terminal state, so it survives restart recovery.
- **Behavior change (documented in BACKWARD_COMPATIBILITY.md):** `POST /runs/:id/dispatch`
  (agent `cez task create`) is refused with 409 while the run's tree root was launched by an
  automation that is now paused. A root the user launched by hand (`Run now`, trigger `manual`)
  is exempt. Re-enabling the automation lifts the refusal (checked live, so restart-safe).
  Workflow graph nodes (internal dispatch with a workflow) are not gated — they are the declared
  workflow, not agent replenishment, and refusing them mid-graph would break active work.
- **Cockpit:** pausing an automation with pending/active work opens a disclosure dialog that says
  what will still run and offers "Pause" or "Pause and cancel N queued".

## Scope

- `packages/cezar/src/automations/paused-work.ts` (new pure helpers) + tests
- `packages/cezar/src/workflows/run.ts` (`dispatch` gate option) + test
- `packages/cezar/src/server/server.ts` (dispatch route wiring, two new automation routes)
- `packages/contract/src/automations.ts` (work + cancel schemas)
- `packages/web` automations toggle: client fns, disclosure dialog, tests
- `BACKWARD_COMPATIBILITY.md`, spec 2026-09-14 note, docs site automations page

## Non-goals

- Changing worker limits, silently cancelling running work, changing `pause`'s own response.
- A new "held" run status (cancel is the durable, existing control).
- Gating deleted automations' trees (no definition left to consult).

## Risks

- Dispatch refusal changes what an agent under a paused automation sees; the refusal text tells
  it to finish with what exists and report, never to substitute sub-agents.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Core

- [ ] 1.1 Pure helpers: automation provenance of a run, tree work classification, paused-hold reason
- [ ] 1.2 Gate agent dispatch under a paused automation's tree

### Phase 2: API

- [ ] 2.1 Contract schemas and the work / cancel-queued routes
- [ ] 2.2 Route tests and BC inventory

### Phase 3: Cockpit

- [ ] 3.1 Pause disclosure dialog with cancel-queued action
- [ ] 3.2 Cockpit tests

### Phase 4: Docs

- [ ] 4.1 BACKWARD_COMPATIBILITY.md entry, spec and docs-site updates
