# Preserve local file links in transcripts

## Goal
Replace misleading `[blocked]` on agent-generated relative file links with readable local-file text and an explanation.

## Scope
Transcript Markdown destination handling and regression tests. Preserve URL sanitization, external-link confirmation, cockpit routes, and document-preview URL resolution. Non-goals: new file-serving endpoints or automatic filesystem navigation.

## Implementation plan
### Phase 1: Fix and prove
1.1 Reproduce the reported relative link through the real renderer; handle local destinations before the hardening plugin loses the URL.
1.2 Run the configured validation gate, browser QA, and review; publish the PR.

## Risks
Untrusted links must remain sanitized. Document previews share this renderer and must retain their custom resolution.

## Progress

PR: #1425

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix and prove

- [x] 1.1 Reproduce and fix local file link rendering — e387c90a
- [x] 1.2 Validate, review, and publish — implementation d2db7491; validation and review recorded on PR #1425

## Evidence
- Original NDJSON final reply contains a bare relative Markdown destination; `[blocked]` is added by rehype-harden before urlTransform.
- Six regression cases fail with original source; 50 targeted component/helper tests pass with fix.
- Full configured gate passes: typecheck; vitest (9648 passed, 5 skipped); Node tests (41 passed, 1 skipped); build/check:pack; package tests (17 passed).
- Local gate environment: TMPDIR=/tmp, inherited CEZ_API_URL and CEZ_BIN removed. Final vitest uses --maxWorkers=6 --retry=1 after one unrelated lazy diff-load timeout; the isolated diff test file passed 26/26 too.
- Real-browser regression passes through persisted NDJSON and SSE. Screenshot inspected and attached: https://github.com/open-mercato/cezar/pull/1425#issuecomment-6164979231
- Broad local E2E was stopped after 11 quick-list and 2 thread-header/rename failures outside the changed flow. Full UI suite is not green; needs-qa remains, with no QA approval claimed.
- Code review found no blocker or major in the fix; GitHub self-approval is unavailable for the author account, so independent review is still needed. CI passed on implementation head d2db7491.
- No route, state format, dependency or environment default changed.
