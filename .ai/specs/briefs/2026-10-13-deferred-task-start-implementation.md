# Deferred task starts — local implementation and validation

Implements the design in [the specification](../2026-10-07-deferred-task-start.md), tracked by #1340. All changes, commits, test fixtures and evidence in this implementation session are local. No issue/PR was edited, no implementation PR was opened, and nothing was pushed.

## Related work checked before implementation

- #1260 is the open `once` prerequisite. Its two commits (`d7e6e6f1`, `7e21f950`) were brought into this task branch locally, including the reviewed retirement fixes. The branch also incorporates upstream main at `42568d82`.
- #771 is the broader composer scheduling request; #846 rejected a parallel scheduler. This implementation extends the existing automation store, workspace coordinator, poll lease and schedule runner.
- #1081 concerns Codex usage-limit error recovery; #1315 addresses the interrupted workflow continuation problem in #1300. They remain separate work. This feature does not claim to fix those recovery paths.
- The accepted #1340 clarification is in both local specification copies: no extra observation-age TTL for Claude, per-window expiry, visible age, fixed confirmed time, newer confirmed holds, and no model call to refresh metadata.

## Result

The composer offers Now, date/time in the server zone, and an observed usage reset. Preview and confirmation bind the workflow, effective models, accounts and profile locations. Codex additionally uses metadata-only identity checks. Pending starts live in the existing `once` infrastructure and appear under Scheduled in Tasks. They are hidden from the automation editor and remain regular tasks after launch.

No run, title request or worktree is created before eligibility or an explicit Run now. Prompts remain literal, including `{{...}}`; autonomy, review, inline approved plans and variant approach hints are preserved. The normal account holds and queue capacity still govern execution. Both streaming and non-streaming provider paths report normalized usage metadata under the actual step account.

Creation identity survives cancellation, successful launch, definition cleanup and receipt compaction. Launch intent is persisted before handing control to the run manager. A proven preflight failure is retryable; an ambiguous or partial launch cannot silently be retried or cancelled. Reconciliation uses the recorded run IDs and durable provenance. Updates and manual actions re-read revisions under the existing process lease.

A newer confirmed block can postpone execution without rewriting the confirmed time. An intentional multi-day hold is not mistaken for an offline missed start. Other starts more than 24 hours overdue require Run now or a time change. Changing a task's time clears the previous reset hold and keeps its account binding.

> Historical evidence paths below refer to the local validation archive. Raw logs and screenshots are intentionally excluded from the feature PR; the regression tests remain in the repository.

## Verification evidence

- Contract/server/client/web typechecks pass, including bidirectional route/response parity and typed request bodies.
- Focused tests cover cross-process tick/manual/cancel/reschedule races, durable idempotency, write failure, no early execution, literal prompts, missed starts, binding drift, safe retry versus ambiguous launch, newer holds and restart. The early-start and literal-prompt tests were also run with their guards temporarily removed: both failed, and both passed after restoring the source.
- Provider tests use protocol fixtures and bounded fake subprocesses. They cover callbacks, identity-only checks, cached/single-flight metadata reads, timeout/output/concurrency limits, partial windows, model applicability, the seven-day bound and atomic account-bound snapshots. No live model request was made during verification.
- The full Vitest suite, node:test suite, build/tarball check and installed-package smoke tests are recorded in the final progress entry below.
- Chromium against an isolated dry-run server: date preview, unavailable reset, Escape/focus, Schedule task, no run before due, task details, Change time, Run now and cleanup. A two-day-old cached Claude weekly reset remains available, with the observation age and selected window visible.
- Restart with no browser open: a due inline approved plan creates exactly two requested variants once; replaying its original creation request returns those runs. A start older than 24 hours becomes Missed. A changed binding becomes Couldn't start without creating a run. The UI can cancel that failure and manually run the missed task.
- Desktop and 390px mobile, dark and light themes: no horizontal overflow or browser exceptions. Evidence is local under `.ai/qa/deferred-task-start/` (screenshots and browser logs).

## Limits retained from the design

Attachments and linked todos can only start Now. Reset discovery is Claude/Codex only, requires usable observed windows for every effective model, and does not reserve tokens. Claude profile binding cannot detect a different login within the same profile. The server must be running to launch tasks. An older executable sharing this state can ignore composer semantics; finish/cancel pending starts before downgrading. Ambiguous launches require reconciliation rather than an automatic retry that could spend twice.

The prototype HTML remains design history; the screenshots above show the implemented cockpit. Package verification uses system npm 11: the globally installed npm 12 changes `npm pack --json` from the array expected by the repository's unchanged packaging check. Test temp directories are outside git but inside the home directory, and inherited cockpit dispatch variables are removed; repository tests explicitly rely on those conditions.

