# Execution plan: task worktree removal (#1600)

Source doc: .ai/specs/2026-10-30-issue-1600-task-worktree-removal.md (design PR #1854)

## Goal
Free one settled task checkout from its desktop/mobile detail menus, retaining branch, task and transcript via existing lifecycle reclaim.

## Risks
Reclaim force-removes ignored files; explain this and block dirty/unavailable status. Status preflight is not atomic against external writes. Existing lifecycle recovery owns cleanup failures. No backend/API changes. Local Windows baseline has missing POSIX tools and symlink/load failures; report configured gate failures accurately and require exact published-head CI.

## Progress
PR: #1857

### Phase 1: action and safety
- [x] 1.1 Eligibility, dedicated confirmation and reclaim mutation with tests.
- [x] 1.2 Desktop/mobile menus; regression red/green and targeted verification.

### Phase 2: verification and publication
- [x] 2.1 Five-command gate and code review/autofix; publish for exact-head CI follow-up.
- [x] 2.2 Private disposable-project browser QA and branch/transcript proof; publish ready PR and release lock.

Phase 1 commit: aa35ade1. Targeted 264/264; red two menu tests fail without source, green2/2 restored. Typecheck/build/package33 pass. Full Vitest timed out300s with Windows symlink failures; node:test core45 passed,2 failed,1 skipped (missing mkdir and /bin/sh).


Final verification: 266/266 targeted tests, web typecheck, and final dialog10/10 pass. Browser desktop/mobile320x568: confirm/cancel, dirty/missing/in-place refusal, legacy hook-free reclaim, durable recovery/Retry, and unchanged unpushed branch + record/transcript after directory removal. Fixed clipped small-phone controls during review. Exact final-head CI outcome is posted on PR #1857 after publication; local full gate is NOT green (baseline failures above). No real task worktree/branch removed. Private artifacts remain ignored. Engine: om-auto-create-pr (steps: 4, --loop: no).


## Parent review follow-up

Parent found and reproduced a cross-project navigation race in reclaim preflight and success cache updates. Three new scope tests failed on48a9855d (wrong-project POST, wrong-project cache write, confirmation carried into a cloned run ID), then passed after capturing the submitted project/run/cache keys and binding the dialog to its target. Targeted total269/269 and final full typecheck pass. Optional explicit scopes in existing web helpers preserve default calls; no public wire shape changes.

Parent source d6b23395 passes typecheck48s/build16s/package33/33(81s) and269 targeted tests69s. Local full Vitest reached300s Windows baseline bound; node:test45pass/2POSIX ENOENTfail/1skip. Local full gate remains red. Exact-source CI41131067443 is fully green after rerunning only the failed Mermaid shard; the unchanged Mermaid test also passes in isolation with original and restored feature production files, without source/test edits.

New real-browser scope QA passes: cancel retains the disposable checkout; confirmation closes when navigating to the same task ID in another project; delayed submit preflight then navigation sends reclaim only to the original boot/default scope. The actual native operation completed, removing only private project A's checkout while retaining its unpushed branch, record and transcript. Project B's checkout and metadata stay intact. Inline evidence: https://github.com/open-mercato/cezar/pull/1857#issuecomment-6534562428 . No real task worktree or branch was removed. Final tracking-only head receives its own CI check before lock release and parent acceptance.
