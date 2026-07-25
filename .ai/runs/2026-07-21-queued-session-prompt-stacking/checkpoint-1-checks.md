# Checkpoint 1 — after Step 1.5 (Phase 1 engine + API, minus the client mirror)

**When:** 2026-07-21T11:40:00Z
**Steps covered:** 1.1 – 1.5 (`163e6ff` … `b7d8b55`)

## Targeted validation

| Check | Result |
|---|---|
| `npm run typecheck` (server + web projects) | ✅ pass |
| `npm test` (full vitest suite) | ✅ **175 files / 3010 tests passed**, 0 failed |

Ran the full suite rather than a subset: Step 1.4 changed `pump()` and
`recover()`, which nearly every engine test transits, so a targeted subset would
not have been evidence of anything.

`CEZ_*` env vars were scrubbed before the gate — a cezar-launched shell exports
`CEZ_REMOTE` / `CEZ_DRY_RUN` into the test environment and they leak into the
runner's own fixtures.

## New tests added in this phase

| Suite | Count | What it pins |
|---|---|---|
| `src/runs/store.test.ts` → `queuedMessages (#472)` | 3 | old `runs.json` parses; the field round-trips; a secret in `text` survives verbatim (the `task` rule extended) |
| `src/workflows/run.test.ts` → `persistImage without a session` | 4 | two persists with no `ActiveRun`; **seeds from the highest suffix, not the file count**; one numbering space across `screenshot-`/`pasted-`; retry never overwrites |
| `src/workflows/run.test.ts` → `queued-stack mutators` | 12 | append order; image persistence; every mutator refuses after dequeue; edit keeps id+createdAt; orphan images unlinked but shared/`taskImages` ones kept; `editTask` re-derives title+refs; user-owned title wins; the defer window incl. the post-`starting` sub-window |
| `src/workflows/run.test.ts` → `hydrateQueuedInput` | 5 | fold order and blank-line join; **read-only + idempotent (the compounding guard)**; attachments re-encoded; unreadable file skipped with a `note` |
| `src/workflows/run.test.ts` → end-to-end + `recover()` | 2 | a real queued run's delivered `{{task}}` carries both stacked messages in order with an edit applied and the pre-edit text absent; two successive recoveries fold exactly once |
| `src/server/queued-messages.test.ts` (new) | 21 | all three ladder rungs + the unchanged 409; every bound named; PATCH/DELETE 200/404/409; `task` edit 409 after start; **no regression to #389**; a rejected task edit does not half-apply a title |

## UI / browser checks

**Skipped — nothing user-facing has landed yet.** Phase 1 is engine + API only;
the cockpit is untouched until Step 2.1. Screenshots will be captured at the
Phase 2 checkpoint.

## Deviations from the spec, and why

1. **`stackedImages` is a separate `StartRunInput` field**, not folded into
   `input.images` as the spec's Step 4 wording implies. `execute()` persists
   `input.images` into `taskImages` on the way through — folding the stack's
   (already-persisted) files in there would have written duplicate files on disk
   and made the thread's *task* bubble render the stack's images as its own,
   which also breaks the `dropOrphanImages` "still referenced by `taskImages`"
   guard. Same delivery to the backend, no side effects.

2. **`deferMessage` does not gate on `starting` alone.** `execute()` removes the
   run from `starting` as soon as it builds the `ActiveRun` — seconds *before*
   the backend is spawned. Gating on `starting` alone would have reopened exactly
   the dropped-message window rung 3 exists to close. A `sessionEverOpened` flag
   on `ActiveRun` distinguishes "still starting up" from "closed", which
   `state.session` cannot: teardown resets it to `undefined`, so a closed session
   and one that never opened look identical.

Both are recorded in `NOTIFY.md` and carried into the PR summary.

## Open risks going into Phase 2

- None blocking. The Phase 2 rollback constraint (never ship or revert the
  cockpit alone against a live Phase 1) is noted in `PLAN.md` Risks and will be
  restated in the PR body.
