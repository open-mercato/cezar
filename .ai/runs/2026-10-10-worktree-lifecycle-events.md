# Worktree lifecycle events execution plan

Source doc: .ai/specs/2026-10-10-worktree-lifecycle-events.md
Engine: om-auto-create-pr (steps: 14, --loop: no)

## Goal

Run local ordered setup and teardown scripts at every managed worktree boundary, with durable explicit recovery and current-configuration retries.

## Scope

Contract and configuration, shell-safe templates, durable lifecycle coordination and process supervision, all creation/removal paths, API/SSE, settings/recovery UI, acceptance tests and documentation.

## Non-goals

No general plugin/task event system, Docker orchestration, shared hook config, global inheritance, archive hooks, automatic rollback, mandatory configuration, or new environment flag.

## Risks

Arbitrary local commands require durable intent and bounded supervised execution. Config corruption must never authorize removal. Teardown cannot overlap agents; failures release resource slots. Preserve hook-free behavior and branch/record distinctions. Source spec and brief are copied unchanged so this run remains resumable.

## Implementation Plan


### Phase 1 — Contracts and core

1. **Define contract schemas and optional configuration/projections.** Add the new contract module and re-exports; raw-preserving config writes, stable entry IDs, bounded lists and revision conflicts. Pin missing/empty/corrupt distinction, no whole-config reset, and Node-free typechecks. Existing routes keep original response shape until opt-in fields are present.
2. **Build renderer/preview validation.** Use shared `shellQuote`; test both spacing forms, unknown/unclosed/literal braces, quoted/nested/heredoc rejection, static suffixes and malicious-looking path characters. Execute harmless argv-echo fixtures in tests to prove values round-trip literally and do not become extra commands. No production script is executed by validation/preview.
3. **Implement durable generation/operation store.** Atomic writes, validated containment, private modes, per-worktree cross-process locks, revision/CAS, current-list reconciliation, output/history bounds and ignore entries. Test corrupt records independently, persisted successes after reorder/edit/remove, state-write failure before spawn, request idempotency, and recreation after history expiry retaining the same worktree identity. No lifecycle hooks wired yet.
4. **Implement supervised executor.** Noninteractive Bash, bounded chunk-redacted output, wall-clock timeout, process identity/quiescence, stop/shutdown and dry-run. Use tiny local fixtures for success/nonzero/spawn failure/hang/child processes; no Docker dependency. Prove secret split across frames never reaches disk or live callbacks. Runtime missing preserves usable server/default path.

### Phase 2 — Complete integration

5. **Gate initial creation and rematerialization.** Add internal materialization outcome, generation checkpointing, seeding-before-setup, agent admission only after setup and persisted pending-launch intents. Cover initial/continuation/restart `ActiveRun` construction, reused worktrees, non-Git/opt-out, recreation failure and no duplicate agent launch.
6. **Route every removal intent through coordinator.** Manual task/worktree removal, retention/manual reclaim, variant losers and feature-managed orphan cleanup. Preserve branch/record differences and verify physical commit. Static call-site inventory plus behavioral tests must prove no eligible direct `removeWorktree` bypass remains. Test active variant cancellation waits for quiescence.
7. **Implement parking/recovery and resource accounting.** Restart lifecycle reconciliation before generic run recovery; uncertain children await user. Test `maxParallel=1` and two projects so failed/kept operations release slots, unrelated tasks progress, Retry reacquires admission and cleanup cannot race Continue. Test every allowed/forbidden state-action pair and final config-revision recheck.
8. **Expose chained operation/preview/read/action APIs and live invalidations.** Zod middleware for every input, exact schema/route parity, scoped aliases, paginated output, idempotency, stale-state 409, same-origin/remote safeguards. Test legacy no-hook responses and hook-enabled pre-mutation 409; verify no route can force an arbitrary path. CLI prints recoverable operation and exits 1 on attention; dry-run stays inert.

### Phase 3 — Cockpit flow

9. **Extend Worktrees configuration UI.** Ordered multi-line entries, explicit Save, stable IDs, validation, retained drafts, timeout disclosure, variable insertion and illustrative/real previews. Test editing a failed command then returning to Retry; no stale execution source. Existing retention fields remain functional.
10. **Add lifecycle progress and recovery views.** Task Session plus independent orphan detail; statuses, bounded output, allowed actions, current-list/edited-entry explanation and destructive confirmations. Test all setup/teardown choices and commit failures. Avoid manufacturing agent events or usage for shell work.
11. **Wire attention and demand-driven live updates.** Task lists/worktree table, suppressed-retention explanation, reconnect/focus reconciliation, unsubscribe on view exit. Verify remote mode uses existing HTTP/SSE only, orphan updates need no task record, and output does not leak into public/global discovery surfaces.

### Phase 4 — Acceptance and release readiness

