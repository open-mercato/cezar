# Remove vulnerable shared Zod resolution

Goal: remove every Zod version affected by Dependabot52 / GHSA-mrhx-c7xc-m3w5 while preserving validation and test-runner behavior.

Scope: root e2e parent dependency and Zod minimums in root/service/contract manifests, consistent npm lockfile, focused security regression and existing integration coverage. One coupled dependency group, one PR.

Non-goals: other alerts, repository settings/workflows, application defaults/API/state formats, unrelated lockfile upgrades, broad overrides, issues, merges, alert dismissal. Existing PR1253 retains vulnerable Zod and is not modified.

Implementation plan:
- Phase1: upgrade e2e0.19 to first stable patched-Zod parent0.22, raise Zod minimum4.6.7, add a collection-bound regression and prove red against original library.
- Phase2: run focused contract/server and e2e-tool compatibility checks, all five ordered configured commands, dependency-resolution/removal proof; independent review and PR finalization.

Risks: Zod early size rejection can change oversized-input error shape; e2e has a minor upgrade. Both old/new e2e require the same Node engine; no application engine/default change. Keep PR draft if verification incomplete. No configured dependency age delay was found. Rust fixes need absent Cargo toolchain and major parent review; deferred this occurrence.

Continuation decision: operator requested autonomous completion after initial blocked scan. Use the installed skill template atomic get/acquire/release operations verbatim as run-local helpers; no repository descriptor/settings/workflow edit. Root authorization permits normal claims, dependency installation, dedicated branch pushes and PR creation. Claim run fd755c76-4428-4d03-8427-e6199948cc48; exact lock/comment ids persisted in run artifacts.

Engine: om-auto-create-pr (steps: 3, --loop: no)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Dependency remediation

- [ ] 1.1 Upgrade the pinned parent and shared Zod with a security regression

### Phase 2: Verification and review

- [ ] 2.1 Prove patched resolution and run the ordered validation gate
- [ ] 2.2 Complete independent review and publish verified PR evidence
