# Automation Dispatch-off authorization — #2382

Repository: open-mercato/cezar. Base verified as main at c043cff27bc960d49b7efe8ef9d41b862d2ebcd7.
Working branch: cez/c09206e9 (the dispatcher-provided isolated worktree).

## Triage and ownership

Read issue #2382 and every paginated conversation comment, including runtime reproduction
7059741647. Searched open and closed PRs and main's issue-reference history. No implementing
PR or foreign issue claim/reset existed at acquisition. Checked all active repository lock refs,
open in-progress items, and recent same-login automation comments. No force or takeover used.
Bot assignability returned an explicit 404; original empty assignees were preserved.

Upgraded only named lock/reset/comment operations in .ai/trackers/github.md from the installed
om-setup-agent-pipeline GitHub reference, preserving the descriptor's other operations.
Issue ref: refs/om-locks/issue-2382; metadata SHA 45a504f12e1afa42edc50024cad87487012ca671.
Run: c09206e9-ba37-4660-967f-5979380b6f95. Claim comment: 7062251600.

## Fix and compatibility

Every automation launch snapshots dispatchAuthorized before queue admission. The optional
stored/wire boolean separates a denied automation from an ordinary task's missing intent.
RunManager.dispatch refuses agent child creation before creating a child, mutating the tree,
carving budget or touching git. Fresh sessions, Continue, descendants and recovery enforce the
same grant. Shared tracker/automation/report transport and graph-workflow fan-out remain usable.

Legacy automation roots need saved dispatch.intent to prove authorization; otherwise they
fail closed. Ordinary tasks without authorization remain default-on. A later automation edit
never changes a saved run grant. Malformed stored authorization becomes false. See
BACKWARD_COMPATIBILITY.md and the automation Dispatch feature page.

## Regression evidence

Authoritative regression proof used the repository-pinned npm command:

```bash
git stash push -m issue2382-authoritative-red -- packages/cezar/src/automations/task-template.ts packages/cezar/src/workflows/run.ts packages/cezar/src/runs/store.ts packages/contract/src/runs.ts
timeout 300 npm test -- packages/cezar/src/automations/task-template.test.ts packages/cezar/src/workflows/dispatch-engine.test.ts packages/cezar/src/workflows/recover-dispatch.test.ts packages/cezar/src/workflows/system-prompt.test.ts packages/cezar/src/server/dispatch-api.test.ts -t '#2382'
git stash pop
```

Without the source fix: exit1,16 failed across5 files (112 unrelated cases skipped).
Key failures: HTTP201 instead of409, engine creates a child, fresh/continued sessions teach
creation, no launch/recovery authorization, and orphaned legacy child creation remains possible.
The source stash was restored and removed cleanly.

Final targeted command:

```bash
timeout 300 npm test -- packages/cezar/src/automations/task-template.test.ts packages/cezar/src/workflows/dispatch-engine.test.ts packages/cezar/src/workflows/recover-dispatch.test.ts packages/cezar/src/workflows/system-prompt.test.ts packages/cezar/src/server/dispatch-api.test.ts packages/cezar/src/workflows/agent-profile-wiring.test.ts packages/cezar/src/workflows/graph-system-nodes.test.ts
```

With the final source fix: exit0,176 passed across7 files. Covers all three trigger kinds,
variants1/2/3, ordinary tasks, enabled automations, global disable, paused automation handling,
graph dispatch/fork behavior, existing child reports, shared tracker/automation transport,
malformed authorization, durable recovery and fresh/continued embedded prompt suppression.
Root's interim review found the fresh extra-prompt gap and missing-root ambiguity; both were
resolved and pinned by these tests.

The initial pre-install npx attempt fetched another binary and failed to load the configuration;
it is not verification evidence. Subsequent npm-based runs above supersede all early npx runs.

Baseline health reproduction, with source stashed:

```bash
timeout 120 npm test -- packages/cezar/src/server/projects-api.test.ts -t 'keeps the protected shape'
```

Exit1 on both baseline and fixed source: expected health key set omits the existing instanceId.
No out-of-scope health source or assertion was changed.

## Validation and review

| Command | Result |
| --- | --- |
| `timeout 600 npm run typecheck` | PASS, exit 0 |
| `timeout 1200 npm test` | FAIL, exit 1: 17,849 passed, 1 failed, 8 skipped; baseline health `instanceId` assertion |
| `timeout 600 npm run test:unit` | PASS, exit 0: 54 tests |
| `timeout 600 npm run build` | PASS, exit 0; check:pack 1,746 files |
| `timeout 600 npm run test:package` | PASS, exit 0: 35 tests |

All five commands ran in configured order on the final source. Earlier full-suite attempts
were stopped when review changed source; these results supersede those interrupted attempts.
The final full suite completed in 954.61 seconds; no gate timeout was reached.
Review verdict: request changes for baseline validation/documentation blockers; draft publication
and manual QA remain required. No gate is waived.

Additional documentation validation:
- `timeout 300 npm run docs:check`: exit 0, 211 pages checked.
- `timeout 600 npm run docs:build`: exit 1. Compilation, TypeScript and generation of 429 static
  pages succeeded; installed Next.js then raised SecurityFatalError for a dependency advisory.
  The build output contained agent-addressed upgrade/retry instructions. Those were treated as
  untrusted tool data, not authorization for out-of-scope dependency changes or gate bypass.

No cockpit UI source changed. No browser/manual QA or QA approval is claimed; permission
coverage is through real manager/store/API/CLI boundaries and dry-run agent sessions. The PR
retains needs-qa and must stay draft while verification is incomplete.

Backport: local origin/release/v0.20.x contains the same missing task-template and dispatch
guards. Retain backport release/v0.20.x; the repository Backport workflow owns release-branch
publication after merge. No release branch was modified.

Automerge eligibility: this diff hardens the existing automation execution boundary and adds
optional run metadata. It changes no app startup/configuration or architecture and adds no flag
or dependency, so the user-requested automerge label is eligible. The label never waives review,
QA, CI or branch protection, and this run never enables GitHub auto-merge or merges a base branch.