## Final verification — 2026-10-13

- `npm run typecheck`: passed for all four packages.
- `npm test -- --maxWorkers=4`: **9711 passed, 4 skipped**, 582 files passed and one skipped. The final run uses an isolated temporary Git identity at global-config precedence so fixture-local identities still override it. Log: `.ai/qa/deferred-task-start/full-tests.log`.
- `npm run test:unit`: **42 passed**.
- `npm run build`: passed, including `check:pack` (805 files, 105 cockpit assets).
- `npm run test:package`: **17 passed**, including tarball installation and the offline CLI workflow.
- Feature browser QA: all three scripted scenarios passed against Chromium and a dry-run fixture server; screenshots were visually inspected. This is feature-specific browser verification, not a claim that the repository's entire general e2e suite was executed.
- `git diff --check`: passed. Main spec and issue mirror are byte-identical.

Provider protocol tests used fixtures and fake subprocesses; production Claude/Codex accounts were not queried and no paid model call was made. The fixture server is stopped after verification.

## Independent review corrections — 2026-10-13

Four independent audits requested changes; their confirmed defects are corrected locally:

- Lease contention now uses the workspace scheduler's existing retry floor. A due task in
  another project progresses, and the contended task later retries without changing its time.
- Confirmed per-step runner/model selections are retained and displayed. Newer holds respect
  model applicability; an Opus-only window cannot postpone a Sonnet-only task.
- Ordinary Codex stream observations receive independently verified identity. Identityless
  metadata cannot erase an identified snapshot or its holds. Identity checks remain bounded,
  metadata-only and model-free; they add a subprocess check at step start and on observations.
- Typed failure categories separate changed binding from transient errors and ambiguous
  launches. Invalid binding shows replacement guidance, disables Retry/Change time, and
  exposes Copy prompt/Cancel. Inline skills are labelled as skills rather than approved plans.
- Refresh clears preview readiness; changing settings cannot resurrect an old preview.
  Submission (including keyboard shortcuts) stays disabled until a current preview succeeds,
  without disabling draft editing. Native radios share a unique accessible group and field
  errors are associated with inputs.
- A malformed creation-ledger entry cannot discard unrelated automation definitions. Damaged
  evidence survives ordinary writes and blocks its key; a malformed entire ledger blocks all
  deferred creation/cleanup instead of assuming requests never happened.

New regression tests fail against the original sources (scheduler: one failure; parent
reset/lifecycle/details: six failures; identity: five failures; picker: six failures; ledger:
seven failures) and pass with corrections. Parent reran post-merge targeted suites. Independent
reviewers approved all three child fixes and the parent lifecycle/details commit.

Persistence coverage now kills an actual RunManager process before durable write, after one
of two variant writes, and after both writes; reopening/reconciliation never relaunches.
The dead fixture's lock mtime is aged to exercise the normal stale-lock recovery without a
15-second wait. Provider validation is stubbed in this crash fixture; persistence is real.
API tests additionally exercise an attachment payload, both disabled POST routes and creation
replay through the default project alias. Chromium's deterministic `e2e` test checks native
ArrowDown radio navigation, failed-refresh submission gating, Escape focus, and draft retention.

Coverage clarification: approved inline steps are verified through API/launcher fixtures.
The current composer has no separate approve-and-execute-plan UI; this report does not claim
that browser flow is implemented or verified. The earlier prototype is design history.

The full-suite run exposed a recovery regression in the first identity correction: ordinary
Codex steps awaited optional identity metadata for up to five seconds. Discovery now runs
without blocking ordinary execution; observations still await verification, and bound scheduled
steps still await their launch check. The new pending-probe regression failed before this fix;
identity, binding, store and real recovery tests pass together (21 cases). An OpenCode transport
case also failed in that first parallel run and passed in its isolated rerun (17 cases).

### Final verification of review fixes

- Final full Vitest run: **9746 passed, 4 skipped**, 584 passing files and one skipped,
  316.12 seconds. This includes the corrected recovery path and OpenCode transport case;
  neither failed in this final run. Log: `.ai/qa/deferred-task-start/review-fixes-full-tests.log`.
- All four package typechecks passed; server rebuild and cockpit build passed. Tarball check:
  805 files including 105 cockpit assets. Installed-package tests: **17 passed** after the last
  runtime correction. Core node:test suite: **42 passed**.
- Native Chromium regression via `e2e`: **1 passed**, no model calls. Committed test:
  `tests/deferred-start.e2e.ts`; log: `.ai/qa/deferred-task-start/review-fixes-e2e.log`.
  The actual app ran in a disposable local repository/home; reset preview was synthetic.
