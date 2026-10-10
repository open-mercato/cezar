# Make agent identity reasons provider-specific

## Goal

Ensure every unsupported agent provider gets an accurate identity explanation instead of inheriting
OpenCode's wording.

## Scope

- `packages/cezar/src/agent-config/account-identity.ts`
- `packages/cezar/src/agent-config/account-identity.test.ts`
- Regression evidence for #1233 (follow-up from #1113)

## Implementation Plan

### Phase 1: Make unsupported-provider reasons exhaustive

- [x] 1.1 Confirm the provider fallthrough and current issue reproduction.
- [x] 1.2 Add exhaustive provider-specific reasons and regression tests.
- [x] 1.3 Run targeted and configured validation, review the PR, and report evidence.

## Risks

Unsupported providers must not read credentials or invoke CLIs; the change is copy and dispatch
logic only. Adding a provider must require an explicit reason or reader at compile time.

## Progress
PR: #1258


> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

### Phase 1: Make unsupported-provider reasons exhaustive

- [x] 1.1 Confirm the provider fallthrough and current issue reproduction. — e6644323
- [x] 1.2 Add exhaustive provider-specific reasons and regression tests. — eafe1799 / 12144bfe
- [x] 1.3 Run targeted and configured validation, review the PR, and report evidence. — ed6f7522

## Final verification

Implementation source at `ab667321` was independently reviewed by dispatch task `9ac8a721`; final verdict approve, no findings. All configured validation commands passed with full-suite evidence on the PR. The completion update changes this plan only; source remains the reviewed version.
