# Fix: Skills → Refresh undone by a stale skillsReady snapshot (#1904)

## Goal

After Skills → Refresh, every `useSkills` consumer mounted later (`/` autocomplete, New task picker, the Skills tab itself) shows the refreshed catalog without a reload.

## Scope

- `packages/web/src/api/queries.ts` — `useSkills` copies `skillsReady` over the catalog only when that snapshot is not older than the catalog (issue option 2).
- `packages/web/src/routes/skills.tsx` — Refresh seeds `skillsReady` alongside `skills` (issue option 1).
- Regression tests in `packages/web/src/api/queries.test.tsx` and `packages/web/src/routes/skills.test.tsx`.

Non-goals: the `wait=1` cold-clone wait, catalog ordering, auto-refresh on `orgSkillsRepos` change, `useImportableSkills` (no exact-key writer exists).

## Risks

- A snapshot fetched in the same millisecond as a later exact-key write could still win; the Refresh seed of `skillsReady` covers that caller.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix and regression tests

- [ ] 1.1 Guard the ready-snapshot copy and seed skillsReady on Refresh, with regression tests
- [ ] 1.2 Full validation gate