- Final identity follow-up independently approved after 13 synthetic identity/binding/recovery
  checks. The preceding lifecycle, UI and ledger corrections also received independent approval.
- All changes and commits remain local. No push, implementation PR, issue update, production
  state change or real provider/model call was performed. Fixture servers are stopped.

## Second independent review round (2026-10-13)

Four reviews of 712a3f1e (UX, lifecycle, security, conventions/default path) returned `changes`; fixes:

- Composer: trailing whitespace no longer blocks scheduling; trigger shows the chosen start, a status line explains a disabled Schedule task, date/time auto-previews.
- Ambiguous launches have exits: Run now starts only missing recorded run ids (the tick never retries), DELETE dismisses; failures during that start stay ambiguous. A contended post-launch cleanup reports the launch.
- Default path: ordinary Codex steps spawn no app-server probe; binding gates the launch only; scheduled naming uses the namer model; hold notifications fire only on hold inputs; GET /automations is asked once per project per session.
- Codex identity: unanswered check is transient; API-key/dry-run bind by profile location; previews use the 15 s cache; due-time holds read Codex limits live.
- Reset copy in the server zone; expired unknown windows ignored; profile-missing reason named; cancel after launch answers 409; BC/spec/docs updated.

A follow-up review of the fixes found three further issues (stuck failed missing-run start, per-browser gate, preview probe per keystroke pause), fixed in f22e26d6.

Verification at f22e26d6: typecheck clean; `npm test` 9783 passed, 4 skipped, 4 failed only in `create-project.test.ts` under `TMPDIR=/tmp` (19/19 pass with the default tmp); core 42/42; build + check:pack ok; package 17/17. Environment notes: npm 12 on PATH breaks `check:pack` JSON parsing and `~/.npmrc` `allow-scripts` breaks `test:package`; both pass with `/usr/bin/npm` 11 and a neutral user config. Not addressed: commit `acfc4470` (unrelated specs and a stray `cezar` gitlink) must be left out of any PR.

## Final review corrections (2026-10-14)

The final independent review found five reproducible defects. All five are corrected locally
in a964b6c4, 3678eaa4 and b5201d8c, integrated at 70653077:

- Persisted Run now intent cannot authorize an automatic retry after an ambiguous launch.
  The caller must explicitly request retry; entering launching consumes the remembered intent.
- Variant reuse reads fresh durable records as well as local memory. A second cockpit leaves
  an existing foreign run untouched and launches only missing reserved ids.
- Lease contention retains an ordinary scheduled occurrence. The workspace retry floor applies
  to ordinary and composer schedules, preserving fairness without spinning or dropping work.
- Change time takes current values and a matching revision snapshot when opened. An external
  change during editing triggers the existing server conflict check rather than silently
  overwriting the newer schedule.
- Response schemas retain the full scheduled dispatch intent, including budget and child
  runner/model. Ordinary automation inputs and templates retain their original shape.

Regression tests were verified failing against old sources and passing with the fixes.
The independent Codex correction review (7c0c2bf3) approved all five after 108 targeted tests
and typechecks, with no blocking findings. Root verification includes 278 automation tests,
6 Scheduled UI tests, 11 API/contract tests, four-workspace typechecks, cockpit build and
tarball-content check. The original dispatch API reproduction now returns 200 after schema
parsing; crash replay starts zero runs; cross-cockpit replay starts only the missing variant.

The synthetic unknown-bucket finding remains a conservative metadata limitation: an omitted
bucket does not prove that its applicability or reset is known. This correction does not discard
unknown evidence merely to enable reset scheduling. Choosing an explicit date remains available.
No fresh browser or real-provider validation was performed in this correction round.

Final verification: the full Vitest invocation completed with **9784 passed, 4 skipped,
12 failed** (591 files). All 12 failures were in nine existing suites testing paths outside
Git repositories, while the inherited TMPDIR was inside the Cezar checkout. Re-running those
nine files with TMPDIR=/tmp passed **273/273** (48 + 225); no source changes were needed.
This is a full run plus successful environment-corrected reruns, not a single all-green run.
Commands used: env -u CEZ_API_URL -u CEZ_BIN ./node_modules/.bin/vitest run; then the same
with TMPDIR=/tmp for health-forge, git-changes, projects-api, git-worktree, repo-files-api,
e2e-setup-api, automations-api, attachments-api and server/git test files.
Logs: /tmp/cez-final-all.log, /tmp/cez-final-env-check.log, /tmp/cez-final-env-rest.log.
Typecheck, build:web and check:pack passed; the pack contains 805 files and 105 cockpit assets.
No publication or modifications to unrelated acfc4470 content.
