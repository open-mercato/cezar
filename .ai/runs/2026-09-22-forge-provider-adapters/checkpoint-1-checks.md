# Checkpoint 1 — Steps 1.1..1.5

**When:** 2026-09-22T13:34:06Z
**Steps:** 1.1–1.5 (`5c03e161`..`a05ebeda`)
**Touched areas:** `server/forge/` (types, cli, index, github), `server/server.ts` (`/github`, `/github/search`, `/github/comments`), `packages/contract` (health, projects), `workspace/projects.ts`, `web/components/project-groups.tsx`

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | ✅ pass | contract, client, server, web |
| `npm test` | ✅ pass | 393 files, 7 324 tests (baseline on 4763447f: 7 285 + 1 known flake); the flaky `automations/store.test.ts` lease case passed this run |
| `npm run test:unit` | ✅ pass | 36 / 36 |
| `forge/github.test.ts` unchanged | ✅ | file not modified since base; green through the cli.ts re-home |
| UI verification | ⏭️ skipped | The only UI change (1.2, `project-groups.tsx`) affects a `gitlab` project only — no server emits `gitlab` yet — and is pinned by a unit test. Real-browser e2e deferred to checkpoint 2 (Phase 1 close). |

## Behaviour notes recorded at this checkpoint
- 1.3 fixed a latent bug: the merge path now actually evicts comment threads (old prefix `${root}:` never matched keys `${root}\0kind#n`). The merge path still never drops the detect cache (#508 anti-flicker).
- 1.4/1.5: a project whose remote is absent or not a forge now answers `{available:false, reason:'No supported forge remote detected'}` from the list/search/comments routes instead of whatever `gh`'s stderr said. Under `CEZ_DRY_RUN=1` without a GitHub remote the list no longer serves the mock catalog (the tab was already hidden there — health reports `forge: null`). A repo with a GitHub remote but no commits reads as no-forge, matching `/health`. GitHub-remote payloads are byte-identical (asserted in `github-list-api.test.ts`).
