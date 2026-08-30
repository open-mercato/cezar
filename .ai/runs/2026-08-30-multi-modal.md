# Execution plan — finish the stage-only multi-model harness for review (adopted from PR #925)

**Origin:** adopted — reconstructed by `om-auto-continue-pr` on 2026-08-30 because PR #925 carried no execution plan.
**PR:** #925 · **Branch:** `feat/multi-modal` · **Base:** `main`
**Author:** @haxiorz — this plan interprets their intent; correct it by editing this file or commenting on the PR.

## 🎯 Goal

Land the opt-in, stage-only multi-model orchestration feature described by PR #925 while resolving every actionable review finding, preserving the existing zero-config path, and returning the branch to a green review gate.

## Scope

- The already-landed multi-model harness, its typed API and cockpit surfaces, vendored runtime, safety boundaries, tests, specifications, and user documentation.
- The merge from the current `origin/main`, including the single reported `CHANGELOG.md` conflict.
- The requested corrections in worktree diff reads, the Claude write guard, runtime sealing, exact staging path parsing, compatibility documentation, package metadata, and branch-only artifacts.
- Focused regression tests for each behavioral correction, followed by the repository's full configured validation gate and an authoritative autofix review pass.

## Non-goals

- Expanding the harness beyond the feature, safety model, and UX already described by this PR and its committed specifications.
- Enabling `multiModel` by default, changing the zero-config behavior, or weakening any stage-only, quorum, validation, publishing, compatibility, or security gate.
- Rewriting existing branch history, force-pushing, merging the PR, or granting QA approval.
- Refactoring unrelated baseline browser-test failures or dependency-audit findings that are not caused by this PR.

## Evidence

| Conclusion | Drawn from | Confidence |
|---|---|---|
| The intended deliverable is an opt-in, stage-only multi-model harness with durable orchestration and cockpit visibility. | PR title/body; `.ai/specs/2026-07-23-harness-orchestration.md`; `.ai/specs/2026-07-26-harness-production-stabilization.md`; `docs/multi-model-harness.md`; the 219-file branch diff. | high |
| The branch's existing implementation and evidence are already landed and should not be redesigned during this resume. | Forty-nine commits through `f3b78f31`; the PR validation and live-evaluation sections; the previous review's positive safety and coverage assessment. | high |
| The merge conflict, two worktree-index defects, four minors, two nits, and the compatibility-note gap are the remaining actionable review scope. | @pat-lewczuk's `CHANGES_REQUESTED` review and hand-back comment on 2026-08-28. | high |
| Each behavioral correction requires a regression test that would fail without the fix. | Review's test-gap list and repository `AGENTS.md` rules. | high |
| CI does not currently add repair work. | `license/cla` is `SUCCESS`; no other PR check is reported. | high |
| No linked issue, PR task-list item, or inline review thread adds separate scope. | PR body/conversation scan and an empty GitHub inline-review-comment result. | high |

## Assumptions

- Both feature bullets will be retained under one `CHANGELOG.md` feature heading when `origin/main` is merged, because that is the narrow mechanical resolution requested by the reviewer.
- The four review minors are accepted as required hardening work even though they did not independently gate the verdict, because the reviewer explicitly asked that they be picked up in the same pass.
- The two review nits will be resolved conservatively: remove the unrelated editor launch file, and move the macOS-only sandbox runtime to optional package metadata only if installed-package behavior and tests remain correct.
- The existing `needs-qa`, `feature`, `priority-medium`, and `risk-high` labels remain appropriate; this resume does not award `qa-approved`.
- The prior reviewer reported baseline browser failures unrelated to this branch. This run will not weaken browser assertions; any full-suite failure will be reproduced and attributed before being treated as a branch regression.

## Risks

- Worktree diff helpers run on hot read paths, so incomplete scratch-index cleanup could leak disk or memory and an unisolated git invocation could still mutate a live task index.
- The Claude guard, sealed runtime, and staging allowlist are defence-in-depth safety boundaries; regressions must fail closed and receive adversarial tests.
- This is a broad, high-risk feature branch. Even local review fixes require the complete configured validation gate and a fresh automated review before hand-back.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Already landed on this PR (reconstructed)

- [x] 1.1 Implement and validate the opt-in stage-only multi-model harness, typed API, cockpit UX, safety model, specifications, and matched evaluation — f3b78f31

### Phase 2: Synchronize the reviewed branch

- [ ] 2.1 Merge the current `origin/main` and resolve `CHANGELOG.md` by retaining both feature entries under one heading

### Phase 3: Correct scratch-index isolation

- [ ] 3.1 Make every worktree diff helper dispose its scratch index in `finally` and add leak regression coverage
- [ ] 3.2 Pass the scratch environment through diff-base resolution and prove repointed-worktree reads leave the real index unchanged

### Phase 4: Harden harness safety boundaries

- [ ] 4.1 Make the Claude stage-only guard fail closed on missing or invalid environment paths and add the exit-code regression test
- [ ] 4.2 Parse staged paths as NUL-delimited data and add quoted and non-ASCII filename coverage
- [ ] 4.3 Refuse symlink cycles while sealing the model-writable runtime and add adversarial cycle coverage

### Phase 5: Resolve review cleanup and compatibility notes

- [ ] 5.1 Remove the stale branch handoff and unrelated editor launch artifact
- [ ] 5.2 Resolve the macOS-only sandbox runtime packaging nit without weakening supported-platform behavior
- [ ] 5.3 Document harness message-queue behavior on the existing route in `BACKWARD_COMPATIBILITY.md`

### Phase 6: Validate and return to review

- [ ] 6.1 Run targeted regression tests and the full configured validation gate, fixing branch-attributable failures
- [ ] 6.2 Run `om-auto-review-pr 925 --autofix`, apply any actionable findings, and leave the PR ready for human review and QA
