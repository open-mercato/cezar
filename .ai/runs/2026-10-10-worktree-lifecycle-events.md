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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contracts and core

- [ ] 1.1 Define contract schemas and optional configuration/projections.
- [ ] 1.2 Build renderer/preview validation.
- [ ] 1.3 Implement durable generation/operation store.
- [ ] 1.4 Implement supervised executor.

### Phase 2: Complete integration

- [ ] 2.1 Gate initial creation and rematerialization.
- [ ] 2.2 Route every removal intent through coordinator.
- [ ] 2.3 Implement parking/recovery and resource accounting.
- [ ] 2.4 Expose chained operation/preview/read/action APIs and live invalidations.

### Phase 3: Cockpit flow

- [ ] 3.1 Extend Worktrees configuration UI.
- [ ] 3.2 Add lifecycle progress and recovery views.
- [ ] 3.3 Wire attention and demand-driven live updates.

### Phase 4: Acceptance and release readiness

- [ ] 4.1 Run the end-to-end lifecycle matrix.
- [ ] 4.2 Verify UI and document contracts.
- [ ] 4.3 Run configured validation and architecture review.
