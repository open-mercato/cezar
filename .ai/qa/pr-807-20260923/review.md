# PR #807 — upstream merge review

Scope: integrate upstream/main 9e726e71 into feat/cursor-support (previous head 955815c1), retaining Cursor support alongside upstream changes.

Resolved 18 conflicting files. Kept Claude and Cursor model discovery together in the contract, route, client hooks and fixtures; retained native-install Claude binary detection and changed Cursor's launcher override to the new deferred environment lookup; moved Cursor's env/backend documentation to docs/reference.md after the upstream README split. Stored runner normalization still derives from RUNNER_IDS and retains the legacy claude-cli fold.

Review finding fixed: quoteResumeBin previously passed shell operators in whitespace-free CEZ_CURSOR_AGENT_BIN values through verbatim. The helper now fails closed for unsafe executable paths. Ten new regression cases failed against the previous implementation and passed after the fix; the complete resume-command test file passes 26 tests.

The previous upstream CI failure was release-snapshot.test.ts inheriting GITHUB_RUN_ATTEMPT=2, unexpectedly appending .2 to the nightly version. Current upstream already isolates that value and tests rerun versions; no separate release-script change was needed.

Existing scope decisions retained: Cursor is one-shot, additional accounts remain unsupported, and API-key entry/storage through the UI remains outside this PR per the user's approved response. Presence of CURSOR_API_KEY is a credential-presence signal, not live validation of the key. Live vendor authentication remains unverified in this environment. The maintainer explicitly waived the existing runner timeout/nonzero-exit coverage gaps in the August 12 review; this merge does not change that runner code.

Validation and QA: pending completion. No approval or merge-readiness claim until results are recorded.
