Summary: Webhook outbox path replacement can separate the checked/read/repaired file identities (CodeQL81–83).

Root cause: Outbox.open in packages/cezar/src/webhooks/outbox.ts:25–52 uses stat(path), readFile(path), and open(path) independently. O_NOFOLLOW on the last open prevents a final symlink but cannot distinguish a replacement regular file. StatePath's precheck similarly cannot bind later async operations to one inode. No covering open issue/PR was found in the dedupe searches; the existing alerts remain open on main aad51073. The code-based race will be reproduced deterministically in regression tests.

Files to change:
- packages/cezar/src/webhooks/outbox.ts — read/stat a no-follow descriptor, keep it open until recovery ends, and compare a repair descriptor's identity before truncation.
- packages/cezar/src/webhooks/outbox.test.ts — deterministically replace the path after check or read; preserve original snapshot reads and reject replacement truncation. Preserve normal recovery and read-only loading guards.

Approach: Obtain size and bytes from the same read-only handle, retaining the original handle through the parse/repair lifetime. Repair opens a separate no-follow writable handle and verifies dev/ino against the retained snapshot before truncating. Keep exclusive missing-file creation, capacity enforcement, quarantine, cursor/sequence recovery and existing formats unchanged.

Risks: Descriptor cleanup must cover creation, invalid input, capacity failure and recovery errors. Read-only valid outboxes must remain loadable; read-write access is only required for actual repair. Platform behavior uses Node FileHandle/stat APIs supported on Windows and POSIX. No new configuration, startup behavior, public API, or architecture.
