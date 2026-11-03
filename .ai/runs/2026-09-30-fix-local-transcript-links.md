# Fix local transcript link navigation

Goal: prevent transcript links that identify host filesystem paths from implying that a remote cockpit can open them, while preserving confirmation for HTTPS and supported cockpit-relative links.

Scope: `packages/web/src/routes/task-thread/markdown.tsx` and its regression tests.

Non-goals: serving arbitrary host files, adding an artifact endpoint, or changing task-thread/run-header consumers.

## Implementation Plan

### Phase 1: Policy and regression coverage

- [x] 1.1 Add a transcript destination classifier and local-only renderer — targeted tests pass — b1b4b908
- [x] 1.2 Preserve safety confirmation for HTTPS and cockpit-relative links — targeted tests pass — b1b4b908
- [x] 1.3 Run the full repository validation gate and authoritative PR review — CI green and independent review approved; two task-context baseline failures documented

## Risks

- The repository’s generated API client types may require the server build before typecheck; unrelated baseline errors must be reported if they persist.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

### Phase 1: Policy and regression coverage

- [x] 1.1 Add a transcript destination classifier and local-only renderer — targeted tests pass — b1b4b908
- [x] 1.2 Preserve safety confirmation for HTTPS and cockpit-relative links — targeted tests pass — b1b4b908
- [x] 1.3 Run the full repository validation gate and authoritative PR review — CI green and independent review approved; two task-context baseline failures documented

## Verification record

- Focused markdown suite: 34 passed (including filesystem, HTTPS/cockpit, image and hostile-URL cases).
- `TMPDIR=/tmp/cezar-1175-... npm run typecheck`: passed.
- `TMPDIR=/tmp/cezar-1175-... npm test`: 8,419 passed, 2 baseline/environment failures in `src/workflows/agent-profile-wiring.test.ts` and `src/workflows/system-prompt.test.ts`; no changed-file failures. The latter also reports the generated temp project lacks `.ai/cezar/runs.json`.
- `npm run test:unit`: 36 passed; `npm run build`: passed (`check:pack` 687 files); `npm run test:package`: 17 passed.
- Browser QA and independent review remain before this PR can leave `in-progress`/draft. Browser provider is currently blocked by missing host `libnspr4.so` and unavailable passwordless sudo.
