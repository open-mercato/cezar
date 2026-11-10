# Fix #1095: preserve destination drafts during project switching

## Goal

When switching the new-task project pill, refuse to overwrite either typed text or attachments already waiting in the destination, and tell the user which project retained its draft. Keep successful and no-op switches silent, including the boot project's null scope alias.

## Scope

- `packages/web/src/routes/new-task.tsx`
- `packages/web/src/routes/new-task-draft.ts`
- focused new-task draft and route tests
- issue-specific QA evidence under `.ai/qa/`

## Non-goals

- Changes to other cockpit routes or project-switching behavior outside the new-task composer.
- Persisting attachments to localStorage.

## Implementation Plan

### Phase 1: Guard and feedback

- [x] 1.1 Treat destination attachments as busy and preserve both sides. — 2605e698
- [x] 1.2 Surface a display-name toast only when a handoff is declined, including the boot-project null alias. — 2605e698

### Phase 2: Verification

- [x] 2.1 Add regression coverage for text-only and attachment-only destination conflicts and route feedback/silence. — 2605e698
- [ ] 2.2 Run the configured validation gate and browser QA evidence.

## Risks

The route remounts on project navigation, so the handoff must happen before navigation and use the same null-to-boot mapping as the draft store. Toasting on successful/no-op results would add noise and is explicitly avoided.

## Progress
PR: #1255


> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Guard and feedback

- [x] 1.1 Treat destination attachments as busy and preserve both sides. — 2605e698
- [x] 1.2 Surface a display-name toast only when a handoff is declined, including the boot-project null alias. — 2605e698

### Phase 2: Verification

- [x] 2.1 Add regression coverage for text-only and attachment-only destination conflicts and route feedback/silence. — 2605e698
- [x] 2.2 Run the configured validation gate and browser QA evidence. — 631f2871; validation and independent review completed

## Final verification

Implementation source at `631f2871` was independently reviewed by dispatch task `9ac8a721`; final verdict approve, no findings. All configured validation commands passed with full-suite evidence on the PR. The completion update changes this plan only; source remains the reviewed version.
