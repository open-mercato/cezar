# Local tracker review cleanup — 2026-09-20

Scope: local corrections only; no commit, push, PR mutation or vendor mutation.

## Resolved runtime findings

- Connection metadata transport failures now show Retry rather than treating unknown status as missing credentials. Custom issue drafts and workflow/skills/engine selection survive recovery within the same scope. Changing the connection resets the draft and launch selection. Launch is unavailable while connection verification fails.
- Terminal watch results (`source_changed`, `credentials_missing`, `not_configured`) reconcile connection and workspace project queries as well as association metadata, allowing externally removed credentials to disappear from navigation.
- Linear continuation service errors propagate to the existing failure/backoff path without resetting the checkpoint or reporting a successful scan. A regression proves retry resumes the same cursor after a synthetic 503.

The original three regressions were reproduced before the fixes. An additional regression exposed workflow selection loss after draft preservation; it now passes through the actual Retry button and verifies reset on connection change.

## Historical specification feedback

The current local branch has one authoritative specification; the two older companion documents redirect to it. It declares the new workspace SSE event and the protected CLI/API/project-state/home-state surfaces, defines canonical root identity, documents local credential inventory/removal, omits global health readiness booleans, and includes Open Questions.

Managed dotenv remains an explicit design choice, not the reviewer's alternative of private JSON. The spec now states the tradeoff: requested interim env representation, managed-only rotation and an additional parser dependency; no security or simplicity advantage over JSON is claimed. The strict credential-record exception is declared. Prototype migration/fallback/tombstone machinery is not shipped. Encryption remains deferred.

This cleanup also corrects documentation of conservative SSE invalidation, matching-credential navigation visibility, transient connection failures and external credential deletion. A local future PR description avoids disposable fork branch links and describes implementation scope rather than the old docs-only scope. The existing remote PR has not been updated.

## Verification and limits

Pre-publication checks passed: 7,501 tests, unit36, package16, typecheck, build and synthetic browser checks. Current-base publication validation is tracked in the implementation plan and PR.

Synthetic browser acceptance verifies paused save, zero-run preview, one launch per event and duplicate suppression. It does not establish live Linear compatibility or real agent-to-PR-to-vendor-status completion. Explicit `invalid_cursor` scanner recovery has a synthetic contract test; production Linear cursor-expiration classification remains unverified. Generic service failures must not be reclassified as cursor expiration.
