# Checkpoint 3 — Steps 2.1..2.4 (Phase 2 close)

**When:** 2026-09-22T14:33:29Z
**Steps:** 2.1–2.4 (`92d7c5c5`..`ec1ee5e8`)
**Touched areas:** `server/forge/` (new `discovery.ts`; `index.ts` host ladder, `ParsedRemote.path/origin`, `forgeWebRoot`; `github.ts` `viewUrl`), `server/server.ts` (boot + 10-min discovery warm-up), projects tests

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | ✅ pass | |
| `npm test` | ✅ pass | 394 files, 7 407 tests (no flake this run) |
| `npm run test:unit` | ✅ pass | 36 / 36 |
| UI verification | ⏭️ skipped | No Step in the window touched `packages/web`. |

## Behaviour notes
- Transitional (until Phase 3): a project whose remote is on `gitlab.com` (or a host `glab` is logged in to) now lists `forge: 'gitlab'` + `repoUrl` on `GET /api/v1/projects` and shows the forge nav item, while `resolveForge` still returns no driver, so its tab answers the in-payload unavailable reason. Health for such a boot repo stays `forge: null`.
- GitHub Enterprise hosts found through `gh auth status` now get the GitHub driver and enterprise web links.
- Vitest never reads or writes the real `~/.cache/cez` (`process.env.VITEST` seam, same approach as `open-in-terminal.ts`); no `CEZ_*` variable added.
- Review Major 2 (scheme/port) resolved in 2.3 per D3, with table tests over http/port/ssh/scp/non-root/credentialed remotes.
