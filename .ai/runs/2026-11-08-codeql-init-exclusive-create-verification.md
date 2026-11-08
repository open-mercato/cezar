# PR 2009 verification

Source identity: github-code-scanning:open-mercato/cezar:25
Source fingerprint: js/file-system-race:packages/cezar/src/index.ts:initCommand:example-create
Main checked: a0e39453bce53fd800ece924e7898d269be69bbe

## Before/after proof

The original init loop was extracted unchanged for direct testing before the fix. `timeout 120 npm test -- packages/cezar/src/init.test.ts` failed the concurrent-file-preservation and dangling-symlink tests (2 failed, 2 passed). The original loop overwrote concurrent content and created a dangling symlink target. Replacing its check/write pair with an exclusive `wx` write and handling only EEXIST made all four tests pass. The installed-tarball CLI also now has first-init/repeated-init preservation coverage.

## Ordered validation

| Exact command | Result |
| --- | --- |
| `timeout 300 npm run typecheck` | PASS, repeated after final source/test edits |
| `timeout 300 npm test` | FAIL: 1 failed, 14,361 passed, 8 skipped; 894 files passed, 1 failed, 3 skipped |
| `timeout 300 npm run test:unit` | PASS: 50 tests |
| `timeout 300 npm run build` | PASS, including check:pack (1289 files) |
| `timeout 360 npm run test:package` | PASS on retry: 34 tests |
| `git diff --check` | PASS |

The full Vitest failure is `src/server/projects-api.test.ts:1010`, which rejects the existing `instanceId` health response field. With all this PR's code/test edits temporarily stashed, `timeout 120 npm test -- packages/cezar/src/server/projects-api.test.ts` reproduces the same failure (1 failed, 51 passed). The stash was restored. No fix to that unrelated API assertion is included. A red gate still prevents readiness.

The first package-suite attempt failed because the new fixture was inside another Git repository and lacked its own Git root. The fixture now runs `git init --initial-branch=main` before invoking init. Its retry passes; the two exact default examples generated outside the fixture by the first attempt were removed after content comparison. No user-authored file was removed.

## Scan disposition

Authenticated, paginated GitHub API reads returned 50 open Dependabot and 15 open CodeQL alerts. Default branch main verified. Full PR pagination and four security automation histories/claims were inspected by triage and independently reviewed. Prepublication recheck found only PR2009 for this fingerprint; main unchanged, atomic ownership reverified. No issue was created. No alert is marked fixed on main.

44 duplicate-covered alerts: 39 dependency alerts covered by existing open PR1253; CodeQL23→1999, 28→2004, 26/27→2007, 29→2008. These remain open exposures on main, not verified main fixes.

Selected: CodeQL25 (high), one remediation group. Remaining 20 alert identities deferred/blocked: Dependabot41 (glib major/Cargo unavailable), 52 (zod/e2e exact-pin compatibility), 56 (compression parent pin/docs integration), 68 (node-server runtime major), 69–72 (rustls/Cargo unavailable), 73–75 (zip major/Cargo unavailable); CodeQL22,24,30,31,32,34,42,62,86 not selected for this bounded run. All dependency records have patch versions; none is classified as no-patch.

## Limitations and review

The tracker descriptor gained only missing atomic ownership operations from the installed skill template after repeated operator continuation following disclosure of the prerequisite. No product settings or CI workflows changed. Existing tracker operations are preserved.

Independent reviewer e73b200f initially approved read-only triage only. That verdict does not approve this implementation. A fresh review of the implementation must complete before readiness; the existing reviewer may be continued without creating a third subtask. QA remains required. No local CodeQL analyzer was run; regression proof demonstrates the removed mechanism, not GitHub alert closure. Backport required for release/v0.18.x, where the vulnerable loop exists.
