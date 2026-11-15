# Execution plan — in-band task-reference markers (CEZ:PR / CEZ:ISSUE / CEZ:TITLE)

Date: 2026-07-18 · Owner: pkarw · Branch: `feat/task-ref-markers`
Source doc: `.ai/specs/2026-07-18-task-ref-markers.md` (written in Phase 1)

## Goal

PR-number auto-discovery still mislabels tasks (e.g. a `#777` chip on a task about
issue #500): the fuzzy referenced-PR janitor adopts any PR URL the conversation
mentions, and the separate LLM namer costs tokens and still guesses. Owner
direction (2026-07-18): let the **main agent thread declare its own subject** via
an in-band marker protocol like `CEZ:DONE` — structured, zero extra LLM calls —
and make marker-declared values authoritative over every fuzzy layer.

## Scope

- New markers `CEZ:PR=<n>`, `CEZ:ISSUE=<n>`, `CEZ:TITLE=<phrase>` parsed from the
  agent's own turn text (never tool output), instructed via the handoff
  system-prompt fragment next to the existing `CEZ:DONE` contract.
- Marker values win over the transcript janitor's referenced-PR resolution and
  over the namer's cross-checked numbers; a marker title stops live namer
  refreshes for that run (the token optimization).
- Marker lines stripped from displayed transcript text (the `CEZ:DONE` precedent).
- Dry-run mock support + unit/integration tests + spec cross-references.

## Non-goals

- No change to the created-tier `pullRequestUrl` rule (`gh pr create` detection)
  — a reviewer still must not be mislabeled as author.
- No URL construction from a bare marker number (needs remote inference).
- No new env var / config knob — markers are always-on, zero-config.
- No backend/runner or UiEvent protocol changes; markers ride in plain text.

## Risks

- Instruction echo: the system prompt shows the marker syntax with a `<number>`
  placeholder — non-numeric, so a literal echo never parses. Line-anchored
  regexes keep prose mentions from matching.
- A lying/wrong agent declaration: bounded by the same sanity bound as
  `task-refs` (`MAX_REF`); a marker only affects display tiers, never action
  gates (Draft PR flows keep reading `pullRequestUrl`).
- v1 text chunks could split a marker line across events; stripping is
  best-effort per event, parsing happens on the accumulated turn text (whole).

## Implementation plan

### Phase 1: Spec

Write `.ai/specs/2026-07-18-task-ref-markers.md` (protocol, precedence, why the
2026-07-17 "Rejected: in-band title markers" decision is superseded by owner
direction), add pointer notes to the two affected older specs.

### Phase 2: Parsing core + record model

`src/runs/task-markers.ts` (pure parser), `RunRecord.markerRefs` +
`titleOrigin: 'marker'`, store-side marker-aware referenced-PR resolution.

### Phase 3: Engine wiring

Handoff instructions, `recordTurnEnd` marker apply, namer precedence + skip,
v1 marker-line strip, mock-claude `mock:refs` branch, integration tests.

### Phase 4: Web cockpit

Strip marker lines from v2 message display (`thread-state.ts`), mirror any api
type additions, unit tests.

### Phase 5: Gate + compatibility docs

Full validation gate; `BACKWARD_COMPATIBILITY.md` note that marker vocabulary is
additive-only.

## Progress

PR: #507

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Spec

- [x] 1.1 Write spec `.ai/specs/2026-07-18-task-ref-markers.md` — b912b05
- [x] 1.2 Cross-reference notes in `.ai/specs/implemented/2026-07-17-task-auto-naming.md` and `2026-07-16-pr-autodiscovery.md` — b912b05

### Phase 2: Parsing core + record model

- [x] 2.1 `src/runs/task-markers.ts` parser + unit tests — ee49008
- [x] 2.2 `RunRecord.markerRefs` + `titleOrigin: 'marker'` + store marker-aware referenced-PR resolution + tests — ee49008

### Phase 3: Engine wiring

- [x] 3.1 Handoff-instructions marker contract + system-prompt test — 680de9a
- [x] 3.2 `recordTurnEnd` marker apply + namer precedence/skip + v1 strip + tests — 680de9a
- [x] 3.3 `mock-claude.mjs` `mock:refs` branch + dry-run integration test — 680de9a

### Phase 4: Web cockpit

- [x] 4.1 v2 display strip in `thread-state.ts` + api-type mirror + tests — a4d519b

### Phase 5: Gate + compatibility docs

- [x] 5.1 `BACKWARD_COMPATIBILITY.md` additive-marker note — 2f5db47
- [x] 5.2 Full validation gate green (typecheck, vitest 2479, test:unit, build+check:pack, test:package) — verified 2026-07-18
