— PREVIOUS STEP (om-root-cause) said —
Summary: Desktop Cargo.lock resolves Rustls 0.23.45, inside four open advisory ranges.

Root cause: The compatible rustls = "0.23" manifest was resolved before the 0.23.46 security release. The desktop's reqwest and updater dependency graph retains that resolution. Dependabot69–72 report secret-bearing session Debug formatting, ECH rejection ordering, unauthenticated key-exchange prediction and optional Brotli allocation. Graph presence is confirmed; cezar exploitability of every optional path is not asserted.

Files to change:
- packages/desktop/src-tauri/Cargo.lock — targeted Cargo update of Rustls only.
- packages/desktop/test/rustls-security/Cargo.toml and src/lib.rs — actual public-API TLS1.2/1.3 sessions, Debug secret-boundary regression and authenticated data/resumption controls.
- packages/desktop/scripts/test-rustls-security.mjs — isolated native harness resolving exactly the version in the desktop lockfile, with bounded execution and temporary-file cleanup.

Approach: Use cargo update -p rustls --precise0.23.46 without changing manifest constraints, features, startup or TLS policy. Exercise both vulnerable and fixed actual crates through the same test runner; only session-redaction assertions should fail on0.23.45. Record the four authoritative affected ranges and verify the fixed resolution lies outside each. No generic audit-fix or unrelated dependency update.

Risks: Native dependency compatibility requires real compilation, successful TLS1.2/1.3 traffic and resumption. These tests directly reproduce the session Debug disclosure only; the other three upstream patches are established by the compatible crate version, not independent exploit reproductions. Full GUI/native-platform validation is separate from an isolated Rustls harness. Preserve app configuration/architecture and the npm gate; keep draft when native verification is incomplete.
