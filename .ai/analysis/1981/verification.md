# Issue 1981 execution

Triage: existing open CodeQL81–83 on main aad51073 point at a real pathname check/use gap in Outbox.open. Dedupe searches found no issue or open PR; issue1981 records those pre-existing alerts. Claimed only this issue; no foreign assignee or claim changed.

— PREVIOUS STEP (om-root-cause) said —
Summary: Webhook outbox path replacement can separate the checked/read/repaired file identities (CodeQL81–83).

Root cause: Outbox.open in packages/cezar/src/webhooks/outbox.ts:25–52 uses stat(path), readFile(path), and open(path) independently. O_NOFOLLOW on the last open prevents a final symlink but cannot distinguish a replacement regular file. StatePath's precheck similarly cannot bind later async operations to one inode. No covering open issue/PR was found in the dedupe searches; the existing alerts remain open on main aad51073. The code-based race will be reproduced deterministically in regression tests.

Files to change:
- packages/cezar/src/webhooks/outbox.ts — read/stat a no-follow descriptor, keep it open until recovery ends, and compare a repair descriptor's identity before truncation.
- packages/cezar/src/webhooks/outbox.test.ts — deterministically replace the path after check or read; preserve original snapshot reads and reject replacement truncation. Preserve normal recovery and read-only loading guards.

Approach: Obtain size and bytes from the same read-only handle, retaining the original handle through the parse/repair lifetime. Repair opens a separate no-follow writable handle and verifies dev/ino against the retained snapshot before truncating. Keep exclusive missing-file creation, capacity enforcement, quarantine, cursor/sequence recovery and existing formats unchanged.

Risks: Descriptor cleanup must cover creation, invalid input, capacity failure and recovery errors. Read-only valid outboxes must remain loadable; read-write access is only required for actual repair. Platform behavior uses Node FileHandle/stat APIs supported on Windows and POSIX. No new configuration, startup behavior, public API, or architecture.

## Regression evidence

Before production changes: outbox.test.ts had 2 failures and 7 passes. The size/read replacement test observed both records from the replacement instead of the one original record; the torn-tail test resolved rather than rejecting after truncating a replacement. With the fix, those tests pass; an added guard proves valid outboxes need no write access. The final descriptor identity uses bigint dev/ino to avoid precision loss. Final outbox tests: 10 passed; whole webhook area: 551 passed.

## Environment diagnosis

The initial full-suite run failed 35 workflow/lifecycle tests because /tmp is a separate 16-GiB tmpfs with only ~330 MiB free. A concrete error reports “cannot start — only 313 MB free”; cezar correctly refused fixture-agent worktrees. The main filesystem has ~157 GiB free. No code/test assertion was changed. Validation is rerun with TMPDIR/TMP/TEMP pointing to a fresh owned cache directory outside any checkout, and inherited launcher CEZ_INSTANCE_ID unset.

## Implementation summary / om-open-pr input

— PREVIOUS STEP (om-fix) said —
The existing outbox is checked and read through one no-follow read-only descriptor, retained through repair. Recovery compares exact bigint device/inode identity before truncating a separately opened writable handle. Replacement regular files are rejected without changing their contents; valid read-only outboxes remain readable. Scope: outbox.ts and its regression tests. No public contract, startup, config, format, dependency or architecture changes. Tests: both new race regressions fail on original source, then pass with the fix; final outbox10 and webhook551 pass.

Triage clarification from the issue: CodeQL82 points to exclusive creation (already safe from overwrite), while81/83 identify exploitable check/read and check/repair gaps. Removing the pathname stat eliminates that shared check/use sequence; closure must be verified against PR analysis.

Review: checked descriptor cleanup on every exit, read-only behavior, exact identity comparison without number precision loss, exclusive missing-file creation, preserved quarantine/cursor/sequence/compaction behavior, unchanged state schema and contracts. No remaining scoped code findings. Backend-only real-filesystem integration tests exercise both races and normal recovery; no changed browser surface.

## Final configured gate

All commands executed in order against the final source, with inherited CEZ_INSTANCE_ID removed and TMPDIR/TMP/TEMP set to the owned cache directory on the main filesystem:

| Command | Result |
| --- | --- |
| npm run typecheck | PASS |
| npm test | PASS — 14,215 passed, 8 skipped |
| npm run test:unit | PASS — 50 tests |
| npm run build | PASS, including package-content verification |
| npm run test:package | PASS — 34 tests |

No product or test-source workaround was used for the full /tmp filesystem.
