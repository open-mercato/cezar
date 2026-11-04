# Fix Claude headless denial guidance (#1248)

## Goal

Make headless Claude tasks handle denied tools honestly and usefully when cezar has no interactive approval channel, while correcting the `CEZ_APPROVAL_GATE` documentation.

## Scope

- Append backend-local guidance at the Claude runner seam for both fresh and resumed sessions without replacing the caller's system prompt or changing permission arguments.
- Add regression coverage for prompt composition and resumed-argument parity.
- Correct `.env.example`, `docs/reference.md`, and `CODE_REVIEW.md` so the approval-gate behavior is accurate.

## Non-goals

- No permission UI or `control_request` plumbing.
- No changes to workflow continuation code, tool grants, or approval behavior.
- No filesystem workaround for protected paths.

## Implementation Plan

### Phase 1: Runner guidance

- [x] 1.1 Add and test Claude-local denial guidance appended to caller system prompts. — 88373959

### Phase 2: Documentation

- [x] 2.1 Correct approval-gate and headless workaround documentation. — 88373959

### Phase 3: Validation and review

- [ ] 3.1 Run the configured validation gate, create and finalize the issue PR, and record evidence.

## Risks

The appended guidance is visible to Claude as system context and must not alter caller instructions or permissions. Tests must pin both empty and supplied caller prompts.

## Progress
PR: #1256


> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Runner guidance

- [x] 1.1 Add and test Claude-local denial guidance appended to caller system prompts. — 24920498; validation and independent review completed

### Phase 2: Documentation

- [x] 2.1 Correct approval-gate and headless workaround documentation. — 24920498; validation and independent review completed

### Phase 3: Validation and review

- [x] 3.1 Run the configured validation gate, create and finalize the issue PR, and record evidence. — 24920498; validation and independent review completed

## Final verification

Implementation source at `24920498` was independently reviewed by dispatch task `9ac8a721`; final verdict approve, no findings. All configured validation commands passed with full-suite evidence on the PR. The completion update changes this plan only; source remains the reviewed version.
