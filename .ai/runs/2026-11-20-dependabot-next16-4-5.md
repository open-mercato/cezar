# Patch the docs site's Next.js dependency

## Goal
Remove the vulnerable Next.js resolution for Dependabot87/89/91–95 with a compatible16.4.5 patch, preserving the static documentation export and normal preview behavior.

## Scope
One coupled remediation group: docs/site/package.json and its independent package-lock.json, focused upstream security regression and docs runtime/build compatibility checks. The docs site is deliberately outside the root npm workspaces. Root manifests/lock must remain unchanged. Existing proposals do not cover these sources; no active worker currently claims this group. No exploitability of cezar's static production export is asserted.

Non-goals: other dependency/Cargo/mobile groups, application/UI changes, issues, settings/workflow/descriptor/env changes, merges, auto-merge, releases, advisory publication or alert dismissal.

Security-Source: open-mercato/cezar:dependabot:87
Security-Source: open-mercato/cezar:dependabot:89
Security-Source: open-mercato/cezar:dependabot:91
Security-Source: open-mercato/cezar:dependabot:92
Security-Source: open-mercato/cezar:dependabot:93
Security-Source: open-mercato/cezar:dependabot:94
Security-Source: open-mercato/cezar:dependabot:95
Security-Fingerprint: next:docs/site/package-lock.json:GHSA-mfr8-8qww-v76h,GHSA-vc7v-qv4w-wrv8,GHSA-vvgp-ww4w-46vf,GHSA-rhh4-g77r-r9qj,GHSA-pc58-hwjq-p385,GHSA-f3mh-rxg3-f5g2,GHSA-7qx7-33qx-rqx2

## Implementation Plan
### Phase1: Minimal patch and security proof
1.1 PinNext16.4.5 consistently, restrict lock changes to required patch nodes, and add a meaningful security regression/integration test with old-version red and patched green evidence.
### Phase2: Validation
2.1 Run all five ordered configured npm gates, docs check/typecheck/build/security/runtime coverage and dependency resolution/target-interval verification.
### Phase3: Review and publication
3.1 Resume the existing independent final-review task for authoritative om-auto-review-pr/om-code-review review and any fix/retest loop.
3.2 Refresh deduplication and claims, record exact evidence/labels/backport decision, release the exact owned atomic lock and promote only after complete validation and independent approval.

## Risks and decisions
Next.js is a compatible patch. The production docs output is static and images are unoptimized; several affected runtime features are unused, but removing the vulnerable dependency resolution still protects supported build/dev paths. Do not claim seven independent exploit reproductions from one regression. No age policy was detected; no npm settings change is needed.

After receiving the specific unsupported-ownership blocker, the operator explicitly instructed autonomous continuation without confirmation. Apply the exact already-installed canonical GitHub atomic helpers from om-setup-agent-pipeline/references/trackers/github.md as run-local tooling, retaining create-only ownership and expected-SHA-lease release. This resolves the missing implementation without changing repository descriptors/settings/workflows or falling back to comment-only claims. Independent review must assess this interpretation. Preserve run42bef4e9 identity through the chain. Reuse this linked worktree, never remove the cockpit-owned directory. Two subtasks already exist; resume final reviewer1e261b2b instead of creating a third.

## Progress

PR: #2364

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Minimal patch and security proof

- [x] 1.1 PinNext16.4.5 consistently and prove security regression red/green — 635d186df

### Phase 2: Validation

- [ ] 2.1 Complete ordered root gate and docs/resolution/security/runtime validation

### Phase 3: Review and publication

- [ ] 3.1 Complete authoritative independent review and any fixes
- [ ] 3.2 Finalize evidence, labels, deduplication and exact owned lock release

## Verification so far
BaselineNext16.4.2: new regression suite fails5/10 with5controls passing. Patched16.4.5:10/10 new cases and7/7 existing compression cases pass. Reproduces SVG/ftyp bypass, Edge cookie-header disclosure and gzip response-framing flaws; no claim of independently reproducing the other four cache findings. Docs check/typecheck/build,17security cases,3preview pages+3script assets, npm ls and audit(0vulnerabilities) pass. Installed and all locked Next copies16.4.5 are outside all7source intervals. Only Next/env/SWC patch entries change; root lock unchanged. Node24/Linux; no separateNode20/Windows/macOS/browser QA claim.

Initial configured root gate attempted in order: typecheckPASS; npmtest hit900s timeout after an unrelated existing automation lock-reclaim assertion failure; coreunit54PASS; build/checkpackPASS; packagePASS. Source is unchanged at the failure and existingPR2193 describes the same race. No gate pass is claimed yet; Phase2 stays unchecked until bounded full revalidation. No audit exception or gate bypass. Independent review must complete validation before readiness; retain draft otherwise. All underlying evidence is preserved in task Assets/resumed, with exact commands/results summarized on the PR.
