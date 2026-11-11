# CodeQL22 verification

Security-Source: open-mercato/cezar:code-scanning:22
Security-Fingerprint: js/file-system-race:packages/cezar/src/data-gitignore.ts:ensureDataGitignore
PR: https://github.com/open-mercato/cezar/pull/2093
Main: 9cbdd8882b6be38936cb37e205d6fd26db2211fc
Implementation: 649d69885cdf070eee6c21cda7abf8ffe75fe8f6

## Confirmed defect and removal proof

The original existence-check/read/rewrite sequence could overwrite a concurrent creator, follow existing or dangling symlinks, and redirect a write after a read-time pathname replacement. Actual temporary files and deterministic hooks reproduce these cases. Exclusive creation now preserves a competing creator; an existing regular-file descriptor is validated against the directory entry, then used for both read and append. No path is reopened or truncated after inspection. Descriptors close on normal, no-change, identity-mismatch and failure exits.

The new 11-case security suite covers those defects, descriptor closure after metadata/read/write failures, fresh creation, idempotent returns, identity mismatch and directory degradation. Three symlink-specific cases skip on Windows; all 11 executed on Linux. Existing eight data-ignore tests retain additive entries, user additions and repeat-call behavior.

Original-source proof used `git stash push -- packages/cezar/src/data-gitignore.ts`, leaving the tests unchanged, followed by the targeted test and `git stash pop`. Result: **10 failed, 1 passed**, exit 1. The unchanged directory-degradation guard passes both versions. With the restored fix: **19 focused tests pass**. No assertions or baseline allowlists were weakened.

Exact focused commands, each prefixed with `timeout 120 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp`:

- `npm test -- packages/cezar/src/data-gitignore-security.test.ts` — original source: 10 failed / 1 passed.
- `npm test -- packages/cezar/src/data-gitignore.test.ts packages/cezar/src/data-gitignore-security.test.ts` — fixed source: 19 passed.

## Ordered validation

All five commands passed in the configured order. Exact wrapper: `timeout 600 env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp <command>`.

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS, all workspace/release checks |
| `npm test` | PASS, 951 files; 15,333 tests passed, 8 existing skips |
| `npm run test:unit` | PASS, 51 tests |
| `npm run build` | PASS, check:pack 1,496 files / 341 web assets |
| `npm run test:package` | PASS, 34 tests including installed offline CLI |

The supervisor-injected `CEZ_INSTANCE_ID` is removed only from validation subprocesses to isolate the existing health exact-key test. Temp paths use `/tmp` to avoid the real-home safety guard. No product configuration or test assertions change. `npm ci --no-audit --no-fund` installed the committed lockfile without manifest/lock changes.

Built-helper integration: `timeout 30 node /tmp/cezar-db8187b4-git-integration.mjs "$PWD"` passed. A fresh real Git repository confirms custom rules survive, run/attachment/custom-private files are ignored, team workflows stay committable, repeated calls are byte-identical and an existing symlink's target is untouched. All subprocesses have timeouts and the fixture is removed in `finally`. `git diff --check` passes. The source is identical in release/v0.19.x, so a backport is requested.

## Scan accounting and deduplication

Authenticated pagination returned 50 Dependabot and 11 CodeQL alerts on current main. Forty-two identities were already covered by existing PRs: 38 dependency identities in PR1253, CodeQL24 in PR2091, CodeQL26/27 in PR2007 and CodeQL29 in PR2008. Both read-only dependency verification and the first independent scan review checked actual PR-head files. PR1253 still contains vulnerable KaTeX0.16.47 despite its stale body claiming removal; alert38 remains uncovered.

This continuation selects **one** uncovered high CodeQL group (22). Accounting: handled 1 new remediation PR, skipped 42 duplicate-covered identities, deferred/blocked 18 (Dependabot38,41,52,56,68,69–75; CodeQL30,31,34,42,62,86). The critical zip group needs a major/parent compatibility investigation and unavailable Cargo validation. Remaining dependency parent/major constraints are recorded in the scan artifact; no no-patch or false-positive finding is asserted. The bounded run does not attempt every remaining independent group.

Latest prepublication open-PR pagination found only PR2093 for this source identity/branch. Other security/autofix roots had settled and no overlapping claim was visible. Exact atomic ownership/reset checks preceded source publication. All 61 alerts remain open on main; no merge, issue creation, advisory selection/publication, alert dismissal, settings/workflow change, release or auto-merge occurred.

## Claim compatibility and limits

The initial scan stopped because the repository tracker descriptor omitted atomic operations. After repeated explicit operator continuation, this run uses the verbatim installed om-setup-agent-pipeline GitHub get/acquire/release/reset operations as its per-run compatibility source. The repository tracker descriptor, agentic config, settings and workflows remain unchanged. Atomic lock `refs/om-locks/pr-2093` points to `ad75021fd4d56919593bc778c5e70d7ebccec347`, run db8187b4, claim comment6788108736. Assignment POST403 was followed by assignability GET404, confirming this bot is unassignable; verified in-progress remains the second ownership signal.

The fix protects the leaf directory entry. Attacker-controlled parent directories, hard links, same-inode writes/growth and transactional coordination between simultaneous appenders are outside this guarantee. Non-regular files and symlinks degrade quietly without maintenance. No local CodeQL analyzer ran; regression proof demonstrates mechanism removal, while GitHub closure requires landing/rescanning main. Existing skips remain skips. QA and native reviewer/remote CI decisions remain external gates.

## Independent review

Final reviewer task9eac6c64 is being resumed for this implementation; no third subtask is created. Its earlier approval covered only the initial scan disposition and is not an approval of this code. Final implementation verdict and evidence will be recorded before completion.
