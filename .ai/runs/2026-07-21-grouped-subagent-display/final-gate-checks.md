# Final gate — spec complete (all 7 Steps done)

**Recorded:** 2026-07-21T10:48:00Z
**Steps covered:** 1.1 … 3.1 (`bd205e4` … `06436c3`)
**Subsumes:** checkpoint 2 (Phase 2 + Phase 3 window)

## Full validation gate (`validation.commands`, in order)

| Command | Result | Notes |
|---|---|---|
| `npm run typecheck` | **pass** | server + web, clean |
| `npm test` | **pass** | 178 files, **2995 tests** (was 2975 on main → +20 new) |
| `npm run test:unit` | **pass** | 30 tests |
| `npm run build` | **pass** | `check:pack ok — 284 files, 73 under web/dist` |
| `npm run test:package` | **pass** | 8 tests — packs the tarball and exercises the built CLI |

All five were run with the cezar session's `CEZ_*` env scrubbed (`CEZ_REMOTE`,
`CEZ_HANDOFF_FILE`, `CEZ_TASK_ID`, `CEZ_TODOS_FILE`), because those leak into the spawned
servers and change behavior under test.

## Integration suite (`npm run test:e2e`, real Chrome via agent-browser)

**This branch:** `TEST_E2E_STATUS=failed` — 7 failed | 139 passed | 24 skipped (170 tests).
**Merge-base `origin/main` (e5ecfee):** `TEST_E2E_STATUS=failed` — 7 failed | 136 passed |
24 skipped (167 tests).

The failures are **pre-existing and unrelated** — proven, not assumed: a clean worktree was
created at `origin/main`, built, and the same suite run there. Evidence:

- The failed count is **identical (7)** on both sides.
- The failing specs are ones this branch does not touch: `task-thread` (tab list expects no
  Commits tab), `github` (issue detail), `settings-bookmarklets` (×2), `settings-skills`,
  `settings-appearance`, plus worktree-dependent specs failing at setup.
- The passed count differs by **exactly +3** — this branch's three new `agents-dock.e2e.ts`
  tests, all passing.

**New spec `web/app/e2e/agents-dock.e2e.ts`: 3/3 pass in ~5s.** It replays a real recorded
`mock:subagents` transcript through the store → SSE → reducer → dock → sheet pipe and asserts
the odometer, both rows (title, type badge, activity, tool count), the drill-down's per-agent
isolation, Esc-to-close, and the collapsed state.

Artifacts (`.ai/qa/artifacts_e2e/`): `agents-dock-expanded.png`, `agents-dock-sheet.png`,
`agents-dock-collapsed.png`.

## Design-system / style compliance

`web/app/src/design-guardian.test.ts` is this repo's style-compliance lint (raw hex, amber-as-
text, bg/text-white/black, native dialogs, `dark:` variants, `100vh`). It runs inside `npm test`
and is **green** — the new dock and sheet use semantic tokens only, the running glyph uses
`stroke-pending`/`fill-pending` rather than `text-pending`, and every pulse carries
`motion-reduce:animate-none`.

No auto-fixable violations were reported, so no `X.Y-ds-fix` Step was needed.

## Residual findings

None blocking. Two documented, spec-sanctioned limitations ship as-is:

1. **Post-reload activity lines.** `item.delta` frames are live-only and never persisted, so a
   reloaded run's activity line falls back to the last persisted child snapshot. Documented in
   the spec's Edge Cases and pinned by a test in `subagent-replay.test.tsx`.
2. **Codex shows an attribution-less row.** Codex carries no wire parent attribution, so a
   codex "Review" row shows 0 tool calls and the sheet's empty state. This is the honest
   cross-backend position from the spec; it upgrades entirely inside `codex-ui-mapper.ts` if
   codex ever grows parent attribution.

## Result

**Final gate passed.** All 7 Steps are `done`; the feature is complete against the spec.