12. **Run the end-to-end lifecycle matrix.** Use an isolated Git repo and fixture scripts: creation success; second-of-three failure; repair current config; retry with add/remove/reorder; changed successful entry; bypass; partial-setup cancel; manual deletion; task deletion; auto reclamation + recreation; orphan with missing context; legacy hook-free prune; variants; force preserving original intent; actual removal failure; interrupted command and stale double-click; invalid root/path; no-worktree/no-hooks/dry-run; hosted auth; script runtime unavailable. Assert directory existence and task/branch outcomes, not only UI labels.
13. **Verify UI and document contracts.** Browser-check desktop/narrow keyboard flows including the new variables/current-list behavior. Update user reference, compatibility inventory and `.ai/cezar/` ignore contract. No `.env.example` change is needed unless implementation introduces/changes a `CEZ_*` variable; if it does, update it and the reference table in the same commit. Document Bash requirements, finite timeout, unsafe downgrade, local privileges, skipped leftovers and no exactly-once guarantee.
14. **Run configured validation and architecture review.** `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`, plus focused lifecycle/UI tests above. For regressions in existing mechanisms, demonstrate a meaningful guard test fails without the corresponding fix using an isolated worktree or safe temporary source reversal; never stash someone else's edits. Review canonical mechanisms, two-way contract parity, all lifecycle construction/removal paths and zero-config behavior before enabling the UI.

## Progress

PR: #1358

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contracts and core

- [x] 1.1 Define contract schemas and optional configuration/projections. — b43c3d49
- [x] 1.2 Build renderer/preview validation. — b43c3d49
- [x] 1.3 Implement durable generation/operation store. — b43c3d49
- [x] 1.4 Implement supervised executor. — b43c3d49

### Phase 2: Complete integration

- [x] 2.1 Gate initial creation and rematerialization. — 97457e20
- [x] 2.2 Route every removal intent through coordinator. — 97457e20
- [x] 2.3 Implement parking/recovery and resource accounting. — 97457e20
- [x] 2.4 Expose chained operation/preview/read/action APIs and live invalidations. — 97457e20

### Phase 3: Cockpit flow

- [x] 3.1 Extend Worktrees configuration UI. — 9e8d034c
- [x] 3.2 Add lifecycle progress and recovery views. — 9e8d034c
- [x] 3.3 Wire attention and demand-driven live updates. — 9e8d034c

### Phase 4: Acceptance and release readiness

- [x] 4.1 Run the end-to-end lifecycle matrix. — 653514ca
- [x] 4.2 Verify UI and document contracts. — c2f5227d
- [x] 4.3 Run configured validation and architecture review. — c2f5227d

## Acceptance evidence

Real Git and harmless Bash fixtures cover setup/retry/current-list edits, removal intent and branch effects, recreation identity, variant cancellation, resource release, restart uncertainty, graceful process drain, and refusal of corrupt context. Backend launch alone is mocked. Regression reversals proved legacy deletion, variant cancellation/retention, continuation root fallback, disposed-agent ownership and history expiry fail without their fixes.

Initial configured gate: typecheck, node core tests (41 passed, 1 platform skip), build/tarball check, and package E2E (17 passed) passed. The complete Vitest run exposed host-profile output contamination, Node25/JSDOM storage shadowing and a missing native-select focus token. Their focused reruns passed after fixture isolation/style corrections. The authoritative review reruns the complete gate on the committed head before completion. Native Windows supervision is covered by fixtures but has not been executed on Windows. Browser QA remains pending separately.


## Final verification

All five configured commands passed on c2f5227df2e6e6724d6efb884888f608f345cfb7: typecheck; Vitest (9,302 passed, 5 skipped; 549 files passed, 1 skipped, using VITEST_MAX_WORKERS=4); node unit (41 passed, 1 platform skip); build and tarball check; packaged CLI E2E (17 passed). Review fixes proved red before restoration: live-coordinator ownership and lock-directory disappearance. Browser-discovered bypass status and stale terminal alerts also have red/green regression evidence.

Independent review: https://github.com/open-mercato/cezar/pull/1358#pullrequestreview-5480604401 — internal APPROVE, submitted as COMMENT because GitHub prohibits self-approval. Browser QA: https://github.com/open-mercato/cezar/pull/1358#issuecomment-6101571773 — 16 scoped scenarios passed, including both final fixes; 24 screenshots and reports preserved in the primary checkout at .ai/qa/artifacts_pr1358_worktree_lifecycle/. Browser recovery used the saved dry-run app; real Git/Bash fixtures separately prove execution and physical effects. Native Windows execution remains untested.

Canonical label/assignment writes were denied, and screenshot evidence-branch publication returned 404; local-artifact fallback is recorded on the PR. Hosted CI/CodeQL requires maintainer authorization for this fork; actual GitHub approval and configured QA approval remain maintainer gates. No merge is performed. Browser and saved test environment were stopped before worktree cleanup.
