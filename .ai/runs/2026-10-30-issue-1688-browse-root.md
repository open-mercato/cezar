# Explain the browse-root boundary (#1688)

## Goal and scope

Show the configured folder-browser root boundary and a direct link to the existing Default browse folder setting. Only `folder-browser.tsx`, its issue-specific tests, and this plan change. Server containment, Up navigation, registration, and unrelated issues remain unchanged.

Source doc: .ai/specs/2026-10-30-issue-1688-browse-root.md (design-only PR #1831, https://github.com/open-mercato/cezar/pull/1831)

## Implementation Plan

### Phase 1: Guidance and regression coverage

1.1 Add successful-root guidance and a Settings link to the shared picker.
1.2 Cover root/absolute return, nested Up and selection, loading/error and empty/long path behavior. Prove regression tests fail on the original component.

### Phase 2: Validation and evidence

2.1 Run the full configured validation gate and independent code review; resolve actionable findings.
2.2 Verify the real UI and Settings destination in a browser; publish evidence and leave human QA required.

## Risks

Full native-Windows validation is blocked outside this UI scope: npm test exceeded 600 seconds with server symlink/process failures; test:unit requires /bin/sh (ENOENT). typecheck and build/check:pack pass; package retry with600s bound passed33/33 in44.2s after earlier network/short-timeout failures. Targeted folder-browser + AddProjectDialog tests pass 23/23. Browser provider installed; QA environment isolated under .ai/qa/issue-1688.

Independent source review: approve, no findings; independent targeted23/23PASS. Full-gate CI run41102240826 passed at3d1ee86209dc4e85d1cd0fa79239f7280acb08d1; native Windows failures reproduced on parent baseline, not softened or called passes. Later completion commits change only this plan.

## Progress

PR: #1832
Browser evidence: https://github.com/open-mercato/cezar/pull/1832#issuecomment-6529636305

Source implementation: 5669ca14. Browser QA: seven scenarios passed; pending/403 browser coverage is partial (covered in component tests). Source under QA is identical to the current code; later progress commits affect only this plan.

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Guidance and regression coverage

- [x] 1.1 Add successful-root guidance and a Settings link to the shared picker.
- [x] 1.2 Cover root/absolute return, nested Up and selection, loading/error and empty/long path behavior.

### Phase 2: Validation and evidence

- [x] 2.1 Run the full configured validation gate and independent code review; resolve actionable findings.
- [x] 2.2 Verify the real UI and Settings destination in a browser; publish evidence and leave human QA required.
