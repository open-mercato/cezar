# Final gate — CEZ_SINGLE_PROJECT mode

Base synchronized: merged `origin/main` at `41beeff` before the final browser reruns.

## Configured validation gate

- ✅ `env -u CEZ_REMOTE npm run typecheck`
- ✅ `env -u CEZ_REMOTE npm test` — 217 files, 3,884 tests passed.
- ✅ `env -u CEZ_REMOTE npm run test:unit` — 34 tests passed.
- ✅ `env -u CEZ_REMOTE npm run build` — TypeScript, Vite, and `check:pack` passed.
- ✅ `env -u CEZ_REMOTE npm run test:package` — 8 tests passed.

The first unsanitized unit run inherited `CEZ_REMOTE=1` from the executor environment and produced five hosted-mode status mismatches. Re-running the entire configured gate with that external variable removed passed; the failures were environment contamination, not product failures.

## Integration suite

- ✅ Default-mode feature scenario: `project-groups.e2e.ts` — 3 passed, 1 flag-only scenario skipped.
- ✅ `CEZ_SINGLE_PROJECT=1` feature scenario: `project-groups.e2e.ts` — constrained single-project scenario passed, 3 default-only scenarios skipped.
- ❌ Full `npm run test:e2e`: 172 passed, 5 skipped, 6 failed across unrelated existing scenarios.
- ❌ Focused rerun after latest-main sync: 37 passed, 5 failed across GitHub activity/detail, review-panel PR link, task toolbar PR detection, and Shiki token color.
- Baseline confirmation on untouched `origin/main` (`41beeff`): the same GitHub activity/detail, review-panel PR link, and task toolbar PR-detection failures reproduced (38 passed, 4 failed). The Shiki color failure did not reproduce there; it remains unrelated to the changed surfaces and passed on a subsequent baseline run.

### Failure analysis

| Failing test | Evidence used | Reasoning | Suggested owner | Next action |
|---|---|---|---|---|
| `github.e2e.ts` activity/detail | 25s missing `/github` nav + closed fetch socket; identical on `origin/main` | Baseline dry-run/browser fixture failure, outside this diff | Shared | Stabilize forge-nav fixture/server lifecycle separately |
| `review-gate.e2e.ts` PR link | Missing `[data-slot=pr-link]`; identical on `origin/main` | Baseline parked-run fixture no longer yields a PR link | Agent/QA | Update fixture or assertion in a follow-up |
| `task-changes.e2e.ts` toolbar policy | Actual actions include Create PR, omit View PR; identical on `origin/main` | Baseline dry-run fixture does not expose the expected PR URL | Agent/QA | Repair mock run PR-state setup |
| `task-thread.e2e.ts` Shiki color | One branch run observed white keyword; baseline rerun passed | Browser/lazy-highlighter flake, unrelated to changed components | Shared | Add an explicit highlighted-token readiness wait |

## Style and compatibility pass

- ✅ `git diff --check`
- ✅ UI changes reuse existing components, semantic controls, and capability plumbing; no new design-system primitive or raw color was added.
- ✅ `BACKWARD_COMPATIBILITY.md` reviewed: default route/payload behavior remains covered; the opt-in narrowing and non-destructive rollback are documented.
- ✅ No API fields were removed, no registry rows migrate or delete, and the request-origin/local-handoff protections remain unchanged.

## Evidence

- `final-gate-artifacts/screenshot-single-project-constrained.png`
