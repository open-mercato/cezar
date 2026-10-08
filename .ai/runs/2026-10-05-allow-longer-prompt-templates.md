# Allow longer prompt templates

## Goal

Allow reusable prompt templates to hold long skills such as unslop while retaining a bounded,
consistent limit across the API and cockpit.

## Scope

- Raise the prompt-template text limit from 2,000 to 20,000 characters in the contract-facing
  server validator and browser editor/normalizer.
- Add regression coverage for a valid long template and an oversized template rejection.
- Document the selected 20,000-character bound at the shared validation points.

## Non-goals

- Change generic run prompt limits, provider authentication, or prompt-template list/label limits.
- Add configuration for this bound.

## Implementation Plan

### Phase 1: Trace and define the bound

- [x] 1.1 Align the contract, server validator, and browser normalization/editor at 20,000 characters. — 1b89e450
- [x] 1.2 Add server and browser regression tests for accepted long input and oversized rejection. — 1b89e450

### Phase 2: Verify and publish

- [x] 2.1 Run targeted tests, the full validation gate, and review the final diff. — 9412669f

Verification note: targeted server/browser tests pass (60 tests) and the Prompt templates settings
suite passes (16 tests). With this worktree's dependencies installed, `npm run typecheck` and
`npm run build` pass; `npm run test:unit` passes (36 tests). The local full Vitest run reproduces
unrelated environment-sensitive failures and was stopped after evidence collection; GitHub CI
passed the complete Unit/build/E2E/package gate, CodeQL, npm snapshot, and CLA checks. An
independent review is still required before this PR can be marked ready. Browser QA was not
exercised: the configured agent-browser Chrome could not launch because `libnspr4.so` is missing,
and passwordless sudo is unavailable to install system dependencies. The `needs-qa` label is
intentionally preserved.

## Risks

The prompt-template value is persisted in ui-state.json, so increasing the bounded field size
increases the maximum preference payload but remains capped and affects no existing valid data.

## Progress

PR: #1273

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Trace and define the bound

- [x] 1.1 Align the contract, server validator, and browser normalization/editor at 20,000 characters. — 1b89e450
- [x] 1.2 Add server and browser regression tests for accepted long input and oversized rejection. — 1b89e450

### Phase 2: Verify and publish

- [x] 2.1 Run targeted tests, the full validation gate, and review the final diff. — 9412669f

Status: complete for code review at exact head `9412669f`; isolated dependency install plus contract build yielded 60/60 targeted tests and remote CI/CodeQL/package checks pass. Browser QA remains required and blocked by the documented `libnspr4.so`/sudo limitation.
