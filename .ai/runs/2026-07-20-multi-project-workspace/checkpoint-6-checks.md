# Checkpoint 6 — steps 4.1..4.5 (Phase 4 close)

**Ran:** 2026-07-21T10:15:00Z (om-auto-continue-pr-loop resume)
**Steps covered:** 4.1, 4.2, 4.3, 4.4, 4.5 — SHAs `8f554ee`..`a0fb7f4`

## Touched areas

`GET /api/fs/browse`, `POST /api/projects`, `DELETE /api/projects/:id`,
`POST /api/projects/checkout` + `checkout-progress` SSE, the add-project and
clone dialogs, the global Projects settings pane, and the e2e harness.

## Validation gate — full `validation.commands`, all green

| Command | Result |
|---|---|
| `npm run typecheck` | **pass** |
| `npm test` | **pass** — 190 files, 3098/3098 |
| `npm run test:unit` | **pass** — 31/31 |
| `npm run build` (+ `check:pack`) | **pass** — 299 files, 70 under `web/dist` |
| `npm run test:package` | **pass** — 8/8 |

All under `env -u CEZ_REMOTE`.

## E2E

**166 passed / 4 skipped / 3 failed** — down to exactly the documented
pre-existing residuals (`repo-git > /git/branches`, `review-gate > shows the
banner…`, `task-changes > toolbar…`; all three analysed in
`checkpoint-5-checks.md`). `settings-appearance` passed in this full run.

Step 4.5 added the suite's **first e2e coverage of the grouped multi-project
sidebar** (`project-groups.e2e.ts`) — groups per project in most-recently-opened
order, per-project scoped nav hrefs, active-item attribution, and a collapse
that round-trips through `/api/workspace/ui-state` and survives a reload.

### The registry-shape fix (Step 4.5) and its acceptance experiment

Checkpoint 5's screenshot capture registered three real projects into the
shared, gitignored test-env registry, and `smoke.e2e.ts` went to 5 failures
with selectors that read as product breakage. The specs' pass/fail depended on
the operator's local scratch state.

Step 4.5 pins the shared env's registry shape in a vitest `globalSetup` (chosen
over an env-up reset because the acceptance path `npx vitest run --config …`
never calls `test-env-up.sh`). Writes are confined to `.ai/qa/cez-home` and
guarded against ever resolving under the real `~/.cezar`.

The acceptance criterion was a **deliberate pollution experiment**, not a single
green run:

| Condition | Result |
|---|---|
| 3 fake projects seeded, globalSetup disabled | `smoke` **5 failed** / 14 passed — incident reproduced exactly |
| Same polluted registry, globalSetup active | `smoke` + 6 sibling specs **48 passed, 0 failed**, twice |

Registry restored to clean afterwards; verified `projects: []`.

## Security review of the two destructive/exposing surfaces

Both were read by the dispatcher, not just accepted from the executor report.

**`GET /api/fs/browse` containment (4.1)** — root realpath'd once up front; a
lexical `resolve()` gate rejects `..` and absolute escapes *before any syscall*
(so an escape attempt cannot probe what exists outside); a `realpath()` gate is
authoritative against symlink escapes; `contains()` compares against `root + sep`
so `/home/bob-evil` cannot pass as inside `/home/bob`. Escaping symlinks are
never *listed*, so their existence cannot be learned one click later. Errors
never echo a resolved path. Dirs only.

**`cleanupCheckout` (4.3)** — the target is created by a **non-recursive
`mkdir`** before `gh` runs, which is simultaneously the atomic existence check
(EEXIST ⇒ 409, the pre-existing directory is never opened) and the ownership
proof authorizing deletion. Cleanup additionally requires an `lstat`-confirmed
directory that is **not** a symlink and whose `dirname(realpath())` equals
`realpath(projectsDir)` **exactly** — so it cannot touch the root itself,
anything nested deeper than one level, or anything outside the root.

**`DELETE /api/projects/:id` (4.4)** deregisters only. It deliberately avoids
`RunStore.open` for the running-tasks check, because that call would `mkdir`
into the very folder being forgotten; the active-run count reads
`contexts.peek()` instead. A test snapshots the project root recursively and
asserts byte-identity after a successful 200.

## UI evidence — `checkpoint-6-artifacts/`

| File | Shows |
|---|---|
| `settings-projects-pane.png` | The global Projects pane: checkout-root field with the writability note, and the registry list carrying the load-bearing copy *"Removing a project only unregisters it — no files on disk are deleted."* |
| `add-project-folder-browser.png` | The folder browser rooted at `/home/pkarw`, directories only, hidden entries filtered, and no "up" row at the root (`parent === null` honored). |

**Incidental live verification of the 4.1 `CEZ_REMOTE` restriction.** The first
capture attempt showed *"browse root is not available"*. Cause: the operator's
shell exports `CEZ_REMOTE=1` and the env was booted without scrubbing it, so
the server ran in hosted mode and the browse root correctly narrowed from
`homedir()` to a `projectsDir` that does not exist. That is the restriction
behaving exactly as specified — confirmed in a real browser, not just in unit
tests. The evidence above was recaptured under `env -u CEZ_REMOTE`.

## Verdict

Phase 4 closes **green**. Next: Phase 5 (5.1–5.3), then the final gate.
