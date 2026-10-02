# Fix header Continue runner/model selection (#887)

## Goal

Make desktop and mobile Session-header Continue use the visible composer runner/model selection.

## Scope

`packages/web/src/routes/task-thread/task-thread.tsx`, `run-header.tsx`, `follow-up-engine.tsx`, and focused tests. No server/API changes; no changes to markdown or new-task routes.

## Implementation Plan

### Phase 1: Shared Session continuation

- [x] 1.1 Route both header Continue controls through the Session composer continuation action. — a40719ca
- [x] 1.2 Add regression coverage for desktop and mobile controls and preserve standalone behavior. — a40719ca

### Phase 2: Verification and handoff

- [x] 2.1 Run focused tests and the configured validation gate. — 176bf23c
- [x] 2.2 Create and review a separate issue PR. — PR #1173 independently reviewed; GitHub formal approval unavailable under shared author identity

## Risks

The local dependency tree currently resolves stale/incompatible workspace artifacts; validation may be blocked independently of this change.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — `<commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Shared Session continuation

- [x] 1.1 Route both header Continue controls through the Session composer continuation action. — a40719ca
- [x] 1.2 Add regression coverage for desktop and mobile controls and preserve standalone behavior. — a40719ca

### Phase 2: Verification and handoff

- [x] 2.1 Run focused tests and the configured validation gate. — 29abe6e3
- [x] 2.2 Create and review a separate issue PR. Independent review approved; formal GitHub approval unavailable under shared author identity.

### Verification record

- Focused Vitest: 3 files, 185 passed.
- `TMPDIR=/tmp/cezar-1173-... npm run typecheck`: passed.
- `TMPDIR=/tmp/cezar-1173-... npm test`: 8,408 passed, 2 baseline/environment failures in `src/workflows/agent-profile-wiring.test.ts` and `src/workflows/system-prompt.test.ts`; no changed-file failures. The latter also reports the generated temp project lacks `.ai/cezar/runs.json`.
- `npm run test:unit`: 36 passed; `npm run build`: passed (`check:pack` 687 files); `npm run test:package`: 17 passed.
- Browser QA and independent review remain before this PR can leave `in-progress`/draft.
