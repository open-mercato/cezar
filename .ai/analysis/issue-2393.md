# Issue #2393 — desktop Rustls advisories

Summary: the desktop `Cargo.lock` resolved Rustls 0.23.45, inside four open advisory ranges.

Root cause: the compatible `rustls = "0.23"` requirement was resolved before the 0.23.46 security release, and the desktop's reqwest and updater dependency graph kept that resolution. Dependabot alerts 69–72 report secret-bearing session `Debug` formatting, ECH rejection ordering, unauthenticated key-exchange prediction and optional Brotli allocation. Presence in the graph is confirmed; exploitability of every optional path in cezar is not asserted.

Files changed:
- `packages/desktop/src-tauri/Cargo.lock` — targeted `cargo update -p rustls --precise 0.23.46`, nothing else.
- `packages/desktop/test/rustls-security/` — an isolated test crate with its own committed `Cargo.lock`: real TLS 1.2/1.3 sessions, a session-`Debug` secret check, and authenticated data, resumption and certificate-rejection controls.
- `packages/desktop/scripts/test-rustls-security.mjs` — runs that crate against the exact Rustls version in the desktop lockfile, with `--locked`.

Approach: no manifest, feature, startup or TLS-policy change. Only the session-redaction tests fail on 0.23.45; the other three fixes are established by the patched version, not by separate exploit reproductions.
