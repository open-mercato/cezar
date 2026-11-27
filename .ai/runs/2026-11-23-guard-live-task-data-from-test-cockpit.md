# Execution plan — keep a test cockpit off a live project's task data

## Goal

A dry-run (or any second) cezar server must never adopt, resume or rewrite the tasks of a project
another live cezar is already serving.

## Why (proven root cause)

`.ai/scripts/test-env-up.sh` boots `node packages/cezar/dist/index.js --repo $REPO_ROOT` with
`CEZ_DRY_RUN=1` and its own `CEZ_HOME` (`.ai/qa/cez-home`). Run from the main checkout,
`$REPO_ROOT/.ai/cezar` is the live cockpit's real data directory. The single-cockpit slot lives in
`CEZ_HOME`, so the test cockpit cannot see the live one and boots as a second owner:
`manager.recover()` resumes live tasks on the mock, automations fire as mocks, retention reclaims
live worktrees. Evidence: 17 real handoff files carry the mock's "mock: implemented the change (dry
run)" line, three live runs resumed in one millisecond right after an agent ran the script from the
main checkout, and the main checkout's `.ai/qa/test-env-app.log` shows "recovered 1 run(s)" and
"reclaimed 1 old worktree(s)". Reproduced in a `/tmp` sandbox: two dry cockpits with different
`CEZ_HOME` on one repo ended with one reporting a task `waiting` and the other `done`.

## Scope

1. **Stopgap — `test-env-up.sh`.** Refuse to start when `$REPO_ROOT` is a main checkout (`.git` is a
   directory, not a linked worktree's `.git` file) AND `$REPO_ROOT/.ai/cezar/runs.json` exists, unless
   `CI` is `true`/`1`. Task worktrees always run. No override variable (user decision). The refusal
   exits non-zero before building or booting, so `e2e.sh` reports `TEST_E2E_STATUS=failed`.
2. **Real guard — a per-data-dir server lock.** `serve` takes an exclusive lock on
   `<repo>/.ai/cezar/server-lock/` for the boot project and for every lazily built project context,
   reusing the single-cockpit primitive (`acquireOwnership`, process identity, dead-owner reclaim,
   `copiedRoot` so a copied repo is not fenced by its original).
   - Boot project held by another live cezar → refuse to start, naming its pid (singleton precedent:
     "cezar will not launch a duplicate").
   - Lazily opened project held → that project answers 409 "in use by another cezar (pid N)".
   - Lock cannot be taken (read-only dir, symlinked path, unsupported platform) → one warning, boot
     continues as today.
   - Released on shutdown and on context disposal; a crashed owner is reclaimed by liveness.

## Non-goals

- Browser tabs, phones, other devices: unaffected (clients of one server).
- A repeated `npx cezar`: unchanged, still hands off through the existing single-cockpit slot.
- Headless `cezar run`: takes no lock (user decision).
- Multi-backend/multiplayer coordination (PR #1587 territory): out of scope.
- The leaked `CEZ_*` env theory: disproved for default paths; not changed here.

## Implementation Plan

### Phase 1: Stopgap in test-env-up.sh

- 1.1 Refuse in a used main checkout outside CI, with a message pointing at a task worktree.
- 1.2 Launcher tests: main checkout + runs.json refused; linked worktree and CI allowed.

### Phase 2: Per-data-dir server lock

- 2.1 `runtime/data-dir-lock.ts`: claim → owned | held(pid) | degraded, plus release.
- 2.2 Unit tests: second claim held, release frees, dead owner reclaimed, degraded path.
- 2.3 Wire into `serveCommand` for the boot project (refuse when held; release on exit).
- 2.4 Wire into `ProjectContexts.build` (new `in-use` failure, released on dispose/failed build) and
  map it to 409 in the project-scope resolver and `questions.ts`.
- 2.5 `server-lock/` in `DATA_GITIGNORE_ENTRIES` and BACKWARD_COMPATIBILITY.md §3.

### Phase 3: Docs

- 3.1 AGENTS.md validation note: run `test:e2e` from a task worktree; one-line mention of the lock.
- 3.2 Spec note recording the decision (multiplayer stays one-server-many-clients).

## Risks

- The lock primitive throws on any symlink in the path (`assertNoSymlink`); such repos degrade to
  today's behavior with a warning instead of being protected.
- An already-released cockpit (0.20.0) holds no lock, so until users upgrade only the stopgap
  protects the main checkout.
- A shared data dir on a network filesystem seen from two hosts reads as a foreign owner and is
  refused (fail closed), the same as the single-cockpit slot.

## Progress

PR: #2430

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Stopgap in test-env-up.sh

- [x] 1.1 Refuse in a used main checkout outside CI — 622a327b1
- [x] 1.2 Launcher tests for refused and allowed cases — 622a327b1

### Phase 2: Per-data-dir server lock

- [x] 2.1 Data-dir lock module — 1b41de49d
- [x] 2.2 Data-dir lock unit tests — 1b41de49d
- [x] 2.3 Boot project takes the lock — 1b41de49d
- [x] 2.4 Lazy project contexts take the lock, 409 when held — 286960d41
- [x] 2.5 Gitignore entry and compatibility note — 0fd4c692d

### Phase 3: Docs

- [x] 3.1 AGENTS.md validation note — ae77b2904
- [x] 3.2 Spec note recording the decision — ae77b2904
